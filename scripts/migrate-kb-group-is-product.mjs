/**
 * 舊資料搬家：分組就是商品（`D-127`，2026-10-16 老闆拍板；取代 `C-320` 的 migrate-kb-product-groups）。
 *
 * 做什麼（一次一個帳號）：
 *   1. 商品分組裡每一份資料（試算表、型錄除外）的商品名改成**組名**，改到的那幾份重新學習
 *   2. 原本的商品名（含型號的全名、舊寫法）跟組名不一樣的 → 收成那一組的別名（AI 認得的字只多不少，`C-325` productVocabulary）。
 *      組名本來是別名的先改成正式名；對到**另一組組名**的不收、擋 --apply（放錯組的那一份要先用 --move 講清楚）
 *   3. 一組裡其實是兩款（只差型號尾巴：W1 REGEN／W1 REGEN ULTRA，shared isVariantPair）→ 拆：份數多的那一款留在原本那一組、
 *      組名改成它的商品名；其他款各建一組（組名＝它的商品名）。⛔ 拆的時候舊組名（「MATELASER」是兩款共用的品牌）不收成別名
 *   4. 通用分組、未分類裡還掛著商品名的 → 清掉（未分類＝不是講單一商品；要放進商品分組用 --move）
 *   5. 商品名清單（knowledgeProductIndex.names）重建成現在的商品分組名（`C-325` 起答題不讀它，留著乾淨）
 *   6. 名字看起來是同一台的兩組 → 只列建議（合成一組在畫面「這幾個商品名是同一台嗎？」那裡按）
 * 規則跟伺服器搬組時同一份（shared/knowledge-product-group productNameForGroup），⛔ 不在這裡另寫一套。
 *
 * 用法（預設只讀不寫＝dry-run）：
 *   node --env-file=.env_myfeel scripts/migrate-kb-group-is-product.mjs <workspaceId>
 * 實際寫入（老闆看過 dry-run 點頭之後才跑；重新學習要打 Gemini，所以要多讀一份有 GEMINI_API_KEY 的 .env）：
 *   node --env-file=.env --env-file=.env_myfeel scripts/migrate-kb-group-is-product.mjs <workspaceId> --apply
 * 選項（dry-run 也吃，先看結果再加 --apply）：
 *   --move=<資料id>:<組名>       這一份改放哪一組（組名可以是現有的、這次要拆出來的新組，或「通用」「未分類」）
 *   --keep-together=<組名>       這一組照舊一組、不拆（就算看起來是兩款）
 *   --split=<組名>               這一組拆開（寫法不同、但其實是兩台的時候）
 *   --rename=<組名>:<新組名>     先改組名（組名＝AI 認的商品名）；舊組名收成別名（同畫面上改組名）
 *
 * ⚠️ firebase-admin 會繞過所有安全規則。dry-run 只讀：knowledgeFolders、knowledgeSources、knowledgeChunks（只取 sourceId／status）、
 *    knowledgeProductIndex。--apply 會寫：knowledgeFolders（建組、改名）、knowledgeSources（productName、folderId）、
 *    knowledgeChunks（重新學習的向量）、knowledgeProductIndex（別名、商品名清單）、auditLogs、aiUsage（embedding 用量）。
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
const optValues = name => args.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3).trim()).filter(Boolean)
const moves = optValues('move').map((v) => {
  const i = v.indexOf(':')
  return { id: (i > 0 ? v.slice(0, i) : '').trim(), group: (i > 0 ? v.slice(i + 1) : '').trim() }
})
const keepTogether = optValues('keep-together')
const forceSplit = optValues('split')
// 改組名：--rename=<組名>:<新組名>（組名＝AI 認的商品名；組名比商品名短很多時，改成完整名稱 AI 每一條前面加的字比較完整）
const renames = optValues('rename').map((v) => {
  const i = v.indexOf(':')
  return { from: (i > 0 ? v.slice(0, i) : '').trim(), to: (i > 0 ? v.slice(i + 1) : '').trim() }
})
if (renames.some(r => !r.from || !r.to)) {
  console.error('--rename 要寫成 --rename=<組名>:<新組名>')
  process.exit(1)
}

if (!workspaceId) {
  console.error('用法：node --env-file=.env_myfeel scripts/migrate-kb-group-is-product.mjs <workspaceId> [--apply] [--move=資料id:組名] [--keep-together=組名] [--split=組名]')
  process.exit(1)
}
if (moves.some(m => !m.id || !m.group)) {
  console.error('--move 要寫成 --move=<資料id>:<組名>')
  process.exit(1)
}

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey } = process.env
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID、FIREBASE_CLIENT_EMAIL、FIREBASE_PRIVATE_KEY（用 --env-file=.env_myfeel）')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()
/*
 * 伺服器程式裡的 Nuxt 自動匯入，站外跑腳本時沒有（2026-10-16 MYFEEL 搬家第一次 --apply 就是這樣：
 * 名字、分組、別名都寫進去了，重新學習 261 條全部失敗「useRuntimeConfig is not defined」，那幾條被標成 failed、AI 用不到）。
 * 重新學習會打 Gemini（gemini.ts 讀 useRuntimeConfig().geminiApiKey），錯誤用 createError
 */
