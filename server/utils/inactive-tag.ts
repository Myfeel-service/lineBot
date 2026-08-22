/**
 * 「N 天沒互動」自動標籤（CRM 分眾，CRM-EVAL-20260822 P1）。
 *
 * 為什麼做成標籤：全系統能拿來挑推播名單的只有標籤一種（BroadcastAudienceSource 四種
 * 來源裡會自己更新的只有 tags），所以「沉睡客」做成標籤＝推播端零改動就能選出
 * 「60 天沒講過話的人」發喚醒訊息。
 *
 * 三個機制（都在這一檔）：
 *   1. 每日掃描貼標（scanInactiveTag，掛 cron/run-tasks）：把「lastInboundMessageAt 落在
 *      窗口內」的客人貼上系統標籤。窗口＝[cutoff-7天, cutoff)，**不是敞開到 epoch**——
 *      ①避免每天重掃整批老對話（08-11 讀取費暴衝的教訓）②lastInboundMessageAt 是
 *      2026-08-19 起才寫的欄位，**刻意不回填**（同紅點那次的鐵律）：更早就沉默的老客
 *      第一批抓不到，隨時間自然補齊，也避免部署當下整排客人同時被貼標。
 *   2. 回訊摘標（clearInactiveTagOnReturn，掛 ensureConversationSession 慢路徑）：
 *      沉睡的客人一開口就把標籤摘掉——摘標判斷用的是交易裡**本來就讀了**的對話文件
 *      （舊的 lastInboundMessageAt），常態路徑零額外讀取。
 *   3. 每日修復掃描（併在 scanInactiveTag）：貼圖/圖片路徑存訊息與開會話是並行的，
 *      機制 2 可能讀到已更新的時間而漏摘；每天輪掃一小批已貼標的客人對帳，
 *      漏網的隔天自動修復。游標輪轉、每輪上限，不整批掃。
 *
 * ⚠️ 天數門檻與開關在 aiSettings.inactiveTag（預設開、60 天）。
 * ⚠️ 需要複合索引 conversations (workspaceId ASC, lastInboundMessageAt ASC)——見
 *    firestore.indexes.json；部署只跑 myfeel（2026-08-22 拍板 splash 先不管）。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { v4 as uuidv4 } from 'uuid'
import { getAiSettings } from './ai-settings'
import { addTagsToUser, removeTagsFromUser } from './tagging'
import { taipeiDate } from '~~/shared/time'
import type { TagDoc } from '~~/shared/types/tag-broadcast'

/** 系統標籤的固定 code（同 workspace 唯一）；名稱由天數組出來，天數改了名稱跟著改 */
export const INACTIVE_TAG_CODE = 'sys_inactive'

const DAY_MS = 86_400_000
/** 掃描窗口往回補幾天：排程漏跑（部署、Scheduler 抖動）最多這幾天內都追得回來 */
const CATCHUP_DAYS = 7
/** 每輪每工作區最多貼幾位（10 分鐘就有下一輪，慢慢消化；每日窗口的量本來就小） */
const SCAN_LIMIT = 300
/** 每日修復掃描一輪最多對帳幾筆已貼標紀錄 */
const REPAIR_LIMIT = 200

export function inactiveTagName(days: number): string {
  return `${days} 天沒互動`
}

/** tagId 的行程內快取：摘標走在收訊熱路徑上，不能每則訊息都查一次 tags */
const tagIdCache = new Map<string, { tagId: string | null; cachedAt: number }>()
const TAG_ID_CACHE_TTL_MS = 5 * 60_000

export function _clearInactiveTagCacheForTest() {
  tagIdCache.clear()
}

/**
 * 找這個工作區的「沒互動」系統標籤。create=true 時不存在就建（只有每日掃描這麼做；
 * 摘標路徑不建——沒有標籤就沒有東西可摘，建了反而是熱路徑上的多餘寫入）。
 */
