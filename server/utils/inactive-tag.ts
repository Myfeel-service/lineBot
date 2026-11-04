/**
 * 「N 天沒互動」自動標籤（CRM 分眾，CRM-EVAL-20260822 P1）。
 *
 * 為什麼做成標籤：全系統能拿來挑推播名單的只有標籤一種（BroadcastAudienceSource 四種
 * 來源裡會自己更新的只有 tags），所以「沉睡客」做成標籤＝推播端零改動就能選出
 * 「60 天沒講過話的人」發喚醒訊息。
 *
 * 「沒互動」看的是 `lastPeerActivityAt`＝客人最後一次**有動作**：傳訊息，或按選單／按鈕。
 * `D-154`（2026-10-28 老闆拍板）以前看 `lastInboundMessageAt`（只算傳訊息）——天天按選單、
 * 從不打字的客人也被貼成「60 天沒互動」，按一下模組按鈕摘掉、過幾天又被貼回去。
 *
 * 三個機制（都在這一檔）：
 *   1. 每日掃描貼標（scanInactiveTag，掛 cron/run-tasks）：把「lastPeerActivityAt 落在
 *      窗口內」的客人貼上系統標籤。窗口＝[cutoff-7天, cutoff)，**不是敞開到 epoch**——
 *      ①避免每天重掃整批老對話（08-11 讀取費暴衝的教訓）②**刻意不回填**（同紅點那次的鐵律）：
 *      功能開始之前就已經沉默很久的老客不貼，避免部署當下整排客人同時被貼標。
 *      `D-154` 換欄位時同樣不回填：上線那天只多貼「剛好落在窗口裡」的那幾天。
 *   2. 回訊摘標（clearInactiveTagOnReturn，掛 ensureConversationSession 慢路徑）：
 *      沉睡的客人一傳訊息或按模組按鈕就把標籤摘掉——摘標判斷用的是交易裡**本來就讀了**的
 *      對話文件（舊的 lastPeerActivityAt），常態路徑零額外讀取。
 *   3. 每日修復掃描（併在 scanInactiveTag）：兩種情況機制 2 摘不到——①貼圖/圖片路徑存訊息與
 *      開會話是並行的，可能讀到已更新的時間 ②純切換選單分頁不開會話（見 handler.ts
 *      isPureMenuSwitch），只更新 lastPeerActivityAt。每天輪掃一小批已貼標的客人對帳，
 *      漏網的隔天自動修復。游標輪轉、每輪上限，不整批掃。
 *
 * ⚠️ 天數門檻與開關在 aiSettings.inactiveTag（預設開、60 天）。
 * ⚠️ 用的是對話列表那支本來就有的複合索引 conversations (workspaceId ASC, lastPeerActivityAt DESC)
 *    ——所以掃描照新到舊排；⛔ 改成由舊到新要另開一個 ASC 索引（兩個專案各部署一次）。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { getAiSettings } from './ai-settings'
import { findOrCreateSystemTag } from './system-tag'
import { addTagsToUser, removeTagsFromUser } from './tagging'
import { taipeiDate } from '~~/shared/time'
import type { TagDoc } from '~~/shared/types/tag-broadcast'

/** 系統標籤的固定 code（同 workspace 唯一）；名稱由天數組出來，天數改了名稱跟著改 */
export const INACTIVE_TAG_CODE = 'sys_inactive'

const DAY_MS = 86_400_000
/** 掃描窗口往回補幾天：排程漏跑（部署、Scheduler 抖動）最多這幾天內都追得回來 */
const CATCHUP_DAYS = 7
/** 每工作區每天最多看幾位窗口裡的客人（每日窗口的量本來就小） */
const SCAN_LIMIT = 300
/** 每日修復掃描一輪最多對帳幾筆已貼標紀錄 */
const REPAIR_LIMIT = 200

