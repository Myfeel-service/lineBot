import type { Firestore, Timestamp } from 'firebase-admin/firestore'
import type { WorkspaceAlertId, WorkspaceAlertItem } from '~~/shared/types/alerts'
import { getAiSettings } from './ai-settings'
import { cleanReason, humanizeHours } from './alert-format'
import { KNOWLEDGE_CHUNKS_COLLECTION } from './ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from './ai-knowledge-sources'
import { KNOWLEDGE_SUGGESTIONS_COLLECTION } from './ai-knowledge-suggest'
import { AI_FEEDBACK_EVENTS_COLLECTION, aggregateWrongAnswerMarks, isChunkUnfixedSinceMark } from './ai-feedback-events'
import { getQuotaAnswered } from './ai-usage'
import { findBrokenModuleRefs } from './broken-module-refs'
import { CLAIM_PUSH_MARK_ALERT_WINDOW_MS, readClaimPushMarkFailure } from './claim-push-health'
import { countOpenQueueSessions, isOpenQueueSession } from './conversation-queue'
import { buildPlanView, getWorkspaceSubscription } from './billing'
import { capMapSize } from './bounded-cache'
import { getLineWorkspaceCredentials } from './line-workspace-credentials'
import { fetchLineWebhookEndpoint, normalizeWebhookCompareUrl } from './line-webhook-remote'
import { collectLiffEndpointChecks } from './liff-endpoint-remote'
import { isUrlReachable } from './url-reachable'
import { PAYMENT_ORDERS_COLLECTION } from './payment'
import { derivePlanState } from '~~/shared/billing/plan-state'
import { HUMAN_STALE_HOURS } from '~~/shared/types/conversation-stats'

/**
 * 工作區「目前異常」的訊號收集核心。
 *
 * 從 /api/admin/alerts 抽出來共用：單一工作區的小幫手面板、組織頁的跨工作區彙總
 * 都走同一套 probe——嚴重度與文案的口徑只有一份（前端註冊表），訊號的口徑也只有這一份。
 *
 * 設計原則（同 setup-status）：
 *   1. 每個訊號各自 try/catch —— 單一查詢失敗只讓該項變 unknown，不會整批壞掉，
 *      也不會把「查不到」誤報成「沒問題」（這比誤報更危險：使用者會以為都好了）。
 *   2. 這裡只判定「有沒有」，不決定嚴重度與文案 —— 那些在前端註冊表，
 *      改文案不用動後端。
 *   3. 按權限只查看得到的東西：帳單/連線類需要 canSettings，營運類需要 canOperate。
 *      看不到的項目直接不回，前端註冊表也會依權限過濾，兩邊一致。
 */

/**
 * 掃描上限：這是彙總訊號不是報表，看到幾筆就講幾筆，超過不影響「有異常」的結論。
 *
 * 這套 probe 會被輪詢，所以每個查詢都刻意收窄成「只撈出問題的那幾筆」——健康的工作區
 * 查回來是 0 筆，成本趨近於零。不要為了省一個索引改成整批撈回來自己過濾：
 * 那會變成每次輪詢都讀幾百筆文件。
 */
const PROBLEM_SCAN_LIMIT = 20
const SESSION_SCAN_LIMIT = 200
/** 缺索引時的退路上限（見 knowledgeOutdated） */
const FALLBACK_SCAN_LIMIT = 300
const LLM_ERROR_SCAN_LIMIT = 50
/** 「AI 答錯了」標記的回看窗口與掃描上限（與知識庫工作台同一把尺，見 health.get.ts） */
const WRONG_ANSWER_WINDOW_DAYS = 30
const WRONG_ANSWER_SCAN_LIMIT = 100
/** 被標到的卡逐張點讀的上限（通常個位數；設上限避免異常資料把輪詢拖垮） */
const WRONG_ANSWER_CHUNK_LOOKUP = 30
/** llm_error 只看近 24 小時：Gemini 兩週前抖過一次不該一直掛紅燈 */
const LLM_ERROR_WINDOW_MS = 24 * 3600_000
/** 客人等真人超過此時數才算積壓（幾分鐘的等待是正常客服節奏，不是異常） */
const PENDING_WAIT_ALERT_HOURS = 1

/**
 * 額度「快用完」預測：開期未滿此天數不外推（樣本太少，速度估不準），
 * 用量未達此 % 也不外推（開期初的高速度多半是暫時波動）。寧可晚報，不狼來了。
 */
const QUOTA_FORECAST_MIN_DAYS = 3
const QUOTA_FORECAST_MIN_PERCENT = 40

