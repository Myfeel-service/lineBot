import { getDb } from './firebase'
import { KNOWLEDGE_SOURCES_COLLECTION, listChunksBySource } from './ai-knowledge-sources'
import { loadSheetProductRegistry } from './sheet-products'
import { replaceSheetFieldTokens, sheetCardField, sheetRowKey, sheetFieldTokensIn, type SheetFieldRef } from '~~/shared/sheet-field'
import { sheetProductAliasMap } from '~~/shared/sheet-products'

/**
 * 機器人模組裡「試算表的一格」（`{{sheet:列|欄}}`）送出前換成那張知識卡上現在寫的（`C-423`）。
 * 規則（格式、怎麼切那一欄）在 `shared/sheet-field.ts`。
 *
 * ⛔ 換不到（那一列被刪、欄名改了、讀不到資料庫）**不可以**送原字、也不送空白：
 *    用存檔當時的內容（`sheetSnapshots`，編輯頁存檔時記的）；連那個都沒有才留空，並留 log。
 * ⛔ `sheetSnapshots` 是我們自己的欄位，送給 LINE 之前一定拿掉（文字訊息是整包展開送出去的）。
 */

export interface SheetRow {
  sourceId: string
  sourceName: string
  title: string
  content: string
  headers: string[]
}

/** 一個帳號一份、60 秒：試算表最快一小時自動同步一次，模組每送一次就讀一輪不划算 */
const CACHE_MS = 60_000
const cache = new Map<string, { at: number, rows: Map<string, SheetRow>, sources: SheetSourceSummary[] }>()

export interface SheetSourceSummary {
  id: string
  name: string
  /** null＝上線前建、還沒再同步過，還不知道有哪幾欄（畫面要講「同步一次才能用」） */
  headers: string[] | null
  rows: Array<{ title: string, values: Record<string, string> }>
}

/** 這個帳號每一份 Google 試算表的每一列（列名稱 → 那張卡）。同名的取先建的那份表 */
export async function loadSheetRows(workspaceId: string, opts: { fresh?: boolean } = {}): Promise<{ rows: Map<string, SheetRow>, sources: SheetSourceSummary[] }> {
  const hit = cache.get(workspaceId)
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit
  const db = getDb()
  const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('type', '==', 'gsheet')
    .get()
  const docs = snap.docs
    .filter(d => d.get('isDeleted') !== true && d.get('deletedAt') == null)
    .sort((a, b) => (a.get('createdAt')?.toMillis?.() ?? 0) - (b.get('createdAt')?.toMillis?.() ?? 0))
  const rows = new Map<string, SheetRow>()
  const sources: SheetSourceSummary[] = []
  const renamed: Array<{ sourceId: string, oldKey: string, nowKey: string }> = []
  for (const d of docs) {
    const rawHeaders = d.get('gsheetFieldHeaders')
    const headers = Array.isArray(rawHeaders) ? rawHeaders.map(String) : null
    const name = String(d.get('name') ?? d.get('title') ?? '試算表')
    const cards = (await listChunksBySource(db, workspaceId, d.id)).filter(c => !c.isOverview)
    const summary: SheetSourceSummary = { id: d.id, name, headers, rows: [] }
    for (const c of cards) {
      const values: Record<string, string> = {}
      for (const h of headers ?? []) {
        const v = sheetCardField(c.content, headers!, h)
        if (v !== null) values[h] = v
      }
      // 一格都切不出來的卡（後台手寫、內文沒有「欄名：」）不列進選單——MYFEEL 實測 20 張有 5 張這樣，列出來只是一排空的
      if (Object.keys(values).length) summary.rows.push({ title: c.title, values })
      const key = sheetRowKey(c.title)
      if (headers && !rows.has(key)) rows.set(key, { sourceId: d.id, sourceName: name, title: c.title, content: c.content, headers })
    }
    sources.push(summary)
    // `C-432`：在試算表改了名的商品（商品頁網址沒變，`C-434` 認得出來），模組裡用舊名寫的那一格接到現在這一列。
    // 讀不到商品清單就照舊（只是改了名的那幾格會用存檔當時的內容）
    const reg = await loadSheetProductRegistry(db, workspaceId, d.id).catch(() => null)
    if (reg) for (const [oldKey, nowKey] of sheetProductAliasMap(reg)) renamed.push({ sourceId: d.id, oldKey, nowKey })
  }
  // 全部的表都收完才接：⛔ 舊名字剛好是另一份表上現在的名字，那一列優先，不接過去
  for (const { sourceId, oldKey, nowKey } of renamed) {
    const now = rows.get(nowKey)
    if (!rows.has(oldKey) && now?.sourceId === sourceId) rows.set(oldKey, now)
  }
  const entry = { at: Date.now(), rows, sources }
  cache.set(workspaceId, entry)
  return entry
}