/*
 * ── `E-49`（2026-11-04）：半夜這件從 5 分鐘拖到 35 分鐘、同一個帳號同時跑好幾份 ──
 * 以前一位一位 `await`（每位跨海讀＋寫），MYFEEL 一次要 5 分鐘；run-tasks 每 10 分鐘一輪、
 * 而「今天做完了」要整個帳號做完才寫，沒做完之前每一輪都從頭再掃一份，幾份互相拖慢。
 * 改成三件事：
 *   ① 開工前在 cronState 插「我在做」的牌子（leaseUntil），別輪看到就跳過這個帳號
 *   ② 先一次批讀「誰已經貼過」，只對還沒貼的人一次 BATCH 位同時貼／摘
 *   ③ 一輪最多做 RUN_BUDGET_MS，做不完記下做到哪（progress），下一輪接著做、不從頭來
 */
/** 一次同時處理幾位客人 */
const BATCH = 20
/**
 * 同時做幾個帳號。每個帳號光是讀設定、插牌子、查窗口、批讀、修復就要十來趟往返——
 * 2026-11-04 對正式資料乾跑（台北連美國）一個帳號 2～4.5 秒：一個一個做 3 個就用完一輪的預算，
 * 一次 5 個 10 個帳號要 15 秒。現在 10 個帳號＝全部同時開始；帳號變多才會排隊
 */
const WS_CONCURRENCY = 10
/**
 * 一輪最多做多久。run-tasks 26 件同時跑，閘道約 28 秒就切斷回 504——
 * 這件要遠低於那條線，超過就記下做到哪、10 分鐘後下一輪接著做。
 */
const RUN_BUDGET_MS = 15_000
/**
 * 「我在做」的牌子多久沒收回就當那一輪死掉了：比一輪預算長很多（正常一定會收回），
 * 又比排程間隔 10 分鐘短——死掉的那輪，下一輪就能從記下的地方接手。
 */
const LEASE_MS = 5 * 60_000
/** getAll 一次批讀幾筆（太大一包會撞單次請求上限，切幾包同時送） */
const GET_ALL_SLICE = 100

/** cronState/inactive-tag-{workspaceId} */
interface InactiveTagState {
  lastRunDay?: string
  repairCursor?: string | null
  /** 「我在做」的牌子：這個時間（ms）之前別輪不碰這個帳號；做完或暫停都收回成 0 */
  leaseUntil?: number
  /**
   * 今天做到一半（③）。`day` 不是今天就當沒有，從頭來。
   * - phase：還在貼標（scan）或已經到修復掃描（repair）
   * - cursorMs：貼標接著從「最後一次有動作 < 這個時間」的人往下看（null＝從窗口最新的開始）
   * - left：今天這頁（SCAN_LIMIT 位）還剩幾位沒看
   * - ticks：今天用了幾輪（上線後拿來驗：正常是 1）
   */
  progress?: InactiveTagProgress | null
}
interface InactiveTagProgress {
  day: string
  phase: 'scan' | 'repair'
  cursorMs: number | null
  left: number
  ticks: number
}

export function inactiveTagName(days: number): string {
  return `${days} 天沒互動`
}

/** 標籤管理頁看得到的說明 */
export const INACTIVE_TAG_DESCRIPTION = '系統自動維護：超過設定天數沒傳訊息、也沒按選單或按鈕的客人會被貼上，客人回來就自動摘掉。天數在 AI 設定頁調整。'
/**
 * `D-154` 以前的說明（只算傳訊息）。每日掃描看到標籤還是這句就換成新的；
 * ⛔ 只換一字不差的舊句——店家自己改過的說明不動。
 */
