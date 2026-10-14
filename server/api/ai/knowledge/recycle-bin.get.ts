import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'

/**
 * 一頁幾條（`C-312`）。以前一次給最近 100 條、沒有下一頁：換新版一次丟 150 條進來，
 * 昨天刪的那一條就被擠出畫面——還在保留期內、畫面也說「30 天內可以還原」，卻找不到、救不回來。
 */
const PAGE_SIZE = 50
/**
 * 有搜尋／挑了哪一份資料時，一次請求最多往前翻幾條（`C-312`）。
 * Firestore 做不到「內容含某幾個字」，只能一批批讀回來比；不設上限的話回收桶很大時一次請求讀幾千條。
 * 翻到上限還沒湊滿一頁就先停、回游標，並且講出來（scanCapped）——⛔ 不可以讓「還沒找」看起來像「找不到」。
 */
const SCAN_CAP = 1000
/** 每一批向 Firestore 要幾條 */
const SCAN_BATCH = 250
/**
 * 「哪一份資料」選單：最多數最近刪除的幾條（只讀資料編號跟刪除時間）。
 * ⚠️ select() 不省讀取費（一條照算一次讀），所以只在打開回收桶那一下算一次，搜尋時不重算。
 */
const SOURCE_SCAN_CAP = 3000
const SOURCE_SCAN_BATCH = 1000
/** 搜尋字最多吃多長（多的截掉） */
const MAX_QUERY_CHARS = 100

/**
 * 「資料已經不在了」那一組的代號（`C-312`）：來源整份被真刪（或是別家的）、或這條本來就沒掛資料。
 * 畫面上叫「已經刪掉的資料」；⚠️ 前端 sources/index.vue 寫死同一個字串。
 */
export const RECYCLE_GONE_SOURCE = '__gone__'

export interface RecycleBinRow {
  id: string
  title: string
  snippet: string
  sourceId: string | null
  sourceName: string | null
  deletedAtMs: number
  purgeAfterMs: number
}

/** 「哪一份資料」選單的一個選項（`C-312`） */
export interface RecycleBinSourceOption {
  /** 資料編號；資料已經不在的那一組是 RECYCLE_GONE_SOURCE */
  key: string
  /** 資料名稱；「已經刪掉的資料」那一組是 null（字由畫面決定） */
  name: string | null
  /** 這一份在回收桶裡有幾條 */
  count: number
}

export interface RecycleBinResponse {
  items: RecycleBinRow[]
  /** 舊欄位：後面還有（＝nextCursor 不是 null）。保留給還沒換版的畫面 */
  truncated: boolean
  /** 「顯示更多」帶回來的位置記號；null＝已經翻到回收桶最早的那一條 */
  nextCursor: string | null
  /** 這一次往前翻了幾條（有搜尋時畫面要講「最近刪除的 N 條找過了」） */
  scanned: number
  /** 翻到這一次的上限、一頁還沒湊滿就先停了：更早刪除的還沒找（⛔ 不是找不到） */
  scanCapped: boolean
  /** 回收桶一共幾條（第一頁才算；算不出來＝null） */
  total: number | null
  /** withSources=1 才有：回收桶裡的東西來自哪幾份資料（最近刪除的在前，「已經刪掉的資料」最後） */
  sources?: RecycleBinSourceOption[]
  /** 數到 SOURCE_SCAN_CAP 就停了：更早刪除的沒算進選單的數字 */
  sourcesTruncated?: boolean
  /** 選單那一份讀失敗（清單照樣給，選單只剩「全部」） */
  sourcesFailed?: boolean
}

/** 游標：刪除時間（秒＋奈秒）＋文件編號 */
interface BinPos { s: number, n: number, id: string }

/**
 * ⚠️ 刪除時間一定要整個帶（秒＋奈秒），不能只帶毫秒：「換新版」是同一批一起刪的，150 條的刪除時間一模一樣
 * 而且可能精確到微秒——游標只記到毫秒的話，startAfter 的位置會落在那一批**前面**，整批被當成「已經給過」直接跳掉。
 */