globalThis.useRuntimeConfig ??= () => ({ geminiApiKey: process.env.GEMINI_API_KEY ?? '' })
globalThis.createError ??= o => Object.assign(new Error(o?.statusMessage ?? 'error'), o)

const { distinctGroupProductNames, findLikelyDuplicateGroups, isVariantPair, productNameForGroup, sameProductGroupName } =
  await jiti.import(join(ROOT, 'shared/knowledge-product-group.ts'))
const { canonicalProductName } = await jiti.import(join(ROOT, 'server/utils/ai-product-alias.ts'))
const { isUsableAlias, normalizeProductName } = await jiti.import(join(ROOT, 'shared/product-name-similarity.ts'))

const GENERAL = '通用'
const NONE = '未分類'
const q = s => `「${s}」`

async function readState() {
  const [folderSnap, sourceSnap, chunkSnap, idxSnap] = await Promise.all([
    db.collection('knowledgeFolders').where('workspaceId', '==', workspaceId).get(),
    db.collection('knowledgeSources').where('workspaceId', '==', workspaceId)
      .select('name', 'type', 'folderId', 'productName', 'generateOverview', 'isDeleted', 'deletedAt').get(),
    // 只拿算條數要用的兩格（⛔ 不要整份拉回來：每一條都帶 768 維向量）
    db.collection('knowledgeChunks').where('workspaceId', '==', workspaceId).select('sourceId', 'status').get(),
    db.collection('knowledgeProductIndex').doc(workspaceId).get(),
  ])
  const folders = folderSnap.docs
    .map(d => ({ id: d.id, name: String(d.get('name') ?? ''), order: Number(d.get('order') ?? 0), general: d.get('general') === true }))
    .sort((a, b) => a.order - b.order)
  const sources = sourceSnap.docs
    .filter(d => d.get('isDeleted') !== true && d.get('deletedAt') == null)
    .map(d => ({
      id: d.id,
      name: String(d.get('name') ?? ''),
      type: String(d.get('type') ?? 'file'),
      folderId: d.get('folderId') ?? null,
      productName: String(d.get('productName') ?? '').trim(),
      isCatalog: d.get('generateOverview') === true,
    }))
  // 重新學習會跳過停用的（同 relearnSourceChunks）——條數照那個口徑算
  const relearnCount = new Map()
  for (const c of chunkSnap.docs) {
    if (c.get('status') === 'disabled') continue
    const sid = String(c.get('sourceId') ?? '')
    if (sid) relearnCount.set(sid, (relearnCount.get(sid) ?? 0) + 1)
  }
  const aliases = idxSnap.get('aliases') && typeof idxSnap.get('aliases') === 'object' ? idxSnap.get('aliases') : {}
  return { folders, sources, relearnCount, aliases }
}

/**
 * 算出搬完之後的樣子（純計算，不寫）。
 * groups：搬完之後的每一組 { key, folderId（新建的是 null）, name, general, rename? }
 * placement：每一份放哪一組（group key）；target：每一份搬完的商品名
 */
