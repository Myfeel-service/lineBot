/**
 * 舊資料搬家：資料夾當「商品」分組（`C-320`，2026-10-15 老闆拍板 `D-126`①）。
 *
 * 做什麼（一次一個帳號）：
 *   1. 名字像「客服」「總覽」這種不是講單一商品的資料夾 → 建議改成「通用」
 *   2. 商品分組裡產品名是空的那份，同組其他資料只有**一種**產品名 → 補上（並列出會重新學習幾條）
 *   3. 同組有 0 種或 2 種以上產品名的空白那份 → 列出來，⛔ 不動（「MATELASER」裡是 W1 REGEN 與 W1 REGEN ULTRA 兩款）
 *   4. 名字看起來是同一個商品的兩個資料夾（「零水鍋」與「SHARP 自動調理零水鍋」）→ 只列建議
 *   5. 通用分組裡卻有產品名的那份（「總覽」那份＝「MYFEEL全品項總覽」）→ 列成問題，⛔ 不動
 * 判斷規則跟伺服器搬資料夾時是同一份（shared/knowledge-product-group.ts），⛔ 不在這裡另寫一套。
 * ⛔ 紅線：不拿資料夾名當產品名、不覆蓋填好的、拿不準不補。
 *
 * 用法（預設只讀不寫＝dry-run）：
 *   node --env-file=.env_myfeel scripts/migrate-kb-product-groups.mjs <workspaceId>
 *
 * 實際寫入（老闆看過 dry-run 點頭之後才跑；重新學習要打 Gemini，所以要多讀一份有 GEMINI_API_KEY 的 .env）：
 *   node --env-file=.env --env-file=.env_myfeel scripts/migrate-kb-product-groups.mjs <workspaceId> --apply
 *     → 只做「改成通用」＋「沒有懸念的補產品名」（每補一份當場重新學習那一份，同「儲存並重新學習」）
 *   另外兩種預設關著，要明講才做（也要搭 --apply；沒搭只會列出會做什麼）：
 *     --merge=<從哪個資料夾id>:<併到哪個資料夾id>   把前者底下的資料搬進後者、刪掉變空的前者（可以寫好幾個）
 *     --clear-product=<資料id>                    清掉那一份的產品名並重新學習（可以寫好幾個）
 *
 * ⚠️ firebase-admin 會繞過所有安全規則。dry-run 只讀：knowledgeFolders、knowledgeSources、knowledgeChunks（只取 sourceId／status）、
 *    knowledgeProductIndex（別名）。--apply 會寫：knowledgeFolders（general）、knowledgeSources（productName、folderId）、
 *    knowledgeChunks（重新學習的向量）、knowledgeProductIndex（產品名清單）、auditLogs、aiUsage（embedding 用量）。
 * ⚠️ 多租戶：splash 目前不管（2026-08-22 拍板），這支只照傳進來的那一個 workspaceId 做。
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createJiti } from 'jiti'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// shared／server 的 TS 用 jiti 讀（`~~` 別名照 Nuxt：專案根）；node 內建的 strip-types 吃不了沒有副檔名的 import
const jiti = createJiti(import.meta.url, { alias: { '~~': ROOT, '~': join(ROOT, 'app') } })

const args = process.argv.slice(2)
const workspaceId = args.find(a => !a.startsWith('--'))
const apply = args.includes('--apply')
const merges = args.filter(a => a.startsWith('--merge=')).map((a) => {
  const [from, into] = a.slice('--merge='.length).split(':')
  return { from: String(from ?? '').trim(), into: String(into ?? '').trim() }
})
const clears = args.filter(a => a.startsWith('--clear-product=')).map(a => a.slice('--clear-product='.length).trim()).filter(Boolean)
// 指定一份的產品名（拿不準、要人選的那幾份；老闆選好之後用）：--set-product=<資料id>:<產品名>（產品名裡可以有冒號，只切第一個）
const sets = args.filter(a => a.startsWith('--set-product=')).map((a) => {
  const v = a.slice('--set-product='.length)
  const i = v.indexOf(':')
  return { id: (i > 0 ? v.slice(0, i) : '').trim(), name: (i > 0 ? v.slice(i + 1) : '').trim() }
})
if (sets.some(s => !s.id || !s.name)) {
  console.error('--set-product 要寫成 --set-product=<資料id>:<產品名>')
  process.exit(1)
}

if (!workspaceId) {
  console.error('用法：node --env-file=.env_myfeel scripts/migrate-kb-product-groups.mjs <workspaceId> [--apply] [--merge=從:到] [--clear-product=資料id]')
  process.exit(1)
}
if (merges.some(m => !m.from || !m.into || m.from === m.into)) {
  console.error('--merge 要寫成 --merge=<從哪個資料夾id>:<併到哪個資料夾id>，兩個不能一樣')
  process.exit(1)
}

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey } = process.env
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID、FIREBASE_CLIENT_EMAIL、FIREBASE_PRIVATE_KEY（用 --env-file=.env_myfeel）')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()

const {
  decideGroupProductName,
  distinctGroupProductNames,
  findLikelyDuplicateGroups,
  looksLikeGeneralGroupName,
} = await jiti.import(join(ROOT, 'shared/knowledge-product-group.ts'))
const { canonicalProductName } = await jiti.import(join(ROOT, 'server/utils/ai-product-alias.ts'))

const TYPE_LABEL = { file: '檔案', url: '網址', manual: '手打', gsheet: '試算表' }
const q = s => `「${s}」`

async function readState() {
  const [folderSnap, sourceSnap, chunkSnap, aliasSnap] = await Promise.all([
    db.collection('knowledgeFolders').where('workspaceId', '==', workspaceId).get(),
    db.collection('knowledgeSources').where('workspaceId', '==', workspaceId)
      .select('name', 'type', 'folderId', 'productName', 'generateOverview').get(),
    // 只拿算條數要用的兩格（⛔ 不要整份拉回來：每一條都帶 768 維向量）
    db.collection('knowledgeChunks').where('workspaceId', '==', workspaceId).select('sourceId', 'status').get(),
    db.collection('knowledgeProductIndex').doc(workspaceId).get(),
  ])
  const folders = folderSnap.docs
    .map(d => ({ id: d.id, name: String(d.get('name') ?? ''), order: Number(d.get('order') ?? 0), general: d.get('general') === true }))
    .sort((a, b) => a.order - b.order)
  const sources = sourceSnap.docs.map(d => ({
    id: d.id,
    name: String(d.get('name') ?? ''),
    type: String(d.get('type') ?? 'file'),
    folderId: d.get('folderId') ?? null,
    productName: String(d.get('productName') ?? '').trim(),
    isCatalog: d.get('generateOverview') === true,
  }))
  // 重新學習會跳過停用的（同 relearnSourceChunks／reindex）——條數照那個口徑算
  const relearnCount = new Map()
  for (const c of chunkSnap.docs) {
    if (c.get('status') === 'disabled') continue
    const sid = String(c.get('sourceId') ?? '')
    if (sid) relearnCount.set(sid, (relearnCount.get(sid) ?? 0) + 1)
  }
  const aliases = aliasSnap.get('aliases') && typeof aliasSnap.get('aliases') === 'object' ? aliasSnap.get('aliases') : {}
  return { folders, sources, relearnCount, aliases }
}

function buildPlan({ folders, sources, relearnCount, aliases }) {
  const canonical = n => canonicalProductName(n, aliases)
  const folderById = new Map(folders.map(f => [f.id, f]))
  const plan = { markGeneral: [], fills: [], ambiguous: [], questions: [], perFolder: [], unfiled: [], duplicates: [] }

  for (const f of folders) {
    const willBeGeneral = f.general || looksLikeGeneralGroupName(f.name)
    if (!f.general && willBeGeneral) plan.markGeneral.push(f)
    const members = sources.filter(s => s.folderId === f.id)
    const entry = { folder: f, willBeGeneral, members, names: distinctGroupProductNames(members.map(s => s.productName), canonical), rows: [] }
    for (const s of members) {
      const chunks = relearnCount.get(s.id) ?? 0
      if (willBeGeneral) {
        if (s.productName) {
          const row = { kind: 'question', source: s, chunks, folder: f }
          entry.rows.push(row)
          plan.questions.push(row)
        }
        continue
      }
      const d = decideGroupProductName({
        productName: s.productName,
        isCatalog: s.isCatalog,
        // 試算表常是多商品價目表，補了整張表會被標成那一台（同伺服器那一支，/code-review 第 1 條）
        isSheet: s.type === 'gsheet',
        group: { general: false },
        siblingProductNames: members.filter(o => o.id !== s.id).map(o => o.productName),
        canonical,
      })
      if (d.action === 'fill') {
        const row = { kind: 'fill', source: s, chunks, folder: f, productName: d.productName }
        entry.rows.push(row)
        plan.fills.push(row)
      }
      else if (d.action === 'ask') {
        const row = { kind: 'ambiguous', source: s, chunks, folder: f, reason: d.reason, names: d.names }
        entry.rows.push(row)
        plan.ambiguous.push(row)
      }
      else if (d.reason === 'catalog') {
        entry.rows.push({ kind: 'catalog', source: s, chunks, folder: f })
      }
    }
    plan.perFolder.push(entry)
  }

  // 掛在找不到的資料夾底下的也算未分類（側欄畫不出來，G-98）
  plan.unfiled = sources.filter(s => !s.folderId || !folderById.has(s.folderId))
  plan.duplicates = findLikelyDuplicateGroups(plan.perFolder.map(e => ({
    id: e.folder.id,
    name: e.folder.name,
    general: e.willBeGeneral,
    productNames: e.members.map(s => s.productName),
  }))).map(d => ({ ...d, a: folderById.get(d.a), b: folderById.get(d.b) }))
  return plan
}

function printPlan(state, plan) {
  const { folders, sources, relearnCount } = state
  console.log(`[migrate-kb-product-groups] project=${projectId} workspace=${workspaceId} mode=${apply ? 'APPLY' : 'DRY-RUN（只讀，什麼都不會寫）'}`)
  console.log(`資料夾 ${folders.length} 個、資料 ${sources.length} 份\n`)

  for (const e of plan.perFolder) {
    const f = e.folder
    const tag = f.general ? '通用（已經是）' : e.willBeGeneral ? '→ 建議改成「通用」（名字像不是講單一商品）' : '商品分組'
    const namesLine = e.willBeGeneral ? '' : `；同組產品名：${e.names.length ? e.names.map(q).join('、') : '（都沒填）'}`
    console.log(`■ ${q(f.name)} ${tag}（${e.members.length} 份${namesLine}）  id=${f.id}`)
    for (const r of e.rows) {
      const label = `${q(r.source.name)}（${TYPE_LABEL[r.source.type] ?? r.source.type}）`
      if (r.kind === 'fill') console.log(`   + 補產品名：${label} → ${q(r.productName)}，${r.chunks} 條會重新學習  id=${r.source.id}`)
      else if (r.kind === 'ambiguous') {
        console.log(`   ? 不補：${label} 產品名是空的，${r.reason === 'ambiguous' ? `同組有 ${r.names.length} 種（${r.names.map(q).join('、')}）——要人選` : '同組沒有人填過——要人填'}  id=${r.source.id}`)
      }
      else if (r.kind === 'question') {
        console.log(`   ? 要問：${label} 在通用分組裡卻有產品名 ${q(r.source.productName)}——要清掉嗎？清了 ${r.chunks} 條要重新學習（要清加 --clear-product=${r.source.id}）`)
      }
      else if (r.kind === 'catalog') console.log(`   · 不補：${label} 是型錄（旗下本來就很多商品）`)
    }
  }

  if (plan.unfiled.length) {
    const empty = plan.unfiled.filter(s => !s.productName).length
    console.log(`\n■ 未分類 ${plan.unfiled.length} 份（不在任何分組，不補；其中產品名空的 ${empty} 份）`)
  }

  console.log('\n可能是同一個商品、分成兩個資料夾的（只是建議，⛔ 不會自動合併）：')
  if (!plan.duplicates.length) console.log('   （沒有）')
  for (const d of plan.duplicates) {
    const why = d.why === 'name' ? '名字一個包含另一個' : '兩組裡有同一個產品名'
    console.log(`   ${q(d.a.name)} ↔ ${q(d.b.name)}（${why}）  要合併加 --merge=${d.a.id}:${d.b.id}（把前者併進後者）`)
  }

  const fillChunks = plan.fills.reduce((n, r) => n + r.chunks, 0)
  console.log('\n總計：')
  console.log(`   改成通用 ${plan.markGeneral.length} 個：${plan.markGeneral.map(f => q(f.name)).join('、') || '（沒有）'}`)
  console.log(`   補產品名 ${plan.fills.length} 份（${fillChunks} 條要重新學習）`)
  console.log(`   產品名空的、拿不準不補 ${plan.ambiguous.length} 份`)
  console.log(`   通用分組裡有產品名、要問 ${plan.questions.length} 份`)
  console.log(`   可能重複的資料夾 ${plan.duplicates.length} 組`)
  if (merges.length || clears.length || sets.length) {
    console.log(`   另外指定：合併 ${merges.length} 組、清產品名 ${clears.length} 份${clears.length ? `（${clears.map(id => `${q(sources.find(s => s.id === id)?.name ?? id)} ${relearnCount.get(id) ?? 0} 條要重新學習`).join('、')}）` : ''}`)
    for (const m of merges) {
      const from = state.folders.find(f => f.id === m.from)
      const into = state.folders.find(f => f.id === m.into)
      console.log(`     · 合併 ${q(from?.name ?? m.from)} → ${q(into?.name ?? m.into)}（搬 ${sources.filter(s => s.folderId === m.from).length} 份；合完整組重新判斷要不要補產品名）`)
    }
    for (const s of sets) {
      const src = sources.find(x => x.id === s.id)
      console.log(`     · 指定產品名：${q(src?.name ?? s.id)}（現在 ${q(src?.productName || '（空）')}）→ ${q(s.name)}，${relearnCount.get(s.id) ?? 0} 條要重新學習`)
    }
  }
}

async function runApply(state, plan) {
  if (!process.env.GEMINI_API_KEY) {
    // ⛔ 沒有 key 照跑的話，重新學習每一條都會失敗、被標成「沒學起來」——寧可整個不做
    console.error('\n--apply 要重新學習（打 Gemini），但讀不到 GEMINI_API_KEY。請多加一份 --env-file=.env 再跑：')
    console.error(`  node --env-file=.env --env-file=.env_myfeel scripts/migrate-kb-product-groups.mjs ${workspaceId} --apply`)
    process.exit(1)
  }
  // 伺服器那幾支在 Nitro 裡跑，靠自動注入的這兩個；這裡補上同名的最小替身，其餘照原程式走
  globalThis.useRuntimeConfig = () => ({ geminiApiKey: process.env.GEMINI_API_KEY })
  globalThis.createError = opts => Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)
  const { updateFolder, deleteFolderCascade } = await jiti.import(join(ROOT, 'server/utils/ai-knowledge-folders.ts'))
  const { fillProductNameFromGroup, relearnSourceChunks } = await jiti.import(join(ROOT, 'server/utils/ai-knowledge-product-group.ts'))
  const { updateSourceSettings } = await jiti.import(join(ROOT, 'server/utils/ai-knowledge-sources.ts'))
  const { writeAuditLog } = await jiti.import(join(ROOT, 'server/utils/audit-log.ts'))
  const audit = (action, targetId, note) =>
    writeAuditLog({ workspaceId, uid: '', actor: 'system', action, targetId, note }, db)

  console.log('\n── 開始寫入 ──')
  // 1. 改成通用（先做：後面判斷補不補要照新的分組）
  for (const f of plan.markGeneral) {
    await updateFolder(db, workspaceId, f.id, { general: true })
    await audit('knowledgeFolder.put', f.id, `「${f.name}」改成通用（不是講單一商品）——商品分組搬家（C-320）`)
    console.log(`   ✓ ${q(f.name)} 改成通用`)
  }

  // 2. 合併（有指定才做）：搬過去的每一份照新的分組判斷要不要補產品名
  const movedIds = []
  for (const m of merges) {
    const from = state.folders.find(f => f.id === m.from)
    const into = state.folders.find(f => f.id === m.into)
    if (!from || !into) {
      console.log(`   ✗ 合併 ${m.from} → ${m.into}：找不到資料夾，跳過`)
      continue
    }
    const members = state.sources.filter(s => s.folderId === from.id)
    for (const s of members) {
      await updateSourceSettings(db, workspaceId, s.id, { folderId: into.id })
      movedIds.push(s.id)
    }
    // 合完整組都要重新判斷，不只搬過去的那幾份：原本就在目標組、因為「同組沒人填過」補不了的那份
    //（MYFEEL「SHARP 自動調理零水鍋」裡的「Progress」），合進來的那份帶著產品名，現在補得上了
    for (const s of state.sources.filter(x => x.folderId === into.id)) movedIds.push(s.id)
    const { movedSources } = await deleteFolderCascade(db, workspaceId, from.id)
    await audit('knowledgeFolder.delete', from.id, `「${from.name}」併進「${into.name}」：搬了 ${members.length} 份${movedSources ? `，另有 ${movedSources} 份搬家途中新加進來的改成未分類` : ''}（C-320）`)
    console.log(`   ✓ ${q(from.name)} 併進 ${q(into.name)}（${members.length} 份）`)
  }

  // 3. 補產品名＋重新學習：走伺服器搬資料夾時同一支（每一份當下重新判斷一次，期間資料變了就照新的）
  const fillIds = [...new Set([...plan.fills.map(r => r.source.id), ...movedIds])]
  let relearned = 0
  let failed = 0
  for (const id of fillIds) {
    const r = await fillProductNameFromGroup(db, workspaceId, id, { uid: '', actor: 'system' })
    const name = state.sources.find(s => s.id === id)?.name ?? id
    if (r.filled) {
      relearned += r.relearned.indexed
      failed += r.relearned.failed
      console.log(`   ✓ ${q(name)} → ${q(r.productName)}，重新學習 ${r.relearned.indexed} 條${r.relearned.failed ? `、失敗 ${r.relearned.failed} 條（到知識庫那一份再按一次重新學習）` : ''}`)
    }
    else if (plan.fills.some(f => f.source.id === id)) {
      console.log(`   · ${q(name)} 這次沒補（${r.reason}${r.names?.length ? `：${r.names.map(q).join('、')}` : ''}）——dry-run 之後資料有變`)
    }
  }

  // 4. 清產品名（有指定才做）
  for (const id of clears) {
    const s = state.sources.find(x => x.id === id)
    if (!s) {
      console.log(`   ✗ 清產品名 ${id}：找不到這份資料，跳過`)
      continue
    }
    await updateSourceSettings(db, workspaceId, id, { productName: '' })
    const r = await relearnSourceChunks(db, workspaceId, id)
    relearned += r.indexed
    failed += r.failed
    await audit('source.put', id, `${s.name}：清掉產品名「${s.productName}」（通用分組裡不講單一商品），重新學習 ${r.indexed} 條${r.failed ? `、失敗 ${r.failed} 條` : ''}（C-320）`)
    console.log(`   ✓ ${q(s.name)} 清掉產品名，重新學習 ${r.indexed} 條${r.failed ? `、失敗 ${r.failed} 條` : ''}`)
  }

  // 5. 指定產品名（有指定才做；拿不準、老闆選好的那幾份）
  for (const t of sets) {
    const s = state.sources.find(x => x.id === t.id)
    if (!s) {
      console.log(`   ✗ 指定產品名 ${t.id}：找不到這份資料，跳過`)
      continue
    }
    await updateSourceSettings(db, workspaceId, t.id, { productName: t.name })
    const r = await relearnSourceChunks(db, workspaceId, t.id)
    relearned += r.indexed
    failed += r.failed
    await audit('source.put', t.id, `${s.name}：產品名「${s.productName || '（空）'}」改成「${t.name}」（同組有兩種寫法，照老闆選的），重新學習 ${r.indexed} 條${r.failed ? `、失敗 ${r.failed} 條` : ''}（C-320）`)
    console.log(`   ✓ ${q(s.name)} 產品名設成 ${q(t.name)}，重新學習 ${r.indexed} 條${r.failed ? `、失敗 ${r.failed} 條` : ''}`)
  }

  console.log(`\n完成：重新學習 ${relearned} 條${failed ? `、失敗 ${failed} 條（排程會自動重試，或到那一份按重新學習）` : ''}`)
}

const state = await readState()
const plan = buildPlan(state)
printPlan(state, plan)
if (apply) await runApply(state, plan)
else console.log('\n（dry-run：什麼都沒寫。確認後加 --apply；合併、清產品名要另外加 --merge=／--clear-product=）')
process.exit(0)
