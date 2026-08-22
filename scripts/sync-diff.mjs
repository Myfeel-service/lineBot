#!/usr/bin/env node
/**
 * STATUS.md ⇄ Notion 開發表 比對腳本（唯讀，不寫任何東西）
 *
 * 用法：
 *   node scripts/sync-diff.mjs notion.json          # 先把 Notion 匯出成 JSON（見下）
 *   node scripts/sync-diff.mjs --md-only            # 只解析 md，印出所有編號與狀態
 *
 * notion.json 的取得：請 Claude 用 notion-query-data-sources 撈
 *   SELECT "編號","需求項目","狀態" FROM "collection://..." 
 * 把 results 陣列存成檔案即可。欄位名就用中文。
 *
 * 輸出三張清單：
 *   ① 狀態不符（編號兩邊都有，但狀態對不上）
 *   ② Notion 缺卡（md 活項有編號、Notion 沒有）
 *   ③ Notion 多卡（Notion 有編號、md 查無 ── 或編號為空的孤兒卡）
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MD_PATH = resolve(ROOT, 'docs/STATUS.md');

// md 狀態 → Notion 狀態（唯一合法對照，來源：通用流程頁 2026-08-15 版）
const STATUS_MAP = {
  'TODO': '尚未開始',
  'DOING': '進行中',
  'DONE': '已完成',
  'DEPLOY?': '推上正式站中',
  'BLOCKED': '等外部回覆',
  'DECIDE': '尚未開始', // ＋需求類型=內部決策（類型不在本腳本比對範圍）
};
// F 區（已知限制）沒有狀態欄，一律視為「持續追蹤」
const F_STATUS = '持續追蹤';

/** 解析 STATUS.md：抓所有表格列裡帶 `X-N` 編號的項目 */
function parseMd() {
  const text = readFileSync(MD_PATH, 'utf8');
  const lines = text.split('\n');
  const items = new Map(); // 編號 → { status, title, line, done }
  let inDoneSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s*✅/.test(line)) inDoneSection = true;
    // 完成區的表格列：| 日期 | `B-26` 標題… | commit |（編號在說明欄，格式不一，
    // 用第一個反引號編號抓）
    const m = line.match(/^\|\s*`([A-Z]-\d+)`\s*\|/);
    if (m) {
      const id = m[1];
      const cells = line.split('|').map(s => s.trim());
      // 待辦區格式：| 編號 | 項目 | 狀態 | 說明 |；D 區與 E/F 區沒有狀態欄
      const title = (cells[2] || '').replace(/[*~`]/g, '').slice(0, 40);
      let status = null;
      const statusCell = (cells[3] || '').replace(/[*`]/g, '');
      if (STATUS_MAP[statusCell] !== undefined) status = statusCell;
      // 沒有狀態欄的區塊：D 區＝DECIDE、E 區＝TODO、F 區＝特例。
      // 標題被 ~~ 劃掉且「沒有明確狀態欄」才視為 DONE——
      // 有狀態欄一律以欄位為準（A-10 標題劃掉但狀態是 DEPLOY?＝修完待驗，不能當結案）。
      if (!status) {
        if (/~~/.test(cells[2] || '')) status = 'DONE';
        else if (id.startsWith('D-')) status = 'DECIDE';
        else if (id.startsWith('F-')) status = 'F';
        else status = 'TODO';
      }
      if (!items.has(id)) items.set(id, { status, title, line: i + 1 });
    }
  }
  return items;
}

function expectedNotionStatus(mdStatus) {
  if (mdStatus === 'F') return F_STATUS;
  return STATUS_MAP[mdStatus] ?? null;
}

// ---- main ----
const arg = process.argv[2];
const md = parseMd();

if (arg === '--md-only' || !arg) {
  console.log(`STATUS.md 解析出 ${md.size} 個編號：\n`);
  for (const [id, v] of [...md].sort()) {
    console.log(`  ${id.padEnd(6)} ${String(v.status).padEnd(8)} L${v.line}  ${v.title}`);
  }
  if (!arg) console.log('\n（要比對 Notion，傳入匯出的 notion.json）');
  process.exit(0);
}

const notionRaw = JSON.parse(readFileSync(resolve(arg), 'utf8'));
const notionArr = Array.isArray(notionRaw) ? notionRaw : notionRaw.results;
const notion = new Map();
const orphans = [];
for (const row of notionArr) {
  const id = row['編號'];
  if (!id) { orphans.push(row); continue; }
  notion.set(id, { status: row['狀態'], title: (row['需求項目'] || '').slice(0, 40) });
}

const mismatch = [], missingInNotion = [], extraInNotion = [];

for (const [id, m] of md) {
  const n = notion.get(id);
  const want = expectedNotionStatus(m.status);
  if (!n) {
    // 已完成的活項刻意不建卡，不算缺
    if (m.status !== 'DONE') missingInNotion.push({ id, ...m, want });
    continue;
  }
  // 駁回卡不比狀態（那是看板端的整理動作）
  if (n.status === '駁回') continue;
  if (n.status !== want) mismatch.push({ id, mdStatus: m.status, want, got: n.status, title: m.title });
}
for (const [id, n] of notion) {
  if (!md.has(id) && n.status !== '駁回') extraInNotion.push({ id, ...n });
}

const p = (s) => console.log(s);
p(`\n═══ ① 狀態不符（${mismatch.length}）═══`);
for (const x of mismatch) p(`  ${x.id.padEnd(6)} md=${x.mdStatus} 應為「${x.want}」，Notion=「${x.got}」  ${x.title}`);
p(`\n═══ ② Notion 缺卡（${missingInNotion.length}，只列活項）═══`);
for (const x of missingInNotion) p(`  ${x.id.padEnd(6)} ${String(x.status).padEnd(8)} 應建為「${x.want}」  ${x.title}`);
p(`\n═══ ③ Notion 多卡／孤兒卡（${extraInNotion.length + orphans.length}）═══`);
for (const x of extraInNotion) p(`  ${x.id.padEnd(6)} 「${x.status}」 md 查無此編號  ${x.title}`);
for (const x of orphans) p(`  （無編號）「${x['狀態']}」 ${(x['需求項目'] || '').slice(0, 40)}  ← 孤兒卡，要問開卡的人`);
p('');
if (mismatch.length + missingInNotion.length + extraInNotion.length + orphans.length === 0) {
  p('✅ 兩邊一致。');
}