function buildPlan({ folders, sources, relearnCount, aliases }) {
  const canonical = n => canonicalProductName(n, aliases)
  const flags = s => ({ isCatalog: s.isCatalog, isSheet: s.type === 'gsheet' })
  const groups = new Map(folders.map(f => [f.id, { key: f.id, folderId: f.id, name: f.name, general: f.general, oldName: f.name }]))
  const placement = new Map(sources.map(s => [s.id, s.folderId && groups.has(s.folderId) ? s.folderId : NONE]))
  const plan = { splits: [], aliases: [], changes: [], cleared: [], moves: [], problems: [], duplicates: [], promotes: [] }
  const aliasByKey = new Map()
  /** sourceId：哪一份資料的商品名帶來這條別名（改組名帶來的沒有）——對到別組時要講是哪幾份 */
  const addAlias = (alias, target, sourceId) => {
    if (!alias || !target || sameProductGroupName(alias, target)) return
    const k = `${normalizeProductName(alias)}→${normalizeProductName(target)}`
    const hit = aliasByKey.get(k)
    if (hit) { if (sourceId) hit.sourceIds.push(sourceId); return }
    const a = { alias, canonical: target, usable: isUsableAlias(alias), already: false, sourceIds: sourceId ? [sourceId] : [] }
    aliasByKey.set(k, a)
    plan.aliases.push(a)
  }

  // ── --rename：先改組名（後面的拆組、換商品名都照新名字）；舊組名收成別名，同畫面上改組名 ──
  for (const r of renames) {
    const g = [...groups.values()].find(x => sameProductGroupName(x.name, r.from))
    if (!g) { plan.problems.push(`--rename 找不到組 ${q(r.from)}`); continue }
    if ([...groups.values()].some(x => x !== g && !x.general && sameProductGroupName(x.name, r.to))) {
      plan.problems.push(`--rename ${q(r.to)} 跟另一組同名（同一台只能有一組）`)
      continue
    }
    g.name = r.to
    if (!g.general) addAlias(g.oldName, r.to)
  }

  // ── 3. 一組裡是兩款 → 拆 ──
  for (const f of folders) {
    if (f.general || keepTogether.some(n => sameProductGroupName(n, f.name))) continue
    const members = sources.filter(s => placement.get(s.id) === f.id && !s.isCatalog && s.type !== 'gsheet' && s.productName)
    const names = distinctGroupProductNames(members.map(s => s.productName), canonical)
    if (names.length < 2) continue
    const forced = forceSplit.some(n => sameProductGroupName(n, f.name))
    const variant = names.some((a, i) => names.slice(i + 1).some(b => isVariantPair(a, b)))
    if (!forced && !variant) continue
    // 份數多的那一款留在原本那一組（distinctGroupProductNames 已經照份數排），組名改成它的商品名
    const [keep, ...others] = names
    const g = groups.get(f.id)
    g.name = keep
    g.splitFrom = f.name
    const created = []
    for (const n of others) {
      const key = `new:${n}`
      groups.set(key, { key, folderId: null, name: n, general: false, oldName: '' })
      for (const s of members) {
        if (normalizeProductName(canonical(s.productName)) === normalizeProductName(n)) placement.set(s.id, key)
      }
      created.push(n)
    }
    plan.splits.push({ from: f.name, keep, created })
  }

  // ── --move：指定這一份放哪一組 ──
  const groupByName = (name) => {
    if (name === NONE) return NONE
    for (const g of groups.values()) if (sameProductGroupName(g.name, name) || (name === GENERAL && g.general)) return g.key
    return null
  }
  for (const m of moves) {
    const s = sources.find(x => x.id === m.id)
    const key = groupByName(m.group)
    if (!s) { plan.problems.push(`--move 找不到資料 ${m.id}`); continue }
    if (!key) { plan.problems.push(`--move 找不到組 ${q(m.group)}（可以寫現有的、這次拆出來的、「通用」或「未分類」）`); continue }
    plan.moves.push({ source: s, from: groups.get(placement.get(s.id))?.name ?? NONE, to: key === NONE ? NONE : groups.get(key).name })
    placement.set(s.id, key)
  }

  // ── 1／2／4. 每一份的商品名＝它所在那一組的組名；舊名字收成別名 ──
  for (const s of sources) {
    const key = placement.get(s.id)
    const g = key === NONE ? null : groups.get(key)
    const target = productNameForGroup(g, flags(s))
    const movedTo = key !== (s.folderId && groups.has(s.folderId) ? s.folderId : NONE)
    if (target !== s.productName || movedTo) {
      plan.changes.push({ source: s, from: s.productName, to: target, group: g?.name ?? NONE, relearn: target !== s.productName ? (relearnCount.get(s.id) ?? 0) : 0, movedTo })
    }
    if (!target && s.productName && (!g || g.general)) plan.cleared.push({ source: s, group: g?.name ?? NONE })
    // 舊名字收成這一台的別名（拆出來的兩款各自歸各自的組，不會互收）
    if (target && s.productName) addAlias(s.productName, target, s.id)
  }
  // 改了名的組（沒拆的不會改名；拆的那一組改成份數多的那一款）
  plan.renames = [...groups.values()].filter(g => g.folderId && g.name !== g.oldName).map(g => ({ id: g.folderId, from: g.oldName, to: g.name }))
  plan.newGroups = [...groups.values()].filter(g => !g.folderId).map(g => g.name)
  plan.productGroupNames = [...groups.values()].filter(g => !g.general).map(g => g.name)

  /*
   * 組名一定是正式名（/code-review 第 2 條，同伺服器 promoteCanonicalName）：組名本來是某條別名的（MYFEEL「上好ㄟ抽取式除濕機」→「NWT 威技…」），
   * 先把那條拿掉——不然組名被收斂回舊名字，下面「舊名字收成組名的別名」也會因為兩邊收斂成同一個而什麼都不寫（以前 dry-run 印「本來就是」）
   */
  const groupByKey = new Map(plan.productGroupNames.map(n => [normalizeProductName(n), n]))
  const aliasesAfter = { ...aliases }
  for (const name of plan.productGroupNames) {
    const k = normalizeProductName(name)
    if (k && Object.prototype.hasOwnProperty.call(aliasesAfter, k)) {
      plan.promotes.push({ name, was: canonical(aliasesAfter[k]) })
      delete aliasesAfter[k]
    }
  }
  /*
   * 原本指向的名字收成組名的別名（同伺服器 makeGroupNameCanonical）：兩個名字本來就是同一台，只是換方向；
   * 不收的話舊名字跟這一組就斷了（MYFEEL「Poketomo 口袋同萌」原本指向「SHARP 小獴友 Poketomo 口袋同萌」，拿掉之後「小獴友」沒人認）。
   * ⛔ 原本指向的是另一組的組名＝不收（那是另一台）
   */
  for (const p of plan.promotes) {
    const owner = groupByKey.get(normalizeProductName(p.was))
    if (!owner || sameProductGroupName(owner, p.name)) addAlias(p.was, p.name)
  }
  const canonicalAfter = n => canonicalProductName(n, aliasesAfter)
  /*
   * 別名對到的是**另一組**的組名（/code-review 第 3 條）：組 A 裡誤放了一份商品名是「B」的，收成別名＝組 B 整台在 AI 眼裡併進 A。
   * ⛔ 不收、擋 --apply：放錯組就 --move 到 B；確定放對就 --move 到 A（指定過＝商品名照組名改，舊名字不收成別名）
   */
  const movedIds = new Set(moves.map(m => m.id))
  for (const a of plan.aliases) {
    a.already = normalizeProductName(canonicalAfter(a.alias)) === normalizeProductName(a.canonical)
    const owner = groupByKey.get(normalizeProductName(a.alias)) ?? groupByKey.get(normalizeProductName(canonicalAfter(a.alias)))
    if (!owner || sameProductGroupName(owner, a.canonical)) continue
    a.conflict = owner
    const unresolved = a.sourceIds.filter(id => !movedIds.has(id))
    for (const id of unresolved) {
      const s = sources.find(x => x.id === id)
      plan.problems.push(`${q(s?.name ?? id)} 放在 ${q(a.canonical)}，商品名 ${q(s?.productName ?? a.alias)} 卻是另一組 ${q(owner)}——收成別名會把兩台併成一台。`
        + `放錯組：--move=${id}:${owner}；確定放對：--move=${id}:${a.canonical}`)
    }
  }
  plan.duplicates = findLikelyDuplicateGroups([...groups.values()].map(g => ({
    id: g.key, name: g.name, general: g.general,
    productNames: sources.filter(s => placement.get(s.id) === g.key).map(s => s.productName),
  }))).map(d => ({ a: groups.get(d.a).name, b: groups.get(d.b).name, why: d.why }))
  plan.groups = groups
  plan.placement = placement
  return plan
}