export async function resolveInactiveTagId(
  db: Firestore,
  workspaceId: string,
  opts: { createWithDays?: number } = {},
): Promise<string | null> {
  const cached = tagIdCache.get(workspaceId)
  if (cached && Date.now() - cached.cachedAt < TAG_ID_CACHE_TTL_MS && (cached.tagId || !opts.createWithDays)) {
    return cached.tagId
  }

  const snap = await db.collection('tags')
    .where('workspaceId', '==', workspaceId)
    .where('code', '==', INACTIVE_TAG_CODE)
    .limit(1)
    .get()

  let tagId: string | null = snap.docs[0]?.id ?? null

  if (!tagId && opts.createWithDays) {
    const id = uuidv4()
    const doc: TagDoc = {
      workspaceId,
      code: INACTIVE_TAG_CODE,
      name: inactiveTagName(opts.createWithDays),
      category: 'behavior',
      color: '#8a95a1',
      description: '系統自動維護：超過設定天數沒來訊的客人會被貼上，一回來就自動摘掉。天數在 AI 設定頁調整。',
      status: 'active',
      createdBy: 'system',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }
    await db.collection('tags').doc(id).set(doc)
    tagId = id
  }
  else if (tagId && opts.createWithDays) {
    // 天數改了 → 名稱跟上（名稱是「60 天沒互動」這種含天數的字，不改會騙人）。
    // 只在每日掃描時比對一次，平常路徑不讀不寫。
    const currentName = snap.docs[0]!.data()?.name
    const expected = inactiveTagName(opts.createWithDays)
    if (currentName !== expected) {
      await db.collection('tags').doc(tagId).update({ name: expected, updatedAt: FieldValue.serverTimestamp() })
    }
  }

  tagIdCache.set(workspaceId, { tagId, cachedAt: Date.now() })
  return tagId
}

/** 掃描窗口：[cutoff - CATCHUP_DAYS, cutoff)。抽出來給測試釘行為 */
export function inactiveWindow(nowMs: number, days: number): { startMs: number; endMs: number } {
  const endMs = nowMs - days * DAY_MS
  return { startMs: endMs - CATCHUP_DAYS * DAY_MS, endMs }
}

/**
 * 回訊摘標：客人來訊、而且上一次來訊已超過 N 天 → 摘掉「沒互動」標籤。
 *
 * 掛在 ensureConversationSession 的慢路徑（交易之後）：
 * - prevInboundMs 用交易裡讀到的**舊值**，常態路徑零額外讀取、零額外延遲
 *   （沒超過門檻時第一個 if 就返回了）。
 * - 回來的客人一定走慢路徑（60 天沒訊息＝快取早就沒了），所以不會漏在快路徑。
 * - 貼圖/圖片路徑存訊息與這裡是並行的，可能讀到剛更新的時間而誤判「沒超過」——
 *   那筆由每日修復掃描兜底，最多晚一天摘。
 *
 * ⛔ 這裡在收訊熱路徑上，任何失敗都只能記 log，不准把訊息處理弄掛。
 */
export async function clearInactiveTagOnReturn(
  db: Firestore,
  workspaceId: string,
  convDocId: string,
  prevInboundMs: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    if (!prevInboundMs) return false
    const settings = await getAiSettings(workspaceId, db)
    if (!settings.inactiveTag?.enabled) return false
    if (nowMs - prevInboundMs < settings.inactiveTag.days * DAY_MS) return false

    const tagId = await resolveInactiveTagId(db, workspaceId)
    if (!tagId) return false

    const { removed } = await removeTagsFromUser(convDocId, [tagId], 'system', 'inactive-tag:return', workspaceId)
    return removed.length > 0
  }
  catch (e) {
    console.warn('[inactive-tag] clear on return failed:', e)
    return false
  }
}

/**
 * 每日掃描（掛 cron/run-tasks，10 分鐘一輪但每工作區每天只真跑一次）。
 * 回傳統計給排程紀錄看。
 */
