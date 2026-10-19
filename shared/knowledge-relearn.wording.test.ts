/**
 * 回歸鎖（`D-129`，2026-10-19 老闆「按你建議」）：給店家看的字不再出現「重新學習」。
 *
 * 為什麼要鎖：以前加一條失敗、匯入完、搬組失敗、體檢兩項、條目上的按鈕、「⋯ → 重新學習這一份」六個地方都叫他去按「重新學習」，
 * 而系統本來就每 10 分鐘自己再試——那個詞讓他以為是要自己處理的事（全平台店家按過 0 次）。
 * 現在講法收在 shared/knowledge-relearn；這一關掃畫面、伺服器、shared 的原始碼（註解不算），出現就紅。
 *
 * 唯一例外：只有平台超管看得到的「重新學習全部知識（維護用）」那一組（`C-323`），跟超管專用頁。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

/** 拿掉註解（HTML、區塊、行尾）。⚠️ 粗略：字串裡的「//」後面會被一起砍掉——只會少抓、不會誤報 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** 平台超管專用的那一組：按鈕、確認視窗、結果提示（`C-323` 起店家看不到） */
const SUPER_ADMIN_ONLY: Array<{ file: RegExp, line: RegExp }> = [
  { file: /^app\/pages\/admin\/\[workspaceId\]\/knowledge\/sources\/index\.vue$/, line: /重新學習全部|全部重新學習|重新學習中⋯|所有知識重新學習一次|重新學習完成|重新學習沒有完成/ },
  { file: /^app\/pages\/admin\/super\//, line: /./ },
]

describe('給店家看的字不出現「重新學習」（`D-129`）', () => {
  it('畫面、伺服器、shared：除了超管專用那一組，一處都沒有', () => {
    const hits: string[] = []
    for (const abs of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'server')), ...walk(join(ROOT, 'shared'))]) {
      const rel = relative(ROOT, abs).split('\\').join('/')
      const lines = stripComments(readFileSync(abs, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (!line.includes('重新學習')) return
        if (SUPER_ADMIN_ONLY.some(a => a.file.test(rel) && a.line.test(line))) return
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('這張網撈得到東西：超管那一組確實在（不然上面那關是空轉的綠）', () => {
    const src = stripComments(readFileSync(join(ROOT, 'app/pages/admin/[workspaceId]/knowledge/sources/index.vue'), 'utf8'))
    expect(src).toContain('重新學習全部知識（維護用）')
    // 註解剝得掉、字串剝不掉
    expect(stripComments('a // 重新學習\n<!-- 重新學習 -->b')).not.toContain('重新學習')
    expect(stripComments('const t = \'重新學習\'')).toContain('重新學習')
  })
})
