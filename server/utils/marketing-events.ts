/**
 * 店家自己的檔期的讀寫（`D-122`②）。規則與理由在 `shared/marketing-events.ts`。
 *
 * 擺法：頂層集合 `marketingCalendarEvents`、doc id = workspaceId，一份文件一個 `events` map
 * （跟 `marketingCalendarSkips` 同一個做法與理由）。⛔ 多租戶：一律用登入檢查拿到的 workspaceId 當 doc id，
 * 不收前端傳來的 workspaceId。
 *
 * ⭐ 寫入一律走交易（讀現值 → 改 → 整包寫回）：兩個人同時加，⛔ 不可以後寫的蓋掉先寫的。
 * ⛔ 整包覆寫 `events`，不用 merge 逐鍵：刪除時要真的把那個 key 拿掉。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { v4 as uuidv4 } from 'uuid'
import {
  MARKETING_EVENTS_MAX,
  OWN_EVENT_ID_PREFIX,
  eventList,
  normalizeEventMap,
  pruneEventMap,
  type MarketingEvent,
  type MarketingEventMap,
} from '~~/shared/marketing-events'

export const MARKETING_EVENTS_COLLECTION = 'marketingCalendarEvents'

/** 讀。沒有文件就回空清單（不是 null）。 */
export async function getMarketingEvents(db: Firestore, workspaceId: string): Promise<MarketingEvent[]> {
  const snap = await db.collection(MARKETING_EVENTS_COLLECTION).doc(workspaceId).get()
  if (!snap.exists) return []
  return eventList(normalizeEventMap((snap.data() as { events?: unknown } | undefined)?.events))
}

/** 寫入時的錯誤：訊息直接給人看（端點轉成 4xx） */
export class MarketingEventError extends Error {
  readonly statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

export interface CreateEventInput {
  name: string
  date: string
  /**
   * 從推播頁「設成檔期」：那一則推播。給了就**同一個交易**把推播的 `festivalId` 設成這一檔，
   * 卡片與早上的提醒才認得「這一檔排好了」。⛔ 只收這個帳號、已排程、還沒綁任何一檔的推播。
   */
  broadcastId?: string
}

/**
 * 新增一檔。回新的那一筆。
 *
 * ⛔ 「設成檔期」的檢查一定要在交易裡做：檢查完、寫入前那一瞬間推播被別人發出去或綁到別檔，
 *   就會把一則已經不是排程中的推播設成檔期。
 */
export async function createMarketingEvent(
  db: Firestore,
  workspaceId: string,
  input: CreateEventInput,
  today: string,
): Promise<MarketingEvent> {
  const ref = db.collection(MARKETING_EVENTS_COLLECTION).doc(workspaceId)
  const id = `${OWN_EVENT_ID_PREFIX}${uuidv4()}`
  const now = Date.now()
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    let bcRef: FirebaseFirestore.DocumentReference | null = null
    if (input.broadcastId) {
      bcRef = db.collection('broadcasts').doc(input.broadcastId)
      const bc = await tx.get(bcRef)
      const v = bc.exists ? bc.data() as { workspaceId?: string, status?: string, festivalId?: string } : null
      // ⛔ 別家的跟不存在的一樣回 404，不告訴對方「別家有這一則」
      if (!v || v.workspaceId !== workspaceId) throw new MarketingEventError(404, '找不到這則推播，可能已經被刪掉了')
      if (v.status !== 'scheduled') throw new MarketingEventError(409, '只有已排程的推播可以設成檔期，請重新整理再看一次')
      if (v.festivalId) throw new MarketingEventError(409, '這則推播已經是某一檔的了')
    }

    const current = pruneEventMap(normalizeEventMap(snap.exists ? (snap.data() as { events?: unknown })?.events : {}), today)
    if (Object.keys(current).length >= MARKETING_EVENTS_MAX) {
      throw new MarketingEventError(409, `自己的檔期最多 ${MARKETING_EVENTS_MAX} 檔，先刪掉用不到的再加`)
    }
    const next: MarketingEventMap = {
      ...current,
      [id]: { name: input.name, date: input.date, createdAt: now, ...(input.broadcastId ? { broadcastId: input.broadcastId } : {}) },
    }
    tx.set(ref, { workspaceId, events: next, updatedAt: FieldValue.serverTimestamp() })
    if (bcRef) tx.update(bcRef, { festivalId: id, updatedAt: FieldValue.serverTimestamp() })
    return { id, ...next[id]! }
  })
}

/**
 * 改名稱或日期。回 { before, after }（稽核用）。
 *
 * ⭐ 日期改了要把這一檔「提醒到第幾天」的紀錄清掉（`cronState/festival-digest`）：
 *   延期是常有的事（新品開賣往後挪兩週），不清的話已經講到「明天」的那一檔，新的日子就一次都不提醒。
 */
export async function updateMarketingEvent(
  db: Firestore,
  workspaceId: string,
  id: string,
  input: { name: string, date: string },
  today: string,
): Promise<{ before: MarketingEvent, after: MarketingEvent }> {
  const ref = db.collection(MARKETING_EVENTS_COLLECTION).doc(workspaceId)
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const current = pruneEventMap(normalizeEventMap(snap.exists ? (snap.data() as { events?: unknown })?.events : {}), today)
    const was = current[id]
    if (!was) throw new MarketingEventError(404, '找不到這個檔期，可能已經被刪掉了')
    const next: MarketingEventMap = { ...current, [id]: { ...was, name: input.name, date: input.date, updatedAt: Date.now() } }
    tx.set(ref, { workspaceId, events: next, updatedAt: FieldValue.serverTimestamp() })
    return { before: { id, ...was }, after: { id, ...next[id]! } }
  })
  if (result.before.date !== result.after.date) await resetEventReminder(db, workspaceId, id)
  return result
}

/** 刪掉一檔。回刪掉的那一筆（稽核用）。推播不動——它的 `festivalId` 留著也只是對不到任何一檔。 */
export async function deleteMarketingEvent(
  db: Firestore,
  workspaceId: string,
  id: string,
  today: string,
): Promise<MarketingEvent> {
  const ref = db.collection(MARKETING_EVENTS_COLLECTION).doc(workspaceId)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const current = pruneEventMap(normalizeEventMap(snap.exists ? (snap.data() as { events?: unknown })?.events : {}), today)
    const was = current[id]
    if (!was) throw new MarketingEventError(404, '找不到這個檔期，可能已經被刪掉了')
    const next = { ...current }
    delete next[id]
    tx.set(ref, { workspaceId, events: next, updatedAt: FieldValue.serverTimestamp() })
    return { id, ...was }
  })
}

/**
 * 清掉這一檔「提醒到第幾天」的紀錄（形狀見 `cron-maintenance.ts` 的 `FestivalSentState`）。
 * ⛔ 失敗只記 log：檔期已經改好了，提醒少講一次比整個改動失敗好。
 */
async function resetEventReminder(db: Firestore, workspaceId: string, id: string): Promise<void> {
  await db.collection('cronState').doc('festival-digest')
    .set({ [workspaceId]: { [id]: FieldValue.delete() } }, { merge: true })
    .catch(err => console.warn('[marketing-events] 清提醒紀錄失敗：', workspaceId, id, err))
}