function posOf(d: QueryDocumentSnapshot): BinPos | null {
  const t = (d.data() as any)?.deletedAt
  if (t && typeof t.seconds === 'number' && typeof t.nanoseconds === 'number') return { s: t.seconds, n: t.nanoseconds, id: d.id }
  return null
}

function encodeCursor(p: BinPos): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): BinPos | null {
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (Number.isInteger(p?.s) && Number.isInteger(p?.n) && p.n >= 0 && p.n < 1e9 && typeof p?.id === 'string' && p.id && !p.id.includes('/')) {
      return { s: p.s, n: p.n, id: p.id }
    }
  }
  catch {}
  return null
}

/** 比對用的正規化：全形半形一致（ＡＢＣ＝ABC）、大小寫不分 */
function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

/** 搜尋字拆成幾個詞：空白隔開的每一個都要出現（標題或內容都算） */
function recycleSearchTerms(q: unknown): string[] {
  return norm(String(q ?? '').slice(0, MAX_QUERY_CHARS)).split(/\s+/).filter(Boolean).slice(0, 8)
}

/**
 * 摘要：有搜尋、而且詞落在內容後段時，擷取命中前後文（不然他看不出來為什麼這一條算找到）；否則拿開頭。
 * ⚠️ 正規化後長度變了（少數合字）就不擷取：位置對不回原文，寧可拿開頭也不截錯地方。
 */