function printPlan(plan, state) {
  console.log(`\n帳號 ${workspaceId}：${state.folders.length} 組、${state.sources.length} 份資料${apply ? '（--apply：會照下面寫入）' : '（只讀，沒有寫任何東西）'}\n`)
  const plainRenames = plan.renames.filter(r => !plan.splits.some(s => s.from === r.from))
  console.log(`⓪ 改組名（--rename）：${plainRenames.length}`)
  for (const r of plainRenames) console.log(`   ${q(r.from)} → ${q(r.to)}`)
  console.log(`\n① 拆成兩組（一組裡是兩款）：${plan.splits.length}`)
  for (const s of plan.splits) console.log(`   ${q(s.from)} → 留下的改名 ${q(s.keep)}；另建 ${s.created.map(q).join('、')}`)
  console.log(`\n② 指定改放（--move）：${plan.moves.length}`)
  for (const m of plan.moves) console.log(`   ${q(m.source.name)}：${q(m.from)} → ${q(m.to)}`)
  const willRelearn = plan.changes.filter(c => c.relearn > 0)
  console.log(`\n③ 商品名改成組名：${plan.changes.filter(c => c.to !== c.from).length} 份（重新學習 ${willRelearn.reduce((n, c) => n + c.relearn, 0)} 條）`)
  for (const c of plan.changes) {
    if (c.to === c.from && !c.movedTo) continue
    if (c.to === c.from) {
      console.log(`   ${q(c.source.name)}：搬到 ${q(c.group)}（商品名不變）`)
      continue
    }
    console.log(`   ${q(c.source.name)}［${c.group}］：${c.from ? q(c.from) : '（空）'} → ${c.to ? q(c.to) : '（空，不是講單一商品）'}${c.relearn ? `，重新學 ${c.relearn} 條` : ''}`)
  }
  console.log(`\n④ 組名改成正式名（本來是別的名字的別名）：${plan.promotes.length}`)
  for (const p of plan.promotes) console.log(`   ${q(p.name)}（以前收斂成 ${q(p.was)}）`)
  const add = plan.aliases.filter(a => a.usable && !a.already && !a.conflict)
  console.log(`\n⑤ 舊名字收成別名：${add.length}`)
  for (const a of add) console.log(`   ${q(a.alias)} → ${q(a.canonical)}`)
  for (const a of plan.aliases.filter(x => x.already && !x.conflict)) console.log(`   （已經是別名）${q(a.alias)} → ${q(a.canonical)}`)
  for (const a of plan.aliases.filter(x => !x.usable && !x.conflict)) console.log(`   ⚠️ 太短不收：${q(a.alias)}`)
  for (const a of plan.aliases.filter(x => x.conflict)) console.log(`   ⛔ 不收（是另一組 ${q(a.conflict)} 的名字）：${q(a.alias)} → ${q(a.canonical)}`)
  console.log(`\n⑥ 通用／未分類裡清掉商品名：${plan.cleared.length}`)
  for (const c of plan.cleared) console.log(`   ${q(c.source.name)}［${c.group}］：${q(c.source.productName)}`)
  console.log(`\n⑦ 商品名清單重建成 ${plan.productGroupNames.length} 個商品分組名`)
  console.log(`\n建議（不會自動做）：名字看起來是同一台的兩組 ${plan.duplicates.length}`)
  for (const d of plan.duplicates) console.log(`   ${q(d.a)} ／ ${q(d.b)}（${d.why === 'name' ? '名字一個包含另一個' : '兩組有同一個商品名'}）`)
  if (plan.problems.length) {
    console.log('\n⚠️ 沒辦法照做的：')
    for (const p of plan.problems) console.log(`   ${p}`)
  }
}