/** 知識卡 pending 超過 1 小時＝重試已放生或排程沒跑（大批匯入半小時內消化完是正常，不算） */
const KNOWLEDGE_PENDING_STUCK_MS = 60 * 60_000
/** 首期綁卡失敗只看近 45 天：超過一期的舊單多半已用別的方式處理掉了 */
const RENEWAL_BIND_WINDOW_MS = 45 * 24 * 3600_000

/** 推播失敗只看近 3 天：上個月失敗過的推播不該一直掛警示 */
const BROADCAST_FAILED_WINDOW_MS = 3 * 24 * 3600_000
/** 排定時間過了這麼久還沒開始送，才算卡住（排程每分鐘跑，幾分鐘內是正常延遲） */
const BROADCAST_OVERDUE_GRACE_MS = 15 * 60_000
/** 維護排程每 10 分鐘跳一次心跳；超過 60 分鐘沒跳＝連續漏了 6 次，不是抖動 */
const MAINTENANCE_STALE_MS = 60 * 60_000

/**
 * webhook 檢查結果快取：這套 probe 會被輪詢，對 LINE 的外部查詢不該每次都打。
 * webhook 設定不是秒級會變的東西，5 分鐘內回同一個答案。
 */
const WEBHOOK_PROBE_TTL_MS = 5 * 60_000
const WEBHOOK_PROBE_CACHE_MAX = 500

/**
 * webhook 狀態分類。broken 與 mismatch **刻意分成兩顆警示**——不是嚴重度不同
 * （2026-08-08 拍板後兩顆都紅：不一致＝填著排定停用的舊網址，等斷了才紅就晚了），
 * 而是講的話不同：broken＝「已經收不到」，mismatch＝「還能動但快斷了、趁現在改」。
 * 另外 mismatch＋填的網址已連不上會直接折進 broken（那就是真的收不到了）。
 */
type WebhookCheck =
  | { kind: 'unconfigured' } // 還沒接 LINE：是「設定沒做」（setup-status 的事），不是壞掉
  | { kind: 'broken'; detail: string } // 確定收不到：沒設定網址／被停用／權杖失效
  | { kind: 'mismatch'; endpoint: string } // 有設有開，但填的不是 PUBLIC_BASE_URL
  | { kind: 'ok' }
const webhookProbeCache = new Map<string, { result: WebhookCheck; expires: number }>()

/**
 * 問 LINE 目前的 webhook 設定並分類（5 分鐘快取；skipCache＝使用者剛改完設定回頭確認，
 * 一定要真的再問一次，否則五分鐘內都拿到修好前的答案、一直說「還沒好」）。
 * 只打 GET 查設定（便宜、無副作用）；LINE 的 test API 有每小時額度，留給設定頁的手動驗證。
 * 網路抖動等非預期錯誤直接 throw → 兩顆 probe 都變 unknown，不下結論。
 */
async function checkLineWebhook(wid: string, skipCache: boolean): Promise<WebhookCheck> {
  const cached = skipCache ? null : webhookProbeCache.get(wid)
  if (cached && cached.expires > Date.now()) return cached.result

  const { channelAccessToken } = await getLineWorkspaceCredentials(wid)
  const token = channelAccessToken.trim()
  if (!token) return { kind: 'unconfigured' }

  const res = await fetchLineWebhookEndpoint(token)
  let result: WebhookCheck
  if (!res.ok) {
    if (res.status === 401)
      result = { kind: 'broken', detail: 'LINE 存取權杖已失效，需要重新設定' }
    else if (res.status === 404)
      result = { kind: 'broken', detail: 'LINE 後台還沒設定 Webhook 網址' }
    else
      throw new Error(`LINE webhook 查詢失敗 HTTP ${res.status}`)
  }
  else if (!res.data.active) {
    result = { kind: 'broken', detail: 'Webhook 在 LINE 後台被停用了' }
  }
  else {
    // 比對基準＝PUBLIC_BASE_URL（對外正式網址），**不是**「使用者當下瀏覽的網址」——
    // 本機開發、或同一套系統有兩個網域時，request origin 都會對不上，但 webhook 沒壞
    // （第一版拿 request origin 比，在 myfeel 誤報過）。
    // 沒設定對外網址、或設成本機網址就跳過比對：寧可漏抓，不誤報。
    const canonical = String(useRuntimeConfig().appBaseUrl || '').trim().replace(/\/$/, '')
    const comparable = Boolean(canonical) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(canonical)
    const mismatch = comparable
      && normalizeWebhookCompareUrl(res.data.endpoint) !== normalizeWebhookCompareUrl(`${canonical}/webhook`)
    // 「填錯但還能動」黃牌就好；「填錯而且那個網址已經連不上」＝訊息確定送不進來，
    // 要升級成 broken——LINE 的查詢 API 對死掉的網域照樣回「有設定有開啟」，
    // 舊網域一停掉沒有這一戳就會永遠停在黃牌（2026-08-07 換網域盤點時抓到的洞）。
    if (mismatch && !(await isUrlReachable(res.data.endpoint))) {
      result = { kind: 'broken', detail: `LINE 填的網址已連不上（${res.data.endpoint}），訊息送不進來` }
    }
    else {
      result = mismatch ? { kind: 'mismatch', endpoint: res.data.endpoint } : { kind: 'ok' }
    }
  }
  webhookProbeCache.set(wid, { result, expires: Date.now() + WEBHOOK_PROBE_TTL_MS })
  capMapSize(webhookProbeCache, WEBHOOK_PROBE_CACHE_MAX)
  return result
}

