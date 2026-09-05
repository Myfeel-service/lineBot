import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { countsAsCustomerHit } from '~~/shared/tag-admin'
import type { UserTagDoc, TagLogDoc, UserTagSourceType } from '~~/shared/types/tag-broadcast'

export interface TaggingResult {
  added: string[]
  skipped: string[]
  /**
   * 本來就在身上、這次「又被判到一次」而且**真的記進次數**的標籤（`D-55`）。
   * ⊆ `skipped`；落在冷卻窗內的那些只更新時間、不進這裡。
   */
  hits: string[]
}

/**
 * 同一顆標籤在這段時間內重複判到 → 只更新「最近一次」，**不加次數**。
 *
 * 為什麼是一小時：2026-09-03 稽核 MYFEEL 線上資料，56 對重複貼標的間隔
 * **中位數 8.8 秒、最長不到一小時、一天以上 0 對**——全部是客人連點按鈕造成的
 * （貼標本來冪等，但兩個並行寫入都讀到「還沒貼」就會各寫一筆 `tagLogs`）。
 * 一小時的窗把「同一場裡的連點」整批吃掉，而「隔幾天又來問」一定算得到。
 */
export const TAG_HIT_COOLDOWN_MS = 60 * 60 * 1000

/**
 * 這個來源算不算「客人自己又表現了一次意圖」（`D-55` 的計次條件）。
 *
 * **本體 2026-09-04 搬到 `~~/shared/tag-admin`**（`D-63`：貼標分析的排行要吃同一條界線，
 * 而那些聚合是前後端共用的純函式，不能相依 server）。這裡照舊 re-export，
 * 既有的 `import { countsAsCustomerHit } from './tagging'` 全部不受影響。
 * ⛔ 要改「哪些來源算客人訊號」請改 shared 那一支，不要在這裡另寫一份。
 */
export { countsAsCustomerHit }

/**
 * 算出這一次「又被判到」之後該寫什麼（純函式，可測）。
 *
 * ⛔ 時間一律用**同一個時鐘**（呼叫端傳進來的 `nowMs`）跟 `lastHitAtMs` 比大小，
 *   不可以拿 `Date.now()` 去跟 `serverTimestamp()` 寫下的值比——紅點那次就是這樣踩的：
 *   兩個時鐘差幾分鐘，判斷就永遠倒過來（見記憶 `project_unread_dot_rules_20260807`）。
 *   所以這兩欄存的是 `*Ms` 數字，不是 Timestamp。
 * ⛔ `lastHitAtMs` 比現在還新（時鐘歪掉）也當成「在冷卻窗內」——寧可少算一次，
 *   不要因為一次時鐘抖動就把次數灌上去。
 */
export function nextTagHit(
  existing: { lastHitAtMs?: unknown, hitCount?: unknown } | undefined | null,
  nowMs: number,
): { lastHitAtMs: number, hitCount: number, counted: boolean } {
  const rawCount = Number(existing?.hitCount)
  // 沒有值＝從來沒被自動判到過（例如後台手動貼的）→ 從 0 起算，不要猜成 1
  const prevCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0
  const rawLast = Number(existing?.lastHitAtMs)
  const prevLast = Number.isFinite(rawLast) && rawLast > 0 ? rawLast : 0
  const withinCooldown = prevLast > 0 && nowMs - prevLast < TAG_HIT_COOLDOWN_MS
  return {
    lastHitAtMs: nowMs, // 「最近一次」永遠更新，冷卻窗只管次數
    hitCount: prevCount + (withinCooldown ? 0 : 1),
    counted: !withinCooldown,
  }
}

/**
 * 冪等貼標：對單一使用者批次加標籤。
 * - 已存在的 userTag doc（userId_tagId）不重複建立，但會更新「最近一次／第幾次」（`D-55`）。
 * - 同時寫 tagLogs 供稽核。
 * - 使用 Firestore batch，保證原子性。
 *
 * ⛔ **`lastHitAtMs`／`hitCount` 只算「客人訊號」的來源**（見 countsAsCustomerHit）：
 * 這支的呼叫者大多是客人自己觸發（圖文選單按鈕、腳本、使用者輸入）或 AI 判到，
 * **但有一個是真人客服的動作**——`pushSupportPresetActionToUser`（按預存回覆順帶貼標）
 * 傳的是 `manual`，那條不計次。後台手動貼標與批次貼標則根本不走這裡（各自寫入），
 * 所以「批次貼 500 人」也不會把次數灌爆。
 * 動這裡之前先確認這個前提還成立（`rg 'addTagsToUser\('`）。
 */