async function applyPlan(plan) {
  const { createFolder, updateFolder } = await jiti.import(join(ROOT, 'server/utils/ai-knowledge-folders.ts'))
  const { updateSourceSettings } = await jiti.import(join(ROOT, 'server/utils/ai-knowledge-sources.ts'))
  const { syncSourceProductWithGroup } = await jiti.import(join(ROOT, 'server/utils/ai-knowledge-product-group.ts'))
  const { confirmAlias, promoteCanonicalName } = await jiti.import(join(ROOT, 'server/utils/ai-product-alias.ts'))
  const { writeAuditLog } = await jiti.import(join(ROOT, 'server/utils/audit-log.ts'))
  if (!process.env.GEMINI_API_KEY) {
    console.error('\n⛔ 重新學習要 GEMINI_API_KEY：用 --env-file=.env --env-file=.env_myfeel')
    process.exit(1)
  }
  const audit = (note, extra = {}) => writeAuditLog({ workspaceId, uid: '', actor: 'system', action: 'knowledgeFolder.put', note, ...extra }, db)

  // 1. 拆出來的新組先建（createFolder 同名的商品分組會回現有那一組，不會重複建）
  const keyToFolder = new Map()
  for (const g of plan.groups.values()) {
    if (g.folderId) { keyToFolder.set(g.key, g.folderId); continue }
    const f = await createFolder(db, workspaceId, g.name)
    keyToFolder.set(g.key, f.id)
    await audit(`搬家（D-127）：拆出新的一組 ${q(g.name)}`, { targetId: f.id, after: { name: g.name } })
    console.log(`  建了 ${q(g.name)}`)
  }
  // 2. 改組名（拆的那一組改成份數多的那一款）。⛔ 先搬走別款再改名：不然改名那一下兩款還在同一組
  for (const c of plan.changes) {
    if (!c.movedTo) continue
    const key = plan.placement.get(c.source.id)
    await updateSourceSettings(db, workspaceId, c.source.id, { folderId: key === NONE ? null : keyToFolder.get(key) })
    console.log(`  搬 ${q(c.source.name)} → ${q(c.group)}`)
  }
  for (const r of plan.renames) {
    await updateFolder(db, workspaceId, r.id, { name: r.to })
    const split = plan.splits.some(s => s.from === r.from)
    await audit(`搬家（D-127）：${q(r.from)}${split ? ' 是兩款，留下的這一組' : ''}改名 ${q(r.to)}`, { targetId: r.id, after: { name: r.to } })
    console.log(`  改名 ${q(r.from)} → ${q(r.to)}`)
  }
  // 3. 組名一定是正式名：本來是別名的先拿掉（不然下面收別名會被收斂回舊名字、什麼都不寫）；原本指向的名字在下一步收成它的別名
  for (const p of plan.promotes) {
    const previous = await promoteCanonicalName(db, workspaceId, p.name)
    console.log(`  正式名 ${q(p.name)}${previous ? `（不再收斂成 ${q(previous)}）` : '（本來就是）'}`)
  }
  // 4. 舊名字收成別名（在換商品名之前：學完之前卡片上還是舊名字，有別名就照樣認得）。⛔ 對到另一組組名的不收（dry-run 第 ⑤ 段）
  for (const a of plan.aliases) {
    if (!a.usable || a.already || a.conflict) continue
    const changed = await confirmAlias(db, workspaceId, a.canonical, a.alias)
    console.log(`  別名 ${q(a.alias)} → ${q(a.canonical)}${changed ? '' : '（本來就是）'}`)
  }
  // 5. 每一份照它現在所在那一組換商品名、重新學習（同伺服器搬組那一支，稽核記成系統）
  let indexed = 0
  let failed = 0
  for (const c of plan.changes) {
    if (c.to === c.from) continue
    const r = await syncSourceProductWithGroup(db, workspaceId, c.source.id, { uid: '', actor: 'system' })
    if (r.changed) {
      indexed += r.relearned.indexed
      failed += r.relearned.failed
      console.log(`  ${q(c.source.name)}：${q(r.previous)} → ${q(r.productName)}，學 ${r.relearned.indexed} 條${r.relearned.failed ? `、失敗 ${r.relearned.failed}` : ''}`)
    }
  }
  // 6. 商品名清單重建成現在的商品分組名
  await db.collection('knowledgeProductIndex').doc(workspaceId).set({ names: plan.productGroupNames }, { merge: true })
  await audit(`搬家（D-127 分組就是商品）做完：商品名改成組名 ${plan.changes.filter(c => c.to !== c.from).length} 份、重新學習 ${indexed} 條${failed ? `（失敗 ${failed} 條）` : ''}`)
  console.log(`\n做完：重新學習 ${indexed} 條${failed ? `、失敗 ${failed} 條（知識庫頁「要處理的事」會列出來，按「重新學習」）` : '、0 失敗'}`)
}