const LEGACY_INACTIVE_TAG_DESCRIPTION = '系統自動維護：超過設定天數沒來訊的客人會被貼上，一回來就自動摘掉。天數在 AI 設定頁調整。'

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

  // 找與建共用 `system-tag.ts`（固定 id＋create，同時建也只會有一顆）
  const days = opts.createWithDays
  const { tagId, existing } = await findOrCreateSystemTag(db, workspaceId, INACTIVE_TAG_CODE, days
    ? (): TagDoc => ({
        workspaceId,
        code: INACTIVE_TAG_CODE,
        name: inactiveTagName(days),
        category: 'behavior',
        color: '#8a95a1',
        description: INACTIVE_TAG_DESCRIPTION,
        status: 'active',
        createdBy: 'system',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
    : undefined)

  if (tagId && existing && opts.createWithDays) {
    // 天數改了 → 名稱跟上（名稱是「60 天沒互動」這種含天數的字，不改會騙人）；
    // 說明還是 `D-154` 以前的舊句 → 換成新的。只在每日掃描時比對一次，平常路徑不讀不寫。
    const current = existing
    const patch: Record<string, unknown> = {}
    const expected = inactiveTagName(opts.createWithDays)
    if (current?.name !== expected) patch.name = expected
    if (current?.description === LEGACY_INACTIVE_TAG_DESCRIPTION) patch.description = INACTIVE_TAG_DESCRIPTION
    if (Object.keys(patch).length) {
      await db.collection('tags').doc(tagId).update({ ...patch, updatedAt: FieldValue.serverTimestamp() })
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
 * 回訊摘標：客人傳訊息或按模組按鈕、而且上一次有動作已超過 N 天 → 摘掉「沒互動」標籤。
 *
 * 掛在 ensureConversationSession 的慢路徑（交易之後）：
 * - prevActivityMs 用交易裡讀到的**舊值**（lastPeerActivityAt），常態路徑零額外讀取、零額外延遲
 *   （沒超過門檻時第一個 if 就返回了）。
 * - 回來的客人一定走慢路徑（60 天沒動靜＝快取早就沒了），所以不會漏在快路徑。
 * - 貼圖/圖片路徑存訊息與這裡是並行的，可能讀到剛更新的時間而誤判「沒超過」——
 *   那筆由每日修復掃描兜底，最多晚一天摘。純切換選單不走這裡，也由修復掃描摘。
 *
 * ⛔ 這裡在收訊熱路徑上，任何失敗都只能記 log，不准把訊息處理弄掛。
 */
export async function clearInactiveTagOnReturn(
  db: Firestore,
  workspaceId: string,
  convDocId: string,
  prevActivityMs: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    if (!prevActivityMs) return false
    const settings = await getAiSettings(workspaceId, db)
    if (!settings.inactiveTag?.enabled) return false
    if (nowMs - prevActivityMs < settings.inactiveTag.days * DAY_MS) return false

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

/** db.getAll 切幾包同時送（見 GET_ALL_SLICE） */
async function getAllInSlices(db: Firestore, refs: FirebaseFirestore.DocumentReference[]) {
  const slices: FirebaseFirestore.DocumentReference[][] = []
  for (let i = 0; i < refs.length; i += GET_ALL_SLICE) slices.push(refs.slice(i, i + GET_ALL_SLICE))
  return (await Promise.all(slices.map(s => db.getAll(...s)))).flat()
}

/**
 * 插「我在做」的牌子（`E-49`①）。交易裡再看一次：別輪剛做完（lastRunDay）或牌子還沒過期 → 不接。
 * 接到了就回今天的狀態（含做到一半的 progress）。
 */
async function claimInactiveScan(
  db: Firestore,
  stateRef: FirebaseFirestore.DocumentReference,
  today: string,
  nowMs: number,
): Promise<{ kind: 'done' } | { kind: 'busy' } | { kind: 'claimed', state: InactiveTagState }> {
  return db.runTransaction(async (tx) => {
    const state = ((await tx.get(stateRef)).data() ?? {}) as InactiveTagState
    if (state.lastRunDay === today) return { kind: 'done' as const }
    if ((state.leaseUntil ?? 0) > nowMs) return { kind: 'busy' as const }
    tx.set(stateRef, { leaseUntil: nowMs + LEASE_MS }, { merge: true })
    return { kind: 'claimed' as const, state }
  })
}

/**
 * 每日掃描（掛 cron/run-tasks，10 分鐘一輪但每工作區每天只真跑一次）。
 * 回傳統計給排程紀錄看：busy＝別輪正在做所以跳過、paused＝這輪時間到、記下做到哪。
 *
 * `clock` 只給測試用（推時間看「時間到」那條路）。
 */
export async function scanInactiveTag(
  db: Firestore,
  opts: { clock?: () => number } = {},
): Promise<{
  workspaces: number
  tagged: number
  repaired: number
  busy: number
  paused: number
}> {
  const clock = opts.clock ?? Date.now
  const deadline = clock() + RUN_BUDGET_MS
  const today = taipeiDate(new Date(clock()))
  const stats = { workspaces: 0, tagged: 0, repaired: 0, busy: 0, paused: 0 }

  // 工作區數量是個位數～十位數等級，整包列舉沒有讀取費問題（其他 cron 任務同款）
  const wsSnap = await db.collection('workspaces').select().get()
  const queue = wsSnap.docs.map(d => d.id)

  // WS_CONCURRENCY 個工人輪流從佇列拿帳號
  const worker = async () => {
    for (let workspaceId = queue.shift(); workspaceId; workspaceId = queue.shift()) {
      try {
        const settings = await getAiSettings(workspaceId, db)
        if (!settings.inactiveTag?.enabled) continue

        const stateRef = db.collection('cronState').doc(`inactive-tag-${workspaceId}`)
        // 常態（今天做完了）只有這一次讀，不開交易
        const pre = (await stateRef.get()).data() as InactiveTagState | undefined
        if (pre?.lastRunDay === today) continue
        // 時間到了就別再接新帳號（剩下的下一輪做；沒插牌子＝不會擋到別人）
        if (clock() >= deadline) return

        const claim = await claimInactiveScan(db, stateRef, today, clock())
        if (claim.kind === 'done') continue
        if (claim.kind === 'busy') {
          stats.busy += 1
          continue
        }

        stats.workspaces += 1
        const out = await scanOneWorkspace(db, {
          workspaceId,
          days: settings.inactiveTag.days,
          state: claim.state,
          stateRef,
          today,
          clock,
          deadline,
        })
        stats.tagged += out.tagged
        stats.repaired += out.repaired
        if (out.paused) stats.paused += 1
      }
      catch (e) {
        // 牌子不收回：5 分鐘後自己過期，下一輪（10 分鐘後）從記下的地方接手
        console.warn('[inactive-tag] workspace scan failed:', workspaceId, e)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(WS_CONCURRENCY, queue.length) }, worker))

  return stats
}

async function scanOneWorkspace(db: Firestore, ctx: {
  workspaceId: string
  days: number
  state: InactiveTagState
  stateRef: FirebaseFirestore.DocumentReference
  today: string
  clock: () => number
  deadline: number
}): Promise<{ tagged: number, repaired: number, paused: boolean }> {
  const { workspaceId, days, state, stateRef, today, clock, deadline } = ctx
  let tagged = 0
  let repaired = 0

  const tagId = await resolveInactiveTagId(db, workspaceId, { createWithDays: days })
  if (!tagId) {
    await stateRef.set({ leaseUntil: 0 }, { merge: true })
    return { tagged, repaired, paused: false }
  }

  const progress: InactiveTagProgress = state.progress?.day === today
    ? { ...state.progress, ticks: (state.progress.ticks ?? 0) + 1 }
    : { day: today, phase: 'scan', cursorMs: null, left: SCAN_LIMIT, ticks: 1 }
  const nowMs = clock()

  /** 時間到：記下做到哪、收回牌子，下一輪接著做 */
  const pause = async () => {
    await stateRef.set({ leaseUntil: 0, progress, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { tagged, repaired, paused: true }
  }

  // ── 1. 窗口內的沉默客貼標 ──────────────────────────────
  if (progress.phase === 'scan') {
    const { startMs, endMs } = inactiveWindow(nowMs, days)
    const upperMs = progress.cursorMs == null ? endMs : Math.min(endMs, progress.cursorMs)
    // 新到舊＝吃現成的 DESC 索引（見檔頭）。窗口 7 天、一天的量遠小於 SCAN_LIMIT，
    // 照新到舊每個人在進窗口的那天就會被貼到
    const convSnap = progress.left > 0
      ? await db.collection('conversations')
        .where('workspaceId', '==', workspaceId)
        .where('lastPeerActivityAt', '>=', Timestamp.fromMillis(startMs))
        .where('lastPeerActivityAt', '<', Timestamp.fromMillis(upperMs))
        .orderBy('lastPeerActivityAt', 'desc')
        .limit(progress.left)
        .select('lastPeerActivityAt') // doc id＝users 主鍵；時間拿來記「做到哪」
        .get()
      : null
    const page = (convSnap?.docs ?? []).map(d => ({
      id: d.id,
      ms: (d.get('lastPeerActivityAt') as Timestamp | undefined)?.toMillis?.() ?? 0,
    }))

    // ② 先一次批讀誰已經貼過（userTags 主鍵＝{users 主鍵}_{tagId}）。
    // ⛔ 已經貼過的不能再丟進 addTagsToUser：'system' 算客人訊號，它會把「被判到幾次」+1——
    //    窗口 7 天，同一個人以前每晚被重掃一次就多算一次，而且每位都多一次寫入
    const tagSnaps = await getAllInSlices(db, page.map(c => db.collection('userTags').doc(`${c.id}_${tagId}`)))
    const todo = page.map((c, i) => ({ ...c, i })).filter((_, i) => !tagSnaps[i]?.exists)

    for (let k = 0; k < todo.length; k += BATCH) {
      if (clock() >= deadline) {
        // 這頁 todo[k] 之前的都看過了（已貼過的、這輪貼上的）。
        // 游標＝它的時間 +1ms 且用「<」：跟它同一毫秒的人也會再看到，不漏（貼標冪等，重看無妨）
        const next = todo[k]!
        progress.cursorMs = next.ms + 1
        progress.left -= next.i
        return pause()
      }
      const chunk = todo.slice(k, k + BATCH)
      const results = await Promise.all(chunk.map(c =>
        addTagsToUser(c.id, [tagId], 'system', 'inactive-tag:scan', workspaceId).catch((e) => {
          // 單筆失敗不連坐整批；明天窗口還會再看到他
          console.warn('[inactive-tag] tag failed:', c.id, e)
          return { added: [] as string[] }
        })))
      for (const r of results) tagged += r.added.length
    }

    progress.phase = 'repair'
    progress.cursorMs = null
    progress.left = 0
    if (clock() >= deadline) return pause()
  }

  // ── 2. 修復掃描：已貼標的輪一批，回來過的補摘 ──────────
  // （機制 2 在貼圖/並行路徑、純切換選單摘不到，見檔頭。游標輪轉，掃到底歸零重來）
  // 中途時間到不動 repairCursor：下一輪從同一個地方再拿一頁（已摘掉的不會再出現，不漏也不重摘）
  let repairQ = db.collection('userTags')
    .where('workspaceId', '==', workspaceId)
    .where('tagId', '==', tagId)
    .orderBy('__name__')
    .limit(REPAIR_LIMIT)
  if (state.repairCursor) {
    repairQ = repairQ.startAfter(db.collection('userTags').doc(state.repairCursor))
  }
  const tagSnap = await repairQ.get()

  let repairCursor: string | null = null
  if (tagSnap.size === REPAIR_LIMIT) repairCursor = tagSnap.docs[tagSnap.size - 1]!.id

  if (!tagSnap.empty) {
    // userTags.userId 與 conversations 主鍵同值（{wid}_{lineUserId}），getAll 批讀
    const convs = await getAllInSlices(db, tagSnap.docs.map(d =>
      db.collection('conversations').doc(String(d.data()?.userId ?? ''))))
    const cutoffMs = nowMs - days * DAY_MS
    const back = convs.filter((conv) => {
      const lastActivityMs = (conv.data()?.lastPeerActivityAt as Timestamp | undefined)?.toMillis?.() ?? 0
      return lastActivityMs && lastActivityMs >= cutoffMs
    })
    for (let k = 0; k < back.length; k += BATCH) {
      if (clock() >= deadline) return pause()
      const results = await Promise.all(back.slice(k, k + BATCH).map(conv =>
        removeTagsFromUser(conv.id, [tagId], 'system', 'inactive-tag:repair', workspaceId).catch((e) => {
          console.warn('[inactive-tag] repair failed:', conv.id, e)
          return { removed: [] as string[] }
        })))
      for (const r of results) repaired += r.removed.length
    }
  }

  await stateRef.set({
    lastRunDay: today,
    repairCursor,
    leaseUntil: 0,
    progress: null,
    lastRunTicks: progress.ticks,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
  return { tagged, repaired, paused: false }
}