export async function addTagsToUser(
  /** Firestore users 主鍵：`${workspaceId}_${lineUserId}` */
  userFirestoreDocId: string,
  tagIds: string[],
  sourceType: UserTagSourceType,
  sourceRefId: string | null,
  workspaceId: string,
): Promise<TaggingResult> {
  if (!userFirestoreDocId || !tagIds.length) return { added: [], skipped: [], hits: [] }

  const db = getDb()
  const now = FieldValue.serverTimestamp()
  const nowMs = Date.now()
  const added: string[] = []
  const skipped: string[] = []
  const hits: string[] = []
  const batch = db.batch()

  const entries = await Promise.all(
    tagIds.map(async (tagId) => {
      const docId = `${userFirestoreDocId}_${tagId}`
      const ref = db.collection('userTags').doc(docId)
      const snap = await ref.get()
      // ⛔ 要帶 data() 出來：冷卻窗要比對現有的 lastHitAtMs，而這份 snapshot 已經讀過了，
      //   再查一次就是白花一次讀取（08-11 讀取費的教訓）
      return { tagId, ref, exists: snap.exists, data: snap.data() as UserTagDoc | undefined }
    }),
  )

  for (const { tagId, ref, exists, data } of entries) {
    if (exists) {
      skipped.push(tagId)
      /**
       * 已經在身上＝**客人又表現了一次同樣的意圖**（`D-55`）。標籤本身不動，
       * 只更新「最近一次」與「第幾次」——這是「重複幾次」唯一記得到的地方，
       * 先前這裡直接 `continue`，第二次之後一個字都不留。
       * ⛔ 用 merge：這條路不可以覆蓋整份文件（sourceType／createdAt 是第一次貼上的事實）。
       */
      // ⛔ 只有客人訊號才計次（見 countsAsCustomerHit）；我們自己貼的略過就真的只是略過
      if (!countsAsCustomerHit(sourceType)) continue
      const hit = nextTagHit(data, nowMs)
      batch.set(ref, { lastHitAtMs: hit.lastHitAtMs, hitCount: hit.hitCount }, { merge: true })
      if (hit.counted) hits.push(tagId)
      continue
    }

    const userTagDoc: UserTagDoc = {
      workspaceId,
      userId: userFirestoreDocId,
      tagId,
      sourceType,
      sourceRefId,
      createdBy: null,
      createdAt: now,
      /**
       * 第一次貼上就是第一次被判到（⛔ 別留空等以後補，那會讓「1 次」跟「沒記錄」混在一起）。
       * ⛔ 但只有客人訊號才給：後台手動貼的標籤天生沒有這兩欄＝「從來沒被自動判到過」，
       *   分析讀成 0 次才對——給它 1 會讓「客服自己貼的」看起來像客人問過一次。
       */
      ...(countsAsCustomerHit(sourceType) ? { lastHitAtMs: nowMs, hitCount: 1 } : {}),
    }
    batch.set(ref, userTagDoc)

    const logDoc: TagLogDoc = {
      workspaceId,
      action: 'add',
      userId: userFirestoreDocId,
      tagId,
      sourceType,
      sourceRefId,
      operatorId: null,
      createdAt: now,
    }
    batch.set(db.collection('tagLogs').doc(uuidv4()), logDoc)

    added.push(tagId)
  }

  /**
   * ⛔ 條件是「有東西要寫」不是「有新標籤」：`D-55` 之後，全部略過的那次也會寫
   * （更新最近一次／次數）。先前只看 `added.length`，那會讓每一次重複判到都靜靜丟掉。
   */
  if (added.length > 0 || (skipped.length > 0 && countsAsCustomerHit(sourceType))) {
    await batch.commit()
  }

  return { added, skipped, hits }
}

/**
 * 冪等摘標：對單一使用者批次移除標籤（與 addTagsToUser 成對）。
 * - 本來就沒有的 userTag doc 自動略過。
 * - 同樣寫 tagLogs（action: 'remove'）供稽核——系統自動摘的標要查得到是誰摘的。
 *
 * ⚠️ 摘掉會連 `lastHitAtMs`／`hitCount` 一起消失，再貼上就從第 1 次重新算（`D-55`）。
 * 這是刻意的：摘標多半是「人判斷這顆不對」，把舊次數接著算下去會讓那個判斷失效；
 * 真要追完整歷史看 `tagLogs`（那本不刪除，add／remove 都留）。
 */
export async function removeTagsFromUser(
  /** Firestore users 主鍵：`${workspaceId}_${lineUserId}` */
  userFirestoreDocId: string,
  tagIds: string[],
  sourceType: UserTagSourceType,
  sourceRefId: string | null,
  workspaceId: string,
): Promise<{ removed: string[]; skipped: string[] }> {
  if (!userFirestoreDocId || !tagIds.length) return { removed: [], skipped: [] }

  const db = getDb()
  const now = FieldValue.serverTimestamp()
  const removed: string[] = []
  const skipped: string[] = []
  const batch = db.batch()

  const entries = await Promise.all(
    tagIds.map(async (tagId) => {
      const ref = db.collection('userTags').doc(`${userFirestoreDocId}_${tagId}`)
      const snap = await ref.get()
      return { tagId, ref, exists: snap.exists }
    }),
  )

  for (const { tagId, ref, exists } of entries) {
    if (!exists) {
      skipped.push(tagId)
      continue
    }
    batch.delete(ref)
    const logDoc: TagLogDoc = {
      workspaceId,
      action: 'remove',
      userId: userFirestoreDocId,
      tagId,
      sourceType,
      sourceRefId,
      operatorId: null,
      createdAt: now,
    }
    batch.set(db.collection('tagLogs').doc(uuidv4()), logDoc)
    removed.push(tagId)
  }

  if (removed.length > 0) {
    await batch.commit()
  }

  return { removed, skipped }
}