/*
 * --relearn-failed=<失敗原因裡的一段字>：只把「這個原因失敗的那幾條」所在的資料重新學一次（搬家重新學習失敗之後補救用）。
 * 不帶 --apply＝只列出會重學哪幾份、幾條。⛔ 一定要給原因：不相干、本來就壞掉的那幾條不要順手重算
 */
const relearnFailedReason = optValues('relearn-failed')[0] ?? ''
if (relearnFailedReason) {
  const snap = await db.collection('knowledgeChunks').where('workspaceId', '==', workspaceId).where('status', '==', 'failed')
    .select('sourceId', 'failureReason').get()
  const bySource = new Map()
  for (const c of snap.docs) {
    if (!String(c.get('failureReason') ?? '').includes(relearnFailedReason)) continue
    const sid = String(c.get('sourceId') ?? '')
    if (sid) bySource.set(sid, (bySource.get(sid) ?? 0) + 1)
  }
  const total = [...bySource.values()].reduce((a, b) => a + b, 0)
  console.log(`\n失敗原因含「${relearnFailedReason}」：${bySource.size} 份、${total} 條${apply ? '' : '（只讀，加 --apply 才重新學）'}`)
  if (apply) {
    if (!process.env.GEMINI_API_KEY) {
      console.error('⛔ 重新學習要 GEMINI_API_KEY：用 --env-file=.env --env-file=.env_myfeel')
      process.exit(1)
    }
    const { relearnSourceChunks } = await jiti.import(join(ROOT, 'server/utils/ai-knowledge-product-group.ts'))
    const { writeAuditLog } = await jiti.import(join(ROOT, 'server/utils/audit-log.ts'))
    // 操作紀錄要跟著寫：10-16 補學 281 條沒記，後台只看得到第一次「失敗 281 條」、看不出後來補好了
    const audit = entry => writeAuditLog({ workspaceId, uid: '', actor: 'system', ...entry }, db)
    let indexed = 0
    let failed = 0
    for (const sid of bySource.keys()) {
      const name = String((await db.collection('knowledgeSources').doc(sid).get()).get('name') ?? sid)
      const r = await relearnSourceChunks(db, workspaceId, sid)
      indexed += r.indexed
      failed += r.failed
      // 同後台「重新學習這一份」（reindex.post.ts）的記法
      await audit({
        action: 'source.reindex',
        targetId: sid,
        after: { name, itemsCount: r.total, chunkIdsCount: r.indexed, failedItemsCount: r.failed },
        note: `搬家（D-127）補學：${name}：重新學習 ${r.indexed} 條${r.failed ? `、失敗 ${r.failed} 條` : ''}`,
      })
      console.log(`  ${q(name)}：學 ${r.indexed} 條${r.failed ? `、失敗 ${r.failed}（${r.failures[0]?.failureReason ?? ''}）` : ''}`)
    }
    await audit({ action: 'knowledgeFolder.put', note: `搬家（D-127）補學做完：之前失敗的 ${bySource.size} 份重新學習 ${indexed} 條${failed ? `（失敗 ${failed} 條）` : '、0 失敗'}` })
    console.log(`\n做完：重新學習 ${indexed} 條、失敗 ${failed} 條`)
  }
  process.exit(0)
}

const state = await readState()
const plan = buildPlan(state)
printPlan(plan, state)
if (plan.problems.length && apply) {
  console.error('\n⛔ 有沒辦法照做的，先修好參數再 --apply')
  process.exit(1)
}
if (apply) await applyPlan(plan)
else console.log('\n（只讀。老闆看過、點頭之後加 --apply 才會寫）')
process.exit(0)