type ProbeResult = { active: boolean; count?: number; detail?: string }

/** 把一次判定包成 active/clear；丟錯降級為 unknown（狀態未知，不等於沒問題） */
async function probe(id: WorkspaceAlertId, fn: () => Promise<ProbeResult>): Promise<WorkspaceAlertItem> {
  try {
    const r = await fn()
    return { id, state: r.active ? 'active' : 'clear', count: r.count, detail: r.detail }
  }
  catch (e) {
    console.warn(`[alerts] ${id} 檢查失敗:`, String((e as Error)?.message ?? e).slice(0, 160))
    return { id, state: 'unknown' }
  }
}

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as Timestamp & { seconds?: number, _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

export interface CollectAlertsOptions {
  /** 帳單/連線類訊號（admin 以上，或組織管理員） */
  canSettings: boolean
  /** 營運類訊號（agent 以上） */
  canOperate: boolean
  /**
   * 略過外部查詢的快取（目前只有 LINE webhook 那顆有快取）。
   * 使用者按「重新檢查」、或小幫手要確認「剛剛去修的好了沒」時要帶——
   * 那些情境是人剛改完設定回頭問，拿五分鐘內的舊答案會一直誤報「還沒好」。
   */
  skipCache?: boolean
}

/** 收集單一工作區的所有異常訊號（依權限過濾）。單項失敗＝該項 unknown，不會 throw。 */
export async function collectWorkspaceAlerts(
  db: Firestore,
  wid: string,
  opts: CollectAlertsOptions,
): Promise<WorkspaceAlertItem[]> {
  const { canSettings, canOperate, skipCache = false } = opts

  // AI 設定只讀一次，兩個 probe 共用。
  // 刻意不在這裡 await——一 await 就把後面所有查詢卡在它後面變成序列，
  // 整批多花一個來回。讀失敗回 null，用到的 probe 各自降級成 unknown
  // （不要因為讀不到設定就說「沒問題」）。
  const aiSettingsPromise = canOperate
    ? getAiSettings(wid, db).catch(() => null)
    : null

  const operateProbes: Array<Promise<WorkspaceAlertItem>> = canOperate
    ? [
        probe('knowledgeSyncFailed', async () => {
          // 兩個等值條件走自動索引合併；正常狀況回 0 筆
          const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('status', '==', 'failed')
            .select('name', 'url', 'failureReason')
            .limit(PROBLEM_SCAN_LIMIT)
            .get()
          if (snap.empty) return { active: false }
          // 帶上第一個失敗原因：只說「有 2 個失敗」等於叫使用者自己去猜是哪裡出問題
          const first = snap.docs[0]!.data() as Record<string, unknown>
          const name = String(first.name ?? first.url ?? '(未命名來源)')
          const reason = cleanReason(first.failureReason)
          return {
            active: true,
            count: snap.size,
            detail: reason ? `「${name}」：${reason}` : `「${name}」同步失敗`,
          }
        }),
        probe('knowledgeOutdated', async () => {
          // 快路徑：!= null 會排除「沒有這個欄位」的文件，正好就是「沒偵測到變動」的來源。
          // 需要 (workspaceId ASC, outdatedAt ASC) 複合索引，見 firestore.indexes.json。
          try {
            const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
              .where('workspaceId', '==', wid)
              .where('outdatedAt', '!=', null)
              .select('name')
              .limit(PROBLEM_SCAN_LIMIT)
              .get()
            return snap.empty ? { active: false } : { active: true, count: snap.size }
          }
          catch (e) {
            // 索引還沒部署（新租戶、或索引檔尚未 deploy）就退回整批掃描。
            // 慢路徑會讀較多文件，但總比讓使用者看到一個永遠「檢查不到」的項目——
            // 索引一部署就自動走回快路徑，不必再改程式。
            if (!/FAILED_PRECONDITION|requires an index/i.test(String((e as Error)?.message ?? '')))
              throw e
            console.warn('[alerts] knowledgeOutdated 缺索引，改走全掃描；請部署 firestore.indexes.json')
            const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
              .where('workspaceId', '==', wid)
              .select('outdatedAt')
              .limit(FALLBACK_SCAN_LIMIT)
              .get()
            const n = snap.docs.filter(d => (d.data() as Record<string, unknown>).outdatedAt).length
            return n ? { active: true, count: n } : { active: false }
          }
        }),
        probe('knowledgeIndexFailed', async () => {
          // count() 聚合查詢：兩個等值條件走自動索引合併，不必讀 doc
          const agg = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('status', '==', 'failed')
            .count()
            .get()
          const n = agg.data().count
          return n ? { active: true, count: n } : { active: false }
        }),
        probe('knowledgeWrongAnswers', async () => {
          /**
           * 客服按過「AI 答錯了」、而那張卡至今沒被改過。
           *
           * 判定與知識庫工作台的 wrongAnswerChunks 同一套（標記時間 vs 卡片 updatedAt），
           * 兩邊講的必須是同一件事——小幫手說沒事、工作台卻紅著，正是最傷信任的那種矛盾。
           *
           * 查詢形狀沿用既有的 workspaceId+createdAt 索引（type 在程式裡濾），不必開新索引。
           */
          const snap = await db.collection(AI_FEEDBACK_EVENTS_COLLECTION)
            .where('workspaceId', '==', wid)
            .orderBy('createdAt', 'desc')
            .limit(WRONG_ANSWER_SCAN_LIMIT)
            .get()

          const marksByChunk = aggregateWrongAnswerMarks(
            snap.docs.map((d) => {
              const e = d.data() as { type?: string; chunkIds?: string[]; createdAt?: unknown }
              return { type: e.type, chunkIds: e.chunkIds, createdAtMs: tsToMs(e.createdAt) }
            }),
            Date.now() - WRONG_ANSWER_WINDOW_DAYS * 86_400_000,
          )
          if (!marksByChunk.size) return { active: false }

          // 逐張點讀被標到的卡（通常只有個位數）比掃整個知識庫便宜得多
          const ids = [...marksByChunk.keys()].slice(0, WRONG_ANSWER_CHUNK_LOOKUP)
          const docs = await Promise.all(
            ids.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id).get().catch(() => null)),
          )
          let unfixed = 0
          let firstTitle = ''
          docs.forEach((d, i) => {
            if (!d?.exists) return // 卡被刪掉了＝沒有東西可修
            const c = d.data() as { workspaceId?: string; title?: string; updatedAt?: unknown }
            if (c?.workspaceId !== wid) return
            const mark = marksByChunk.get(ids[i]!)
            if (!mark || !isChunkUnfixedSinceMark(tsToMs(c.updatedAt), mark)) return
            unfixed++
            if (!firstTitle) firstTitle = String(c?.title ?? '')
          })
          if (!unfixed) return { active: false }
          return {
            active: true,
            count: unfixed,
            detail: firstTitle ? `例如「${firstTitle.slice(0, 30)}」` : '',
          }
        }),
        probe('anyTextBlocking', async () => {
          // 設定與規則同時查（先查設定再決定要不要查規則會多一個來回；
          // 這支規則查詢本來就只會回 0～1 筆）
          const [aiSettings, snap] = await Promise.all([
            aiSettingsPromise!,
            db.collection('autoReplies')
              .where('workspaceId', '==', wid)
              .where('matchType', '==', 'anyText')
              .limit(PROBLEM_SCAN_LIMIT)
              .get(),
          ])
          if (!aiSettings) throw new Error('ai settings unavailable')
          // AI 沒開的時候，「輸入任何內容」規則是正常的兜底回覆，不是異常
          if (aiSettings.enabled !== true) return { active: false }
          // isActive 未設視為啟用（與 normalizeAutoReplyRule 同一把尺）
          const active = snap.docs
            .map(d => d.data() as Record<string, unknown>)
            .filter(r => r?.isActive !== false)
          if (!active.length) return { active: false }
          const name = String(active[0]!.name ?? '(未命名規則)')
          return { active: true, count: active.length, detail: `規則「${name}」` }
        }),
        probe('llmError', async () => {
          // 走既有 composite index（workspaceId, aiMeta.lastHandoffReason, aiMeta.updatedAt DESC）
          const snap = await db.collection('conversations')
            .where('workspaceId', '==', wid)
            .where('aiMeta.lastHandoffReason', '==', 'llm_error')
            .orderBy('aiMeta.updatedAt', 'desc')
            .limit(LLM_ERROR_SCAN_LIMIT)
            .get()
          const now = Date.now()
          const cutoff = now - LLM_ERROR_WINDOW_MS
          const recentMs = snap.docs
            .map(d => tsToMs((d.data() as { aiMeta?: { updatedAt?: unknown } }).aiMeta?.updatedAt))
            .filter(ms => ms >= cutoff)
          if (!recentMs.length) return { active: false }
          // 帶「最近一次是多久前」：正在壞和昨晚壞過一次，處理的急迫性完全不同
          const newest = Math.max(...recentMs)
          return {
            active: true,
            count: recentMs.length,
            detail: `最近一次約 ${humanizeHours((now - newest) / 3600_000)}前`,
          }
        }),
        probe('humanBacklog', async () => {
          const sessions = db.collection('conversationSessions').where('workspaceId', '==', wid)
          // 先用 count 聚合探一下（每 1000 筆算一次讀取）。多數工作區這兩個數字是 0，
          // 就不必為了算等待時數把整批 session 文件撈回來——這套 probe 是會被輪詢的。
          const [pendingCount, humanCount] = await Promise.all([
            sessions.where('status', '==', 'pending_human').count().get(),
            sessions.where('status', '==', 'human_handling').count().get(),
          ])
          if (!pendingCount.data().count && !humanCount.data().count)
            return { active: false }

          const [pendingSnap, humanSnap] = await Promise.all([
            pendingCount.data().count
              ? sessions.where('status', '==', 'pending_human')
                  .select('handoffRequestedAt', 'lastActivityAt')
                  .limit(SESSION_SCAN_LIMIT)
                  .get()
              : null,
            humanCount.data().count
              ? sessions.where('status', '==', 'human_handling')
                  .select('humanLastRepliedAt', 'lastActivityAt')
                  .limit(SESSION_SCAN_LIMIT)
                  .get()
              : null,
          ])
          const now = Date.now()
          let waiting = 0
          let oldestH = 0
          for (const d of pendingSnap?.docs ?? []) {
            const s = d.data() as Record<string, unknown>
            const sinceMs = tsToMs(s.handoffRequestedAt) || tsToMs(s.lastActivityAt)
            if (!sinceMs) continue
            const h = (now - sinceMs) / 3600_000
            if (h >= PENDING_WAIT_ALERT_HOURS) {
              waiting++
              oldestH = Math.max(oldestH, h)
            }
          }
          // 「卡在真人處理中」沿用 cron 每日提醒的同一個門檻，兩邊數字才對得起來
          const stale = (humanSnap?.docs ?? []).filter((d) => {
            const s = d.data() as Record<string, unknown>
            const lastMs = tsToMs(s.humanLastRepliedAt) || tsToMs(s.lastActivityAt)
            return lastMs > 0 && now - lastMs >= HUMAN_STALE_HOURS * 3600_000
          }).length

          if (!waiting && !stale) return { active: false }
          const parts: string[] = []
          if (waiting) parts.push(`${waiting} 位客人在等（最久 ${humanizeHours(oldestH)}）`)
          if (stale) parts.push(`${stale} 條卡在「真人處理中」超過 ${HUMAN_STALE_HOURS} 小時`)
          return { active: true, count: waiting + stale, detail: parts.join('、') }
        }),
        probe('firstReplyBacklog', async () => {
          // 「未首接」佇列的口徑完全沿用側欄（countOpenQueueSessions / isOpenQueueSession），
          // 不另立第二份。這顆主要堵草稿模式的黑洞：draft 下 AI 只擬稿不發話、
          // session 不會轉 pending_human——沒人進後台審，客人就一句回覆都沒有；
          // auto 模式下規則沒接住、也沒人理的訊息同樣落在這裡。
          const n = await countOpenQueueSessions(db, wid)
          if (!n) return { active: false }
          const snap = await db.collection('conversationSessions')
            .where('workspaceId', '==', wid)
            .where('status', '==', 'open')
            .select('origin', 'hasInbound', 'lastActivityAt', 'openedAt')
            .limit(SESSION_SCAN_LIMIT)
            .get()
          const now = Date.now()
          let waiting = 0
          let oldestH = 0
          for (const d of snap.docs) {
            const s = d.data() as Record<string, unknown>
            if (!isOpenQueueSession(s)) continue
            // lastActivityAt＝客人最後一則訊息的時間（沒人回的 session 只有客人在動）。
            // 等待時間從「最後一則」起算——比從第一則算保守，但不會誤報成等更久
            const sinceMs = tsToMs(s.lastActivityAt) || tsToMs(s.openedAt)
            if (!sinceMs) continue
            const h = (now - sinceMs) / 3600_000
            if (h >= PENDING_WAIT_ALERT_HOURS) {
              waiting++
              oldestH = Math.max(oldestH, h)
            }
          }
          if (!waiting) return { active: false }
          return { active: true, count: waiting, detail: `最久 ${humanizeHours(oldestH)}沒有人回` }
        }),
        probe('knowledgeIndexStuck', async () => {
          // 卡在 pending＝embedding 一直沒跑完（重試滿 5 次被放生、或排程沒在跑）。
          // 與 knowledgeIndexFailed（明確失敗）根因不同，AI 一樣檢索不到這些卡。
          // 先 count 探一下（多數時候是 0）；有才讀明細比時間
          const agg = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('status', '==', 'pending')
            .count()
            .get()
          if (!agg.data().count) return { active: false }
          const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('status', '==', 'pending')
            .select('updatedAt')
            .limit(SESSION_SCAN_LIMIT)
            .get()
          const cutoff = Date.now() - KNOWLEDGE_PENDING_STUCK_MS
          const stuck = snap.docs.filter((d) => {
            const ms = tsToMs((d.data() as Record<string, unknown>).updatedAt)
            return ms > 0 && ms < cutoff
          }).length
          return stuck ? { active: true, count: stuck } : { active: false }
        }),
        probe('handoffNotifyMissing', async () => {
          const aiSettings = await aiSettingsPromise!
          if (!aiSettings) throw new Error('ai settings unavailable')
          // AI 沒開就不會有 AI 轉真人，這時沒設通知不算異常
          if (aiSettings.enabled !== true) return { active: false }
          const cfg = aiSettings.handoffNotify
          const off = !cfg?.enabled || !(cfg?.lineUserIds?.length)
          return off ? { active: true } : { active: false }
        }),
        probe('claimPushUnmarked', async () => {
          // 一次點讀（cronState 內每工作區一筆）。蓋章成功會自己清掉，所以有值就代表最近真的壞過。
          const st = await readClaimPushMarkFailure(db, wid)
          if (!st) return { active: false }
          if (Date.now() - st.failedAtMs > CLAIM_PUSH_MARK_ALERT_WINDOW_MS) return { active: false }
          return {
            active: true,
            count: st.count,
            detail: st.lastError ? `系統訊息：${cleanReason(st.lastError)}` : undefined,
          }
        }),
        probe('broadcastFailed', async () => {
          // 等值條件走自動索引合併；失敗是稀有事件，limit 20 夠用。
          // 時間窗在記憶體過濾（加 updatedAt 範圍就要新複合索引，兩租戶都得部署，不值得）
          const snap = await db.collection('broadcasts')
            .where('workspaceId', '==', wid)
            .where('status', '==', 'failed')
            .select('name', 'updatedAt')
            .limit(PROBLEM_SCAN_LIMIT)
            .get()
          const cutoff = Date.now() - BROADCAST_FAILED_WINDOW_MS
          const recent = snap.docs
            .map(d => d.data() as Record<string, unknown>)
            .filter(b => tsToMs(b.updatedAt) >= cutoff)
          if (!recent.length) return { active: false }
          const name = String(recent[0]!.name ?? '(未命名推播)')
          return { active: true, count: recent.length, detail: `「${name}」發送失敗` }
        }),
        probe('broadcastOverdue', async () => {
          // 排定佇列本來就小（未送的才會是 scheduled），等值查詢＋記憶體比對時間
          const snap = await db.collection('broadcasts')
            .where('workspaceId', '==', wid)
            .where('status', '==', 'scheduled')
            .select('name', 'scheduleAt')
            .limit(PROBLEM_SCAN_LIMIT)
            .get()
          const now = Date.now()
          const overdue = snap.docs
            .map(d => d.data() as Record<string, unknown>)
            .filter((b) => {
              const at = tsToMs(b.scheduleAt)
              return at > 0 && now - at >= BROADCAST_OVERDUE_GRACE_MS
            })
          if (!overdue.length) return { active: false }
          const first = overdue[0]!
          const late = humanizeHours((now - tsToMs(first.scheduleAt)) / 3600_000)
          return {
            active: true,
            count: overdue.length,
            detail: `「${String(first.name ?? '(未命名推播)')}」排定 ${late}前要送`,
          }
        }),
        probe('knowledgeSuggestions', async () => {
          // 不是異常，是「可以更好」：建議收件匣有幾筆待處理草稿。
          // count() 聚合、兩個等值條件走自動索引，健康時成本趨近於零
          const agg = await db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('status', '==', 'pending')
            .count()
            .get()
          const n = agg.data().count
          return n ? { active: true, count: n } : { active: false }
        }),
        probe('brokenModuleButton', async () => {
          // 靜態檢查，不是統計「誰按到了」：在客人踩到之前就報。
          // 結果有 5 分鐘快取，輪詢不會每次整批讀 flows + richmenus（見 broken-module-refs）
          const broken = await findBrokenModuleRefs(db, wid)
          if (!broken.length) return { active: false }
          const first = broken[0]!
          const KIND_LABEL: Record<string, string> = {
            richmenu: '選單',
            flow: '模組',
            autoReply: '自動回覆規則',
            campaign: '活動',
          }
          const where = KIND_LABEL[first.sourceKind] ?? '模組'
          const why = first.reason === 'missing' ? '模組已被刪除' : '模組已停用'
          return {
            active: true,
            count: broken.length,
            detail: `${where}「${first.sourceLabel}」的按鈕指向的${why}`,
          }
        }),
      ]
    : []

  // 帳單與連線類：需要 canSettings。看不到的項目直接不回（前端註冊表同樣依權限過濾）
  // 訂閱只讀一次，額度與扣款狀態共用（兩支各讀一次等於白花一半的查詢）
  const subPromise = canSettings ? getWorkspaceSubscription(wid, db) : null
  // 本期已答則數也只查一次：「已超量」與「快用完」兩個 probe 共用同一個數
  const answeredPromise = canSettings
    ? subPromise!.then(sub => (sub?.currentPeriodStart ? getQuotaAnswered(wid, sub.currentPeriodStart, db) : 0))
    : null

  // webhook 只問 LINE 一次，「確定收不到」與「網址不一致」兩顆 probe 共用同一個答案
  const webhookCheckPromise = canSettings ? checkLineWebhook(wid, skipCache) : null

  // LIFF endpoint 也只探一次，「到不了活動頁」與「網址不一致」兩顆 probe 共用同一份結果
  // （快取在 liff-endpoint-remote 內、按 liffId 分鍵——同一個 LIFF 被多個工作區用也只探一次）
  const liffChecksPromise = canSettings
    ? collectLiffEndpointChecks(db, wid, {
        canonicalBase: String(useRuntimeConfig().appBaseUrl || ''),
        skipCache,
      })
    : null

  const billingProbes: Array<Promise<WorkspaceAlertItem>> = canSettings
    ? [
        probe('lineWebhookBroken', async () => {
          // 機器人的總開關：webhook 掛了＝所有訊息都進不來，其他異常都無從發生
          const c = await webhookCheckPromise!
          return c.kind === 'broken' ? { active: true, detail: c.detail } : { active: false }
        }),
        probe('lineWebhookUrlMismatch', async () => {
          const c = await webhookCheckPromise!
          return c.kind === 'mismatch'
            ? { active: true, detail: `LINE 後台填的是 ${c.endpoint}` }
            : { active: false }
        }),
        probe('liffEndpointBroken', async () => {
          // 客人點活動連結後根本到不了活動頁（登記指向別的網站、或 LIFF 已被刪）。
          // 與 mismatch 刻意分兩顆：mismatch 只是多繞（舊網域還在線時能收尾），
          // 這顆是確定迷路——同一套「紅牌只留給確定壞掉」的原則（見 webhook 那對）。
          const checks = await liffChecksPromise!
          const bad = checks.filter(c => c.status === 'broken')
          if (!bad.length) {
            // 有查不到的項目時不下「沒問題」的結論——unknown 要現形
            if (checks.some(c => c.status === 'unknown')) throw new Error('有 LIFF 查不到登記狀態')
            return { active: false }
          }
          const first = bad[0]!
          const detail = first.reason === 'deleted'
            ? `LIFF ${first.liffId} 在 LINE 上已不存在`
            : first.reason === 'unreachable'
              ? `LIFF ${first.liffId} 登記的網址已連不上（${first.endpoint}）`
              : `LIFF ${first.liffId} 在 LINE 登記的是 ${first.endpoint}`
          return { active: true, count: bad.length, detail }
        }),
        probe('liffEndpointUrlMismatch', async () => {
          const checks = await liffChecksPromise!
          const bad = checks.filter(c => c.status === 'mismatch')
          if (!bad.length) {
            if (checks.some(c => c.status === 'unknown')) throw new Error('有 LIFF 查不到登記狀態')
            return { active: false }
          }
          const first = bad[0]!
          return {
            active: true,
            count: bad.length,
            detail: `LIFF ${first.liffId} 在 LINE 登記的是 ${first.endpoint}`,
          }
        }),
        probe('quotaExceeded', async () => {
          const [sub, answered] = await Promise.all([subPromise!, answeredPromise!])
          const plan = buildPlanView(sub)
          const usage = derivePlanState(plan, answered)
          if (usage.state !== 'over') return { active: false }
          return {
            active: true,
            count: usage.used,
            detail: usage.limit ? `本期已用 ${usage.used} / ${usage.limit} 則` : undefined,
          }
        }),
        probe('quotaRunningOut', async () => {
          // 提前量：quotaExceeded 亮的時候 AI 已經停了，等於事故通報。這顆在停之前講
          // 「快了」——達近上限門檻（80%，與方案卡 derivePlanState 同一把尺，不另立口徑），
          // 或照最近的速度會在期末前用完。
          const [sub, answered] = await Promise.all([subPromise!, answeredPromise!])
          const plan = buildPlanView(sub)
          const usage = derivePlanState(plan, answered)
          // 沒上限不用管；已超量是 quotaExceeded 的事——兩顆同時亮只會互相稀釋
          if (usage.limit == null || usage.remaining == null || usage.state === 'over')
            return { active: false }
          if (!plan?.currentPeriodStart || !plan.currentPeriodEnd)
            return { active: false }
          const DAY = 86400_000
          const now = Date.now()
          const startMs = Date.parse(`${plan.currentPeriodStart}T00:00:00`)
          const endMs = Date.parse(`${plan.currentPeriodEnd}T23:59:59`)
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || now <= startMs || now >= endMs)
            return { active: false }
          const elapsedDays = (now - startMs) / DAY
          const leftDays = (endMs - now) / DAY
          if (elapsedDays < QUOTA_FORECAST_MIN_DAYS)
            return { active: false }
          const perDay = usage.used / elapsedDays
          const daysToExhaust = perDay > 0 ? usage.remaining / perDay : Infinity
          const nearLimit = usage.state === 'near'
          const willExhaustEarly = usage.percentRaw >= QUOTA_FORECAST_MIN_PERCENT
            && daysToExhaust < leftDays - 1
          if (!nearLimit && !willExhaustEarly)
            return { active: false }
          const parts = [`本期已用 ${usage.used} / ${usage.limit} 則（${usage.percentRaw}%）`]
          if (daysToExhaust < leftDays)
            parts.push(`照最近的速度約 ${Math.max(1, Math.round(daysToExhaust))} 天後用完，本期還有 ${Math.ceil(leftDays)} 天`)
          return { active: true, detail: parts.join('，') }
        }),
        probe('maintenanceStalled', async () => {
          // 背景維護（轉真人提醒、過期回收、資料更新偵測）的心跳，run-tasks 每 10 分鐘寫一次
          // （cronState/maintenance-heartbeat）。同專案內所有工作區共用同一顆心跳——排程死掉
          // 是整個租戶一起死。文件不存在＝還沒部署心跳或本機開發，不下結論也不誤報；
          // 真正要抓的是「跳過、然後停了」。
          const snap = await db.collection('cronState').doc('maintenance-heartbeat').get()
          if (!snap.exists) return { active: false }
          const lastRunAt = Number((snap.data() as Record<string, unknown>)?.lastRunAt ?? 0)
          if (!lastRunAt) return { active: false }
          const ageMs = Date.now() - lastRunAt
          if (ageMs < MAINTENANCE_STALE_MS) return { active: false }
          return {
            active: true,
            detail: `上次執行約 ${humanizeHours(ageMs / 3600_000)}前`,
          }
        }),
        probe('paymentPastDue', async () => {
          const plan = buildPlanView(await subPromise!)
          if (plan?.status !== 'past_due') return { active: false }
          const reason = cleanReason(plan.lastChargeError)
          return { active: true, detail: reason || undefined }
        }),
        probe('renewalNotBound', async () => {
          // 首期收款成功但約定卡沒建成：下期不會自動扣款，會靜默降級（付了錢的客戶
          // 一個月後突然變免費層）。四個等值條件走自動索引合併；cardBound 是新欄位，
          // 等值查詢不匹配缺欄位的舊單——舊資料剛好不誤報。
          const snap = await db.collection(PAYMENT_ORDERS_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('status', '==', 'paid')
            .where('kind', '==', 'period_first')
            .where('cardBound', '==', false)
            .select('createdAt')
            .limit(PROBLEM_SCAN_LIMIT)
            .get()
          const cutoff = Date.now() - RENEWAL_BIND_WINDOW_MS
          const recent = snap.docs.filter((d) => {
            const ms = tsToMs((d.data() as Record<string, unknown>).createdAt)
            return ms >= cutoff
          }).length
          return recent ? { active: true, count: recent } : { active: false }
        }),
        probe('invoiceFailed', async () => {
          const agg = await db.collection(PAYMENT_ORDERS_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('invoiceStatus', '==', 'failed')
            .count()
            .get()
          const n = agg.data().count
          return n ? { active: true, count: n } : { active: false }
        }),
      ]
    : []

  return Promise.all([...operateProbes, ...billingProbes])
}