function snippetOf(content: string, terms: string[]): string {
  const head = () => content.slice(0, 80) + (content.length > 80 ? '…' : '')
  if (!terms.length) return head()
  const n = norm(content)
  if (n.length !== content.length) return head()
  const idx = terms.map(t => n.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? -1
  if (idx < 60) return head()
  const start = idx - 20
  return `…${content.slice(start, start + 80)}${start + 80 < content.length ? '…' : ''}`
}

/**
 * 補資料名稱（一批一次 getAll，不逐筆 get）。cache：編號 → 名稱；null＝資料不在了（或是別家的，G-98 當作不存在）。
 * 讀失敗時：只是要顯示名稱就算了（名稱留空）；要靠它分「已經刪掉的資料」時往外丟——分錯比失敗更糟。
 */
async function nameSources(db: Firestore, workspaceId: string, ids: Iterable<string>, cache: Map<string, string | null>, strict: boolean) {
  const todo = [...new Set(ids)].filter(id => !cache.has(id))
  if (!todo.length) return
  let snaps: Awaited<ReturnType<Firestore['getAll']>>
  try {
    snaps = await db.getAll(...todo.map(id => db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(id)))
  }
  catch (e) {
    if (strict) throw createError({ statusCode: 503, statusMessage: '資料清單一時讀不到，請再試一次' })
    console.warn('[knowledge/recycle-bin] 資料名稱讀不到：', (e as Error)?.message)
    return
  }
  for (const s of snaps) {
    const data = s.exists ? (s.data() as any) : null
    cache.set(s.id, data && data.workspaceId === workspaceId ? String(data.name ?? '') : null)
  }
}

/** 回收桶的查詢：這個帳號、有刪除時間的，最新刪的在前（吃既有的 workspaceId＋deletedAt 複合索引，同名的文件編號排序是索引自帶的） */
function binQuery(db: Firestore, workspaceId: string): Query {
  return db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .orderBy('deletedAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
}

/** 一條回收桶的列（名稱另外補） */
function rowOf(d: QueryDocumentSnapshot, terms: string[]): RecycleBinRow & { haystack: string } {
  const c = d.data() as any
  const title = String(c?.title ?? '(無標題)')
  const content = String(c?.content ?? '')
  return {
    id: d.id,
    title,
    snippet: snippetOf(content, terms),
    sourceId: c?.sourceId != null && String(c.sourceId) ? String(c.sourceId) : null,
    sourceName: null,
    deletedAtMs: typeof c?.deletedAt?.toMillis === 'function' ? c.deletedAt.toMillis() : 0,
    purgeAfterMs: typeof c?.purgeAfter?.toMillis === 'function' ? c.purgeAfter.toMillis() : 0,
    haystack: terms.length ? norm(`${title}\n${content}`) : '',
  }
}

/**
 * 「哪一份資料」選單：數最近 SOURCE_SCAN_CAP 條各來自哪一份（`C-312`）。
 * 選單只列回收桶裡**真的有東西**的資料——列沒東西的，選了只會看到空的。
 */
async function sourceOptions(db: Firestore, workspaceId: string, cache: Map<string, string | null>) {
  const counts = new Map<string, number>() // 插入順序＝最近刪除的在前
  let noSource = 0
  let after: BinPos | null = null
  let scanned = 0
  let truncated = false
  while (scanned < SOURCE_SCAN_CAP) {
    const room = Math.min(SOURCE_SCAN_BATCH, SOURCE_SCAN_CAP - scanned)
    let q = binQuery(db, workspaceId).select('sourceId', 'deletedAt')
    if (after) q = q.startAfter(new Timestamp(after.s, after.n), after.id)
    const snap = await q.limit(room + 1).get() // 多拿一條：知道後面還有沒有
    const take = snap.docs.slice(0, room)
    for (const d of take) {
      const sid = (d.data() as any)?.sourceId
      if (sid != null && String(sid)) counts.set(String(sid), (counts.get(String(sid)) ?? 0) + 1)
      else noSource++
    }
    scanned += take.length
    if (snap.docs.length <= room) break
    const p = posOf(take[take.length - 1]!)
    if (!p) { truncated = true; break }
    after = p
    if (scanned >= SOURCE_SCAN_CAP) truncated = true
  }
  await nameSources(db, workspaceId, counts.keys(), cache, true)
  const options: RecycleBinSourceOption[] = []
  let gone = noSource
  for (const [key, count] of counts) {
    const name = cache.get(key)
    if (name == null) gone += count
    else options.push({ key, name, count })
  }
  if (gone) options.push({ key: RECYCLE_GONE_SOURCE, name: null, count: gone })
  return { options, truncated, scanned }
}

/**
 * GET /api/ai/knowledge/recycle-bin?q=&source=&cursor=&withSources=1
 *
 * 回收桶：最近被刪除（軟刪除）的知識，最新刪的在前。30 天保留期內可還原；過期由排程真刪。
 * orderBy(deletedAt) 天然排除沒有這個欄位的正常卡，不需要 != null 的不等式（吃 workspaceId+deletedAt 複合索引）。
 *
 * `C-312`：可以搜尋（標題、內容，不分大小寫、全形半形，空白隔開的每個詞都要有）、挑「哪一份資料」、
 * 「顯示更多」往前翻（startAfter 游標，⛔ 不用 offset——跳過的每一條都照算讀取費）。
 * 篩選都在記憶體做：挑資料要「workspaceId＋sourceId＋deletedAt」新索引才能在查詢層做，
 * 回收桶只放 30 天、量不大，跟搜尋共用同一條翻頁路比較單純；翻到上限就先停、講出來。
 *  · q：搜尋字
 *  · source：資料編號；`__gone__`＝資料已經不在的那幾條；不帶＝全部
 *  · cursor：上一次回的 nextCursor
 *  · withSources=1：順便給「哪一份資料」選單（打開回收桶那一下帶一次就好）
 */
export default defineEventHandler(async (event): Promise<RecycleBinResponse> => {
  const { workspaceId } = await requireCapability(event, 'knowledge.write')
  const db = getDb()
  const query = getQuery(event)
  const terms = recycleSearchTerms(query.q)
  const sourceFilter = String(query.source ?? '').trim().slice(0, 200)
  const rawCursor = String(query.cursor ?? '').trim()
  const cursor = rawCursor ? decodeCursor(rawCursor) : null
  if (rawCursor && !cursor) throw createError({ statusCode: 400, statusMessage: '「顯示更多」的位置記號看不懂，請重新打開回收桶' })
  const withSources = query.withSources === '1' || query.withSources === 'true'
  const filtering = terms.length > 0 || !!sourceFilter
  const nameCache = new Map<string, string | null>()

  // 選單、總數跟第一頁一起跑：選單那一份失敗不拖垮清單（只是選單少了，畫面會講）
  const sourcesTask = withSources
    ? sourceOptions(db, workspaceId, nameCache).catch((e) => {
        console.warn('[knowledge/recycle-bin] 資料選單沒算成：', (e as Error)?.message)
        return null
      })
    : Promise.resolve(null)
  // 總數：count() 聚合，1000 條才算一次讀；跟清單同一個查詢形狀（同一個索引、同一把尺）
  const totalTask = cursor
    ? Promise.resolve(null)
    : binQuery(db, workspaceId).count().get().then(a => a.data().count as number).catch(() => null)

  const matches = (r: RecycleBinRow & { haystack: string }) => {
    if (sourceFilter === RECYCLE_GONE_SOURCE) {
      if (r.sourceId && nameCache.get(r.sourceId) != null) return false
    }
    else if (sourceFilter && r.sourceId !== sourceFilter) return false
    return terms.every(t => r.haystack.includes(t))
  }

  const items: Array<RecycleBinRow & { haystack: string }> = []
  let pos: BinPos | null = cursor
  let scanned = 0
  let more = false
  for (;;) {
    // 沒篩選：剛好讀一頁＋1 條（那 1 條只是確認後面還有沒有）；有篩選：一批批讀，總共不超過 SCAN_CAP
    const room = filtering ? Math.min(SCAN_BATCH, SCAN_CAP - scanned) : PAGE_SIZE - items.length
    let q = binQuery(db, workspaceId).select('title', 'content', 'sourceId', 'deletedAt', 'purgeAfter')
    if (pos) q = q.startAfter(new Timestamp(pos.s, pos.n), pos.id)
    const snap = await q.limit(room + 1).get()
    const docs = snap.docs
    const take = docs.slice(0, room)
    const strict = sourceFilter === RECYCLE_GONE_SOURCE
    await nameSources(db, workspaceId, take.map(d => (d.data() as any)?.sourceId).filter(Boolean).map(String), nameCache, strict)
    more = docs.length > room
    let full = false
    for (let i = 0; i < take.length; i++) {
      const d = take[i]!
      const p = posOf(d)
      if (!p) {
        // 刪除時間格式不對：游標接不下去，只能到這裡為止（寫入端一律 serverTimestamp，不該發生）——留紀錄，不默默少列
        console.warn(`[knowledge/recycle-bin] ${workspaceId} 的 ${d.id} 刪除時間不是時間格式，回收桶只列到它之前`)
        more = false
        full = true
        break
      }
      scanned++
      pos = p
      const r = rowOf(d, terms)
      if (!matches(r)) continue
      items.push(r)
      if (items.length >= PAGE_SIZE) {
        more = i < docs.length - 1 // 這一批後面（含多拿的那一條）還有沒翻的
        full = true
        break
      }
    }
    if (full || !more || scanned >= SCAN_CAP) break
  }

  for (const r of items) r.sourceName = r.sourceId ? (nameCache.get(r.sourceId) || null) : null
  const [sources, total] = await Promise.all([sourcesTask, totalTask])
  const nextCursor = more && pos ? encodeCursor(pos) : null

  return {
    items: items.map(({ haystack: _h, ...r }) => r),
    truncated: !!nextCursor,
    nextCursor,
    scanned,
    scanCapped: !!nextCursor && items.length < PAGE_SIZE,
    // 選單把整個回收桶數完了的話，那就是最準的總數（同一個查詢數出來的），不用再信聚合
    total: sources && !sources.truncated ? sources.scanned : total,
    ...(withSources
      ? sources
        ? { sources: sources.options, sourcesTruncated: sources.truncated }
        : { sources: [], sourcesTruncated: false, sourcesFailed: true }
      : {}),
  }
})