/** 一格現在的內容；找不到（沒這一列、沒這一欄、這份表還不知道欄名）＝null */
export function sheetFieldValue(rows: Map<string, SheetRow>, ref: SheetFieldRef): string | null {
  const row = rows.get(sheetRowKey(ref.row))
  return row ? sheetCardField(row.content, row.headers, ref.field) : null
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn)
    return out
  }
  return value
}

/** 送出前把每一則裡的「試算表的一格」換成現在的內容（沒有的話原樣回，不多讀資料庫） */
export async function hydrateSheetFields(messages: any[], workspaceId: string): Promise<any[]> {
  if (!Array.isArray(messages)) return []
  const uses = messages.some(m => JSON.stringify(m ?? {}).includes('{{sheet:'))
  if (!uses) {
    return messages.some(m => m && typeof m === 'object' && 'sheetSnapshots' in m)
      ? messages.map(({ sheetSnapshots: _drop, ...rest }) => rest)
      : messages
  }
  let rows = new Map<string, SheetRow>()
  try {
    rows = (await loadSheetRows(workspaceId)).rows
  }
  catch (e) {
    console.error('[sheet-field] 讀不到試算表的卡，改用存檔當時的內容：', workspaceId, e)
  }
  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg
    const { sheetSnapshots, ...rest } = msg as Record<string, unknown>
    const snapshots = (sheetSnapshots && typeof sheetSnapshots === 'object' ? sheetSnapshots : {}) as Record<string, string>
    return mapStrings(rest, s => replaceSheetFieldTokens(s, (ref, token) => {
      const live = sheetFieldValue(rows, ref)
      if (live !== null) return live
      const saved = snapshots[token]
      console.warn('[sheet-field] 試算表上找不到這一格，', saved != null ? '用存檔當時的內容' : '留空', '：', workspaceId, ref)
      return saved ?? ''
    }))
  })
}

/**
 * 存檔時：用了「試算表的一格」的那幾則，記下每一格當下的內容（`sheetSnapshots`，送出時換不到才用）。
 * 沒用到的訊息原樣回、不讀資料庫。讀不到試算表就留著上一次記的（⛔ 不清掉：那是唯一的退路）。
 */
export async function attachSheetSnapshots(messages: any[], workspaceId: string): Promise<any[]> {
  if (!Array.isArray(messages) || !messages.some(m => JSON.stringify(m ?? {}).includes('{{sheet:'))) return messages
  let rows = new Map<string, SheetRow>()
  try {
    rows = (await loadSheetRows(workspaceId, { fresh: true })).rows
  }
  catch (e) {
    console.error('[sheet-field] 存檔時讀不到試算表的卡，沿用上一次記的內容：', workspaceId, e)
  }
  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object' || !JSON.stringify(msg).includes('{{sheet:')) return msg
    const { sheetSnapshots: previous, ...rest } = msg as Record<string, unknown>
    const snapshots = snapshotsFor(rest, rows, (previous && typeof previous === 'object' ? previous : {}) as Record<string, string>)
    return Object.keys(snapshots).length ? { ...rest, sheetSnapshots: snapshots } : rest
  })
}

/** 一則訊息裡每一格當下的內容；換不到的留上一次記的 */
export function snapshotsFor(message: unknown, rows: Map<string, SheetRow>, previous: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  mapStrings(message, (s) => {
    for (const { token, ref } of sheetFieldTokensIn(s)) {
      const v = sheetFieldValue(rows, ref)
      if (v !== null) out[token] = v
      else if (previous[token] != null) out[token] = previous[token]!
    }
    return s
  })
  return out
}