export async function scanInactiveTag(db: Firestore): Promise<{
  workspaces: number
  tagged: number
  repaired: number
}> {
  const today = taipeiDate()
  const nowMs = Date.now()
  const stats = { workspaces: 0, tagged: 0, repaired: 0 }

  // 工作區數量是個位數～十位數等級，整包列舉沒有讀取費問題（其他 cron 任務同款）
  const wsSnap = await db.collection('workspaces').select().get()

  for (const wsDoc of wsSnap.docs) {
    const workspaceId = wsDoc.id
    try {
      const settings = await getAiSettings(workspaceId, db)
      if (!settings.inactiveTag?.enabled) continue

      const stateRef = db.collection('cronState').doc(`inactive-tag-${workspaceId}`)
      const state = (await stateRef.get()).data() as { lastRunDay?: string; repairCursor?: string | null } | undefined
      if (state?.lastRunDay === today) continue // 今天掃過了

      stats.workspaces += 1
      const days = settings.inactiveTag.days
      const tagId = await resolveInactiveTagId(db, workspaceId, { createWithDays: days })
      if (!tagId) continue

      // ── 1. 窗口內的沉默客貼標 ──────────────────────────────
      const { startMs, endMs } = inactiveWindow(nowMs, days)
      const convSnap = await db.collection('conversations')
        .where('workspaceId', '==', workspaceId)
        .where('lastInboundMessageAt', '>=', Timestamp.fromMillis(startMs))
        .where('lastInboundMessageAt', '<', Timestamp.fromMillis(endMs))
        .orderBy('lastInboundMessageAt')
        .limit(SCAN_LIMIT)
        .select() // 只要 doc id（＝users 主鍵），內容一個欄位都不用讀
        .get()

      for (const conv of convSnap.docs) {
        // addTagsToUser 冪等（已貼過自動 skip）＋寫 tagLogs；一位一位貼，
        // 單筆失敗不連坐整批
        const { added } = await addTagsToUser(conv.id, [tagId], 'system', 'inactive-tag:scan', workspaceId)
          .catch((e) => {
            console.warn('[inactive-tag] tag failed:', conv.id, e)
            return { added: [] as string[] }
          })
        stats.tagged += added.length
      }

      // ── 2. 修復掃描：已貼標的輪一批，回來過的補摘 ──────────
      // （機制 2 在貼圖/並行路徑可能漏摘，見檔頭。游標輪轉，掃到底歸零重來）
      let repairQ = db.collection('userTags')
        .where('workspaceId', '==', workspaceId)
        .where('tagId', '==', tagId)
        .orderBy('__name__')
        .limit(REPAIR_LIMIT)
      if (state?.repairCursor) {
        repairQ = repairQ.startAfter(db.collection('userTags').doc(state.repairCursor))
      }
      const tagSnap = await repairQ.get()

      let repairCursor: string | null = null
      if (tagSnap.size === REPAIR_LIMIT) repairCursor = tagSnap.docs[tagSnap.size - 1]!.id

      if (!tagSnap.empty) {
        // userTags.userId 與 conversations 主鍵同值（{wid}_{lineUserId}），getAll 一次批讀
        const convRefs = tagSnap.docs.map(d =>
          db.collection('conversations').doc(String(d.data()?.userId ?? '')))
        const convs = await db.getAll(...convRefs)
        const cutoffMs = nowMs - days * DAY_MS
        for (const conv of convs) {
          const lastInboundMs = (conv.data()?.lastInboundMessageAt as Timestamp | undefined)?.toMillis?.() ?? 0
          if (lastInboundMs && lastInboundMs >= cutoffMs) {
            const { removed } = await removeTagsFromUser(conv.id, [tagId], 'system', 'inactive-tag:repair', workspaceId)
              .catch((e) => {
                console.warn('[inactive-tag] repair failed:', conv.id, e)
                return { removed: [] as string[] }
              })
            stats.repaired += removed.length
          }
        }
      }

      await stateRef.set({
        lastRunDay: today,
        repairCursor,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }
    catch (e) {
      console.warn('[inactive-tag] workspace scan failed:', workspaceId, e)
    }
  }

  return stats
}
