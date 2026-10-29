import { createHash } from 'node:crypto'
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { quoteKey, quotedValueIn, type SheetFieldChange } from '~~/shared/sheet-stale'

/**
 * 試算表改了、還寫著改之前原字的機器人模組（`C-429`，`D-165`）。規則在 `shared/sheet-stale.ts`。
 *
 * **記**：試算表同步時，內容有變的那幾格去找一次（一個帳號的模組一次讀完），找到就記一份
 *   `sheetStaleModules/{帳號}_{那一格}`：哪幾段舊字、現在寫什麼、哪幾個模組。只有真的有列改了才讀模組。
 * **讀**：提醒中心、模組頁再確認一次「現在還是舊的」——店家改掉之後提醒自己消失，不必另外清。
 * 同一格又改一次：舊字累積著記（改 A→B 時抄 A 的模組，B→C 之後照樣是舊的），最多記 5 段。
 */
export const SHEET_STALE_COLLECTION = 'sheetStaleModules'
const KEEP_DAYS = 60
const MAX_OLD_VALUES = 5

function staleDocId(workspaceId: string, sourceId: string, row: string, field: string): string {
  const h = createHash('sha1').update(`${sourceId}\u0000${quoteKey(row).toLowerCase()}\u0000${field}`).digest('hex').slice(0, 24)
  return `${workspaceId}_${h}`
}

/**
 * 同步完：改了的那幾格，找出還寫著舊字的模組記下來。回傳記了幾個模組。
 * ⛔ 永遠不丟錯：提醒記不下來不可以讓同步算失敗（AI 的知識已經更新了，那才是主要的事）。
 */
export async function recordStaleSheetModules(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  sourceName: string,
  changes: SheetFieldChange[],
): Promise<number> {
  if (!changes.length) return 0
  try {
    const flowsSnap = await db.collection('flows').where('workspaceId', '==', workspaceId).get()
    const flows = flowsSnap.docs.map(d => ({ id: d.id, messages: d.get('messages') }))
    let recorded = 0
    for (const c of changes) {
      const ref = db.collection(SHEET_STALE_COLLECTION).doc(staleDocId(workspaceId, sourceId, c.row, c.field))
      const prev = await ref.get()
      const prevOld = prev.exists && Array.isArray(prev.get('oldValues')) ? (prev.get('oldValues') as unknown[]).map(String) : []
      const newKey = quoteKey(c.newValue)
      const oldValues = [c.oldValue, ...prevOld]
        .filter((v, i, all) => quoteKey(v) !== newKey && all.findIndex(x => quoteKey(x) === quoteKey(v)) === i)
        .slice(0, MAX_OLD_VALUES)
      const moduleIds = flows.filter(f => quotedValueIn(f.messages, oldValues)).map(f => f.id)
      if (!moduleIds.length) {
        if (prev.exists) await ref.delete()
        continue
      }
      await ref.set({
        workspaceId,
        sourceId,
        sourceName,
        row: c.row,
        field: c.field,
        oldValues,
        newValue: c.newValue,
        moduleIds,
        changedAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + KEEP_DAYS * 86_400_000),
      })
      recorded += moduleIds.length
    }
    return recorded
  }
  catch (e) {
    console.error('[sheet-stale] 記不下來（同步照樣算成功）：', workspaceId, sourceId, e)
    return 0
  }
}

export interface SheetStaleRecord {
  sourceName: string
  row: string
  field: string
  oldValues: string[]
  newValue: string
  moduleIds: string[]
  /** ISO；記下來的時間（試算表同步到改動的那一次） */
  changedAt: string | null
}

/** 這個帳號記著的每一筆（還沒過期的）。模組頁拿回去自己用手上的模組再確認一次 */
export async function listSheetStaleRecords(db: Firestore, workspaceId: string): Promise<SheetStaleRecord[]> {
  const snap = await db.collection(SHEET_STALE_COLLECTION).where('workspaceId', '==', workspaceId).get()
  const now = Date.now()
  return snap.docs
    .map(d => d.data() as Record<string, any>)
    .filter(d => (d.expireAt?.toMillis?.() ?? Number.POSITIVE_INFINITY) > now)
    .map(d => ({
      sourceName: String(d.sourceName ?? ''),
      row: String(d.row ?? ''),
      field: String(d.field ?? ''),
      oldValues: Array.isArray(d.oldValues) ? d.oldValues.map(String) : [],
      newValue: String(d.newValue ?? ''),
      moduleIds: Array.isArray(d.moduleIds) ? d.moduleIds.map(String) : [],
      changedAt: d.changedAt?.toDate?.()?.toISOString?.() ?? null,
    }))
}

export interface StaleSheetModule {
  flowId: string
  flowName: string
  sourceName: string
  row: string
  field: string
}

/** 提醒中心：現在還寫著舊字的模組（記下來之後可能已經改掉了，再讀那幾個模組看一次） */
export async function findStaleSheetModules(db: Firestore, workspaceId: string): Promise<StaleSheetModule[]> {
  const records = await listSheetStaleRecords(db, workspaceId)
  if (!records.length) return []
  const ids = [...new Set(records.flatMap(r => r.moduleIds))]
  const snaps = ids.length ? await db.getAll(...ids.map(id => db.collection('flows').doc(id))) : []
  const byId = new Map(snaps.filter(s => s.exists && s.get('workspaceId') === workspaceId).map(s => [s.id, s]))
  const out: StaleSheetModule[] = []
  const seen = new Set<string>()
  for (const r of records) {
    for (const id of r.moduleIds) {
      const flow = byId.get(id)
      if (!flow || seen.has(id) || !quotedValueIn(flow.get('messages'), r.oldValues)) continue
      seen.add(id)
      out.push({ flowId: id, flowName: String(flow.get('name') ?? ''), sourceName: r.sourceName, row: r.row, field: r.field })
    }
  }
  return out
}
