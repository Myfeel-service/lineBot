/**
 * 定時維護工作的實作本體（原本散在 server/tasks/* 的 defineTask run() 內）。
 *
 * 抽出來的原因：Amplify（aws-amplify preset）**不會把 Nitro tasks 打包進 compute
 * bundle**，scheduledTasks 與 runTask 在生產環境都不存在——所以這些工作上線以來
 * 從未執行過。改成一般函式後：
 *   - 生產：/api/cron/run-tasks（Cloud Scheduler 每 10 分鐘）呼叫
 *   - 本機 dev：server/tasks/* 仍為薄殼包裝，scheduledTasks 照常運作
 *
 * 所有函式都設計成可安全高頻呼叫：沒到期／沒東西就是便宜的空查詢，
 * 單筆失敗不中斷整批。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import {
  KNOWLEDGE_SOURCES_COLLECTION,
  buildSourceClearFailure,
  clearSourceFailure,
  markSourceOutdated,
} from './ai-knowledge-sources'
import { KNOWLEDGE_CHUNKS_COLLECTION } from './ai-knowledge-chunks'
import { KNOWLEDGE_SUGGESTIONS_COLLECTION } from './ai-knowledge-suggest'
import { tryAutoApplyMinorChange } from './ai-knowledge-autoapply'
import { runWithLlmBudget } from './gemini'
import { extractUrlText } from './ai-source-extractors'
import { syncGoogleSheetSource } from './gsheet-sync'
import { closeConversationSession, handBackSessionToBot } from './conversation-session'
import { getAiSettings } from './ai-settings'
import { buildWeeklyInsights, isTaipeiMonday } from './weekly-insights'
import { notifyHandoffToStaff, notifyOverdueHandoffBatch, wasQuotaExhaustedNotified } from './ai-handoff-notify'
import type { HandoffReason } from '~~/shared/types/ai-knowledge'
import { pushMessage } from './line'
import type { messagingApi } from '@line/bot-sdk'
import { WEBHOOK_EVENT_LOCKS_COLLECTION } from './webhook-dedup'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { daysBetween, isServiceDayOff, isServiceHoursDnd } from '~~/shared/time'
import { taipeiDateKey } from '~~/shared/taipei-day'
import { loadDayStats } from './conversation-stats-rollup'
import { buildDigestLines, taipeiDateLabel } from './daily-digest-message'
import type { DigestWaiting, DigestYesterday } from './daily-digest-message'
import {
  TAIWAN_FESTIVALS,
  festivalReminderText,
  hasFestivalInWindow,
  pickFestivalReminder,
} from '~~/shared/taiwan-festivals'
import { ALERT_LABELS, DIGEST_WARNING_ALERTS, SYSTEM_OWNED_ALERTS, severityOf } from '~~/shared/types/alerts'
import type { WorkspaceAlertItem } from '~~/shared/types/alerts'
import { collectWorkspaceAlerts, countRecentUnboundRenewals } from './workspace-alerts'
import { decideSourceChange, normalizeVolatileNumbers } from '~~/shared/knowledge-fingerprint'
import { BOT_SESSION_MAX_IDLE_DAYS, HUMAN_STALE_HOURS } from '~~/shared/types/conversation-stats'
import type { ConversationStatus } from '~~/shared/types/conversation-stats'
import type { KnowledgeSourceDoc } from '~~/shared/types/ai-knowledge'

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

// ── URL / Google Sheet 來源變動偵測 ─────────────────────────────────────────

const SOURCE_SCAN_LIMIT = 50 // 單次跑最多幾張 source（避免一次塞太多 fetch）
const SOURCE_FETCH_CONCURRENCY = 3

/** 簡單 SHA-256 hash（不引入額外套件）— 用 Node 內建 crypto */
async function sha256(input: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input).digest('hex')
}

interface SourceCheckResult {
  sourceId: string
  outcome: 'unchanged' | 'changed_notified' | 'changed_logged' | 'gsheet_synced' | 'auto_applied' | 'error'
  message?: string
}

/**
 * 單輪排程最多對幾個來源嘗試「小改自動套用」:每次嘗試都要跑一次 LLM 重切卡(10–30s),
 * 多個來源同輪變動時只試前 N 個,其餘照舊標記人工審——保住 10 分鐘輪的時間預算。
 * (變動是 pendingHash 確認過的稀有事件,正常一輪 0–1 個。)
 */
const AUTO_APPLY_BUDGET_PER_RUN = 2

interface DetectRunState {
  autoApplyRemaining: number
}

/** 通知訊息用的來源顯示名稱 */
function sourceTitleOf(data: KnowledgeSourceDoc): string {
  const d = data as unknown as Record<string, unknown>
  return String(d.title || d.name || d.url || '(未命名來源)').slice(0, 80)
}

async function checkOneSource(
  db: Firestore,
  sourceId: string,
  data: KnowledgeSourceDoc,
  run: DetectRunState = { autoApplyRemaining: 0 },
): Promise<SourceCheckResult> {
  try {
    // Google Sheet：自動同步（一列一卡，直接套用新增/更新/刪除，不走人工 resync）。
    // autoApply === false 的來源視為「商家自管」，這支不動它。
    if (data.type === 'gsheet') {
      if (data.gsheetAutoApply === false) return { sourceId, outcome: 'unchanged' }
      // 額度境域（C-45）：補問法 LLM 超額時整段丟 429，走下面 catch 記失敗，不再燒錢
      const r = await runWithLlmBudget(data.workspaceId, () => syncGoogleSheetSource(db, data.workspaceId, sourceId, data))
      // ⛔大量刪除被擋下：不能走「成功」路徑清失敗標記——要讓店家看得到。
      // 寫 failureReason + outdatedAt（體檢紅字 + 有變動提示），等人工到來源頁按
      // 「立即同步」確認放行；同時戳 lastFetchedAt 讓排程下一輪不再空轉重讀同一張表。
      if (r.outcome === 'blocked_mass_deletion') {
        await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
          failureReason: `表格一次少了 ${r.pendingDeletes ?? 0} 列（現有 ${r.kept} 張卡）。為避免誤刪，自動同步已暫停套用；請到知識庫來源頁確認後手動同步。`,
          // ⛔一定要一起寫 status:'failed'：體檢的「資料同步失敗」與小幫手 knowledgeSyncFailed
          // 都只看 status，只寫 failureReason 的話畫面全綠——正好違背這道守門的目的
          //（讓店家看得到「自動同步暫停了，有 N 張卡等你確認」）。
          status: 'failed',
          outdatedAt: FieldValue.serverTimestamp(),
          lastFetchedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }).catch(e => console.warn(`[detect-source-updates] ${sourceId} mark blocked failed:`, e))
        return { sourceId, outcome: 'changed_logged', message: `gsheet 大量刪除已擋下（${r.pendingDeletes} 列）` }
      }
      // 同步成功就清掉失敗標記（連 unchanged 也要清）。少了這段，商家把 Sheet 分享權限
      // 修好、同步其實已經成功，體檢仍永遠顯示「來源同步失敗」——做對了也看不到結果。
      // 注意不能沿用下面 url 分支的 clearFailure：那個變數宣告在本分支的 return 之後。
      await clearSourceFailure(db, sourceId, data.status)
      if (r.outcome === 'unchanged') return { sourceId, outcome: 'unchanged' }
      // 同步成功不推播（2026-08-06 拍板:成功不需要行動,不值一則訊息錢）;
      // 來源頁的最後同步時間/卡片數本來就看得到,這裡留 log 供追查。
      console.log(`[detect-source-updates] gsheet ${sourceId} auto-synced: +${r.added} ~${r.updated} -${r.deleted}`)
      return { sourceId, outcome: 'gsheet_synced', message: `+${r.added} ~${r.updated} -${r.deleted}` }
    }

    if (data.type !== 'url' || !data.url) {
      return { sourceId, outcome: 'unchanged' } // 不該被撈到，保險
    }

    const extracted = await extractUrlText(data.url)
    const newHash = await sha256(extracted.text)
    // 第二道指紋：把數字抹掉之後再算。集資金額／支持人數／倒數天數這類「自己會跑的數字」
    // 在這道指紋上完全不留痕跡，靠它才分得出「頁面真的改了」與「只是計數器又跳了」。
    const newTextHash = await sha256(normalizeVolatileNumbers(extracted.text))

    // 檢查成功：清掉先前的失敗標記（說明見 buildSourceClearFailure）
    const clearFailure = buildSourceClearFailure(data.status)
    const sourceRef = db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId)

    const decision = decideSourceChange(
      {
        contentHash: String(data.contentHash ?? ''),
        textHash: String(data.textHash ?? ''),
        appliedContentHash: String(data.appliedContentHash ?? '').trim(),
        // 舊來源沒有 observedHash → 沿用語意相同的 pendingHash，行為與改版前一致
        observedHash: String(data.observedHash ?? data.pendingHash ?? ''),
        observedTextHash: String(data.observedTextHash ?? ''),
        numericDriftRounds: Number(data.numericDriftRounds ?? 0),
        pendingRounds: Number(data.pendingRounds ?? 0),
      },
      { hash: newHash, textHash: newTextHash },
    )

    // 每一輪都要記下「這次抓到什麼」：下一輪要靠它判斷這個網址的數字是不是本來就會自己跑。
    const observed = {
      observedHash: newHash,
      observedTextHash: newTextHash,
      lastFetchedAt: FieldValue.serverTimestamp(),
    }

    /**
     * 判斷狀態要寫回文件，不能只有 log 知道。
     * `detectStalledAt` = 連續好幾輪抓到的內容都不一樣、系統根本無從確認哪一版才算數
     * ——這種來源以前會無聲無息地永遠停在「等下一輪」，畫面卻顯示一切正常。
     * 時間戳只在第一次卡住時寫，之後保留原值（UI 要講「從什麼時候開始偵測不了」）。
     */
    const detectState = {
      numericDriftRounds: decision.numericDriftRounds,
      pendingRounds: decision.pendingRounds,
      ...(decision.stalled
        ? (data.detectStalledAt ? {} : { detectStalledAt: FieldValue.serverTimestamp() })
        : { detectStalledAt: null }),
    }

    // 首次觀測（匯入時前端沒帶 hash → contentHash 為空）：只存 baseline,不標 outdated。
    // 內容並沒有「變」,只是還沒有比較基準;沒有這個分支的話,每個新 URL 來源
    // 第一次排程必被誤報「偵測到變動」,狼來了幾次使用者就不理警示了。
    if (decision.kind === 'baseline') {
      await sourceRef.update({
        contentHash: newHash,
        textHash: newTextHash,
        ...observed,
        ...detectState,
        ...clearFailure,
      })
      return { sourceId, outcome: 'unchanged' }
    }

    if (decision.kind === 'unchanged') {
      // 逐字相同 → 只更新觀測值。先前若有「待確認新值」代表內容又跳回原樣
      // （輪播/隨機區塊的假變動），一併清掉。
      await sourceRef.update({
        pendingHash: FieldValue.delete(),
        ...observed,
        ...detectState,
        ...clearFailure,
        /**
         * 抹數字指紋在這個分支**無條件重寫**（不是只補空值）：走到這裡代表剛抓到的內容
         * 與現有版本逐字相同，所以這一份必定是正確的基準。
         * 這也是唯一能自動修好它的地方——手動「重新同步」套用時只更新 contentHash
         * （那條路上沒有原文可以算指紋），不在這裡重建的話，兩道指紋會對應到不同版本，
         * 下一次數字一動就會被誤判成「文字改過了」而誤報一次變動。
         */
        textHash: newTextHash,
        /**
         * 舊來源沒有 appliedContentHash（這個欄位比它們晚出生）→ 在這裡順手補上。
         * 只在這個分支補是刻意的：走到這裡代表「網頁與上次觀測相同、且沒有待處理的變動」，
         * 那當下的內容就等於現有卡片對應的版本，這個推論是安全的。
         * 有 outdatedAt（有變動還沒審）時不能補——那時 contentHash 早就跑在卡片前面，
         * 補下去會把真的待審變動變成「沒變」而永遠消失。
         */
        ...(!data.appliedContentHash && !data.outdatedAt ? { appliedContentHash: newHash } : {}),
      })
      return { sourceId, outcome: 'unchanged' }
    }

    /**
     * 與上次觀測不同,但**等於現有卡片對應的那一版**：網頁改過又改回來（或前一次的變動
     * 已經被自動套用/人工審掉了）。這時沒有任何東西要店家決定 → 更新指紋、把「有變動」
     * 提示清掉、不通知。少了這一段,店家會被通知去看一份「未變 0、全是假差異」的 diff。
     */
    if (decision.kind === 'back-to-applied') {
      await sourceRef.update({
        contentHash: newHash,
        textHash: newTextHash,
        pendingHash: FieldValue.delete(),
        outdatedAt: null,
        ...observed,
        ...detectState,
        ...clearFailure,
      })
      return { sourceId, outcome: 'unchanged', message: 'back-to-applied-version' }
    }

    /**
     * 這個網址的數字本來就會自己跑（連續幾輪都是「文字一字未改、只有數字在動」），
     * 這一輪也只有數字在動 → 不是店家做的變動，不提醒。
     * 指紋要跟上最新值，否則下一輪又會判成「跟上次不同」而原地打轉；
     * 但 appliedContentHash **不能**推進——卡片裡的金額確實還是舊的，
     * 手動按「重新同步」時該照實把差異列出來給人看。
     */
    if (decision.kind === 'numeric-drift') {
      await sourceRef.update({
        contentHash: newHash,
        textHash: newTextHash,
        pendingHash: FieldValue.delete(),
        ...observed,
        ...detectState,
        ...clearFailure,
      })
      return { sourceId, outcome: 'unchanged', message: 'numeric-drift（這個網址的數字天天在動）' }
    }

    // 與上次不同：先不算真變——輪播 / 隨機推薦 / 計數器頁面每次抓都不同，一次差異就
    // 通知會狼來了。新值先記下來，**下一輪仍是同一份新內容才確認變動**；
    // 又變成別的則以最新值重新等待。代價：真變動晚一個檢查週期通知。
    if (decision.kind === 'pending') {
      await sourceRef.update({
        pendingHash: newHash,
        ...observed,
        ...detectState,
        ...clearFailure,
        /**
         * 抹數字指紋的**一次性開機**：只在還沒有這一欄時寫（有了就不再動，那是確認過的基準）。
         * 少了這句，早就卡在黑洞裡的來源永遠走不出來——它們正是因為每輪都不同才停在 pending，
         * 而其他會寫指紋的分支它們一個都到不了，於是永遠退回舊的逐字比對、永遠卡著。
         * 代價：以「現在這一版文字」當基準，卡住期間發生過的那次文字變動不會補報
         *（那次本來就已經漏掉了），之後的變動照常偵測得到。
         */
        ...(data.textHash ? {} : { textHash: newTextHash }),
      })
      if (decision.stalled) {
        // 卡住要出聲：這種來源以前會永遠停在這裡，而畫面上看起來一切正常
        console.warn(`[detect-source-updates] ${sourceId} (${data.url}) 連續 ${decision.pendingRounds} 輪抓到的內容都不同，自動偵測失效`)
      }
      return { sourceId, outcome: 'unchanged', message: decision.stalled ? 'detect-stalled（每輪內容都不同）' : 'pending-change（待下一輪確認）' }
    }

    // 變了（連兩輪抓到同一份新內容）：依設定決定行為
    const behavior = data.onChangeBehavior === 'log_only' ? 'log_only' : 'notify'

    // 全文暫存到 subcollection：偵測時已抓過全文，丟掉的話使用者按「套用」還要重抓一次，
    // 而且「偵測時的版本」和「套用時的版本」可能不一致。放 subcollection 避免 source
    // 列表查詢拖著幾百 KB 的內文。
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId)
      .collection('cache').doc('extracted')
      .set({
        text: extracted.text,
        hash: newHash,
        rawLength: extracted.rawLength,
        fetchedAt: FieldValue.serverTimestamp(),
      })
      .catch(e => console.warn(`[detect-source-updates] ${sourceId} cache write failed:`, e))

    /**
     * 提交「這次變動已處理完」。**一定要放在自動套用之後**：
     * 這支跑在 /api/cron/run-tasks 的 Lambda 裡，自動套用要跑 LLM 重切卡＋逐卡 embedding，
     * 是整條流程唯一可能撞閘道逾時的地方。若先寫 contentHash 再跑套用，逾時會讓
     * 「卡片改到一半 + hash 已是新值」永久卡死（下輪比對 unchanged，沒人會再發現）。
     * 保持舊 hash 的話，逾時只是下一輪重跑：已套用的卡在 diff 裡是 unchanged，天然冪等。
     */
    const commitChange = (extra: Record<string, unknown> = {}) =>
      sourceRef.update({
        contentHash: newHash,
        textHash: newTextHash,
        pendingHash: FieldValue.delete(),
        ...observed,
        ...detectState,
        ...clearFailure,
        ...extra,
      })

    if (behavior === 'notify') {
      // 小改自動套用(P2-7):標題精確配對的內容修改(不涉手編卡/無增刪/比例受限/長度未暴跌)
      // 直接更新+摘要通知;結構變化照舊退人工審。每輪有嘗試限額(LLM 重切卡貴且慢)。
      // 型錄來源與明確關閉自動更新的來源在這裡就排除,不佔限額也不花錢跑 LLM。
      const autoEligible = !data.generateOverview && data.urlAutoApply !== false
      if (autoEligible && run.autoApplyRemaining > 0) {
        run.autoApplyRemaining--
        // 額度境域（C-45）：自動套用要先花一次完整重切卡的錢，超額 workspace 直接跳過
        const auto = await runWithLlmBudget(data.workspaceId, () => tryAutoApplyMinorChange(db, sourceId, data, extracted.text))
        if (auto.noop) {
          // 重切後其實沒有內容差異(排版級變動):不標記、不通知,但要記下新 hash。
          // appliedContentHash 也推到新值:現有卡片與這一版內容等價,已經沒有東西要決定,
          // 少了這句,店家之後按「重新同步」還是會被要求審一份全是假差異的 diff。
          await commitChange({ appliedContentHash: newHash })
          return { sourceId, outcome: 'unchanged', message: 'content-equivalent' }
        }
        if (auto.applied) {
          // 先前若有未處理的「偵測到變動」旗標,這次已把內容更新到最新 → 一併清掉,
          // 否則來源會永遠掛著提示,店家點進去看到的卻是「全部未變」的空 diff。
          // 卡片已更新到這一版 → appliedContentHash 同步推進(手動重新同步據此判斷「沒變」)。
          await commitChange({ outdatedAt: null, appliedContentHash: newHash })
          // 自動更新成功不推播(2026-08-06 拍板:成功不需要行動);留 log 供追查
          console.log(`[detect-source-updates] ${sourceId} auto-applied ~${auto.updated}${auto.failed ? ` (${auto.failed} failed)` : ''}`)
          return { sourceId, outcome: 'auto_applied', message: `~${auto.updated}` }
        }
        // 不符合自動條件 → 走人工審。不再即時推播:outdatedAt 標記由每日摘要
        // (dailyOpsDigest)統一提醒,後台小幫手也有「內容變了還沒重新學」燈號。
        await commitChange()
        await markSourceOutdated(db, sourceId)
        console.log(`[detect-source-updates] ${sourceId} changed, needs review (${auto.reason})`)
        return { sourceId, outcome: 'changed_notified' }
      }
      await commitChange()
      await markSourceOutdated(db, sourceId)
      // 標記不會消失:每日摘要每天把「有變動待審」的來源數提醒一次,直到有人處理。
      // (原本這裡即時推播;2026-08-06 拍板改併入摘要,一則錢講完全部)
      console.log(`[detect-source-updates] ${sourceId} changed, needs review`)
      return { sourceId, outcome: 'changed_notified' }
    }
    await commitChange()
    console.log(`[detect-source-updates] ${sourceId} (${data.url}) content changed; log_only mode, no notify`)
    return { sourceId, outcome: 'changed_logged' }
  }
  catch (err: any) {
    // 失敗不要中斷整批；但**不能只 log**——官網改版把頁面移走後,這裡每天失敗而
    // UI 永遠顯示「正常」,知識庫悄悄過期沒人知道。把失敗寫回 source：
    //   - failureReason：來源頁本來就會顯示「失敗原因：…」
    //   - lastCheckedAt：退避基準（lastFetchedAt 保留「最後成功同步」語意不動）
    //   - 連續失敗 ≥3 次 → status='failed'，列表狀態直接可見
    const msg = String(err?.statusMessage || err?.message || 'unknown error').slice(0, 200)
    console.warn(`[detect-source-updates] ${sourceId} check failed: ${msg}`)
    const failCount = Number(data.checkFailCount ?? 0) + 1
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
      failureReason: `自動檢查失敗：${msg}`,
      checkFailCount: failCount,
      lastCheckedAt: FieldValue.serverTimestamp(),
      ...(failCount >= 3 ? { status: 'failed' } : {}),
    }).catch(() => {})
    // 不再即時推播(2026-08-06 拍板):status='failed' 由每日摘要每天提醒一次直到修復,
    // 比「跨過第 3 次那一則」更不會漏(gsheet 403 壞半個月沒人知道的教訓——那則沒看到就沒了)。
    return { sourceId, outcome: 'error', message: msg }
  }
}

/**
 * 失敗退避（C-48，純函式好測）：連續失敗的來源檢查間隔升冪（interval × 2^n，封頂 24h）。
 * 沒有退避的話：分享權限被收回的試算表每小時被打一次 API 打到永遠，
 * 還穩穩佔住每輪掃描名額，把健康的來源擠出去。
 */
export function sourceDueIntervalMs(intervalMs: number, checkFailCount: number): number {
  const n = Math.min(Math.max(0, Math.floor(checkFailCount)), 5)
  return Math.min(intervalMs * 2 ** n, 24 * 60 * 60_000)
}

/** 單輪處理的時間預算：超過就把剩下的留給下一輪（沒處理的來源 lastFetchedAt 沒動，下輪照樣 due）。
 *  一輪拖太久會撞閘道逾時 → Cloud Scheduler 記失敗重試 → 半輪工作重複執行。 */
const DETECT_TIME_BUDGET_MS = 60_000

/**
 * 對 type='url' 的 source 做變動偵測、type='gsheet' 做自動同步。
 * 每張 source 的實際頻率由自身 refreshIntervalMinutes 決定（含失敗退避），
 * 呼叫端頻率高於來源頻率時只是空查詢。
 */
export async function detectSourceUpdates(db: Firestore) {
  // 撈候選來源：refreshIntervalMinutes > 0（url 偵測 + gsheet 自動同步共用此排程）。
  // 不等式查詢隱含按 refreshIntervalMinutes 升冪 → 沒有游標的話**每輪永遠拿同一批前 N 筆**：
  // 任一租戶接個幾百張表（60 分）就把所有網址來源（1440 分）永久擠出視窗、零指標（C-48）。
  // 游標輪轉：記住上一輪掃到哪，下一輪接著掃；掃到底歸零重來。__name__ 是免費的第二排序鍵。
  const cursorRef = db.collection('cronState').doc('detect-sources-cursor')
  const cursorData = (await cursorRef.get()).data() as { lastInterval?: number; lastId?: string } | undefined
  let q = db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('refreshIntervalMinutes', '>', 0)
    .orderBy('refreshIntervalMinutes')
    .orderBy('__name__')
    .limit(SOURCE_SCAN_LIMIT * 5)
  if (cursorData?.lastInterval != null && cursorData?.lastId) {
    q = q.startAfter(cursorData.lastInterval, cursorData.lastId)
  }
  const snap = await q.get()
  const windowFull = snap.size >= SOURCE_SCAN_LIMIT * 5

  const now = Date.now()
  const dueDocs: Array<{ id: string; data: KnowledgeSourceDoc }> = []
  /**
   * 游標要停在「這一輪真的看過的最後一筆」，不是「抓回來的最後一筆」。
   * ⛔踩過：抓 250 筆但只處理 50 筆就 break，游標卻推到第 250 筆——中間 200 個來源
   * 這輪沒看、游標又已經越過它們，要等繞完一整圈才有機會。那正是本來要修的飢餓，換個形狀。
   */
  let lastSeen: { interval: number; id: string } | null = null
  for (const d of snap.docs) {
    const data = d.data() as KnowledgeSourceDoc
    lastSeen = { interval: Number((data as any).refreshIntervalMinutes ?? 0), id: d.id }
    if (data.type !== 'url' && data.type !== 'gsheet') continue
    // 關掉自動同步的表＝商家自管：checkOneSource 只會直接 return，
    // 不排除的話它們永遠「到期」、每輪白佔 SCAN_LIMIT 名額（早退不戳時間戳）。
    if (data.type === 'gsheet' && data.gsheetAutoApply === false) continue
    // 退避：失敗的檢查不更新 lastFetchedAt，若只看它會每次排程都重打掛掉的網站。
    // 以「最後一次嘗試」（成功或失敗）起算間隔；連續失敗的來源間隔升冪（見 sourceDueIntervalMs）。
    const lastMs = Math.max(tsToMs(data.lastFetchedAt), tsToMs(data.lastCheckedAt))
    const intervalMs = Number(data.refreshIntervalMinutes || 0) * 60_000
    if (!intervalMs) continue
    if (lastMs && (now - lastMs) < sourceDueIntervalMs(intervalMs, Number(data.checkFailCount ?? 0))) continue
    dueDocs.push({ id: d.id, data })
    if (dueDocs.length >= SOURCE_SCAN_LIMIT) break
  }

  // 游標落在「這輪看過的最後一筆」；沒撞到視窗上限＝已經看到底，歸零下輪從頭
  if (windowFull && lastSeen) {
    await cursorRef.set({ lastInterval: lastSeen.interval, lastId: lastSeen.id }).catch(() => {})
    console.log(`[detect-source-updates] 候選窗滿（${snap.size}），游標停在已檢視的最後一筆、下輪續掃`)
  }
  else {
    await cursorRef.set({ lastInterval: null, lastId: '' }).catch(() => {})
  }

  if (!dueDocs.length) return { scanned: 0 }

  // 用 concurrency pool 跑 check;自動套用限額由整輪共用(見 AUTO_APPLY_BUDGET_PER_RUN)
  // 時間預算:到點就收工,剩下的來源下一輪照樣 due(不處理≠丟掉)
  const run: DetectRunState = { autoApplyRemaining: AUTO_APPLY_BUDGET_PER_RUN }
  const deadline = Date.now() + DETECT_TIME_BUDGET_MS
  const results: SourceCheckResult[] = []
  let cursor = 0
  async function worker() {
    while (cursor < dueDocs.length && Date.now() < deadline) {
      const i = cursor++
      const doc = dueDocs[i]!
      const r = await checkOneSource(db, doc.id, doc.data, run)
      results.push(r)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SOURCE_FETCH_CONCURRENCY, dueDocs.length) }, worker),
  )
  if (results.length < dueDocs.length) {
    console.warn(`[detect-source-updates] 時間預算用完，本輪處理 ${results.length}/${dueDocs.length}，其餘下輪續掃`)
  }

  const tally = {
    scanned: results.length,
    unchanged: results.filter(r => r.outcome === 'unchanged').length,
    changedNotified: results.filter(r => r.outcome === 'changed_notified').length,
    changedLogged: results.filter(r => r.outcome === 'changed_logged').length,
    gsheetSynced: results.filter(r => r.outcome === 'gsheet_synced').length,
    autoApplied: results.filter(r => r.outcome === 'auto_applied').length,
    errors: results.filter(r => r.outcome === 'error').length,
  }
  if (tally.changedNotified || tally.gsheetSynced || tally.autoApplied || tally.errors) {
    console.log('[ai:detect-source-updates]', tally)
  }
  return tally
}

// ── 真人閒置自動交還機器人 ─────────────────────────────────────────────────

const SESSION_SCAN_LIMIT = 200

/**
 * 掃 status='human_handling' 的會話，真人最後回覆超過該 workspace 的
 * handbackIdleMinutes（0 = 關閉）→ 自動交還機器人。
 * 判斷基準是「真人最後回覆」而非 lastActivityAt——客人持續傳訊會一直 bump
 * lastActivityAt，若用它判斷，真人離開後黑洞永遠不會解除。
 * pending_human（真人還沒接手）不自動交還：已經跟客人說「為您安排專員」，
 * 默默丟回機器人會破壞預期；那條路靠通知 + 手動按鈕處理。
 */
export async function autoHandbackIdleSessions(db: Firestore) {
  const snap = await db.collection('conversationSessions')
    .where('status', '==', 'human_handling')
    .limit(SESSION_SCAN_LIMIT)
    .get()

  const now = Date.now()
  let handedBack = 0
  let skippedDisabled = 0
  let skippedFresh = 0

  for (const doc of snap.docs) {
    const data = doc.data() as any
    const workspaceId = String(data?.workspaceId ?? '')
    const userId = String(data?.userId ?? '')
    if (!workspaceId || !userId) continue

    try {
      // getAiSettings 有 60 秒 in-memory cache，同 workspace 多筆 session 不會重複讀
      const settings = await getAiSettings(workspaceId, db)
      const idleMinutes = settings.handbackIdleMinutes
      if (!idleMinutes) {
        skippedDisabled++
        continue
      }

      const lastHumanMs = tsToMs(data.humanLastRepliedAt) || tsToMs(data.humanFirstRepliedAt)
      if (!lastHumanMs) continue // 沒有真人回覆紀錄的不動（理論上 human_handling 必有）

      if (now - lastHumanMs < idleMinutes * 60_000) {
        skippedFresh++
        continue
      }

      const ok = await handBackSessionToBot(doc.id, userId)
      if (ok) handedBack++
    }
    catch (err) {
      // 單筆失敗不影響整批
      console.warn('[auto-handback] session check failed:', doc.id, err)
    }
  }

  const tally = { scanned: snap.size, handedBack, skippedDisabled, skippedFresh }
  if (handedBack) console.log('[conversation:auto-handback]', tally)
  return tally
}

// ── 真人接手中的會話：閒置過久自動收尾 ─────────────────────────────────────

/** 真人接手中的兩種狀態；兩支單欄等值查詢，免複合索引 */
const HUMAN_OWNED_STATUSES: ConversationStatus[] = ['pending_human', 'human_handling']

/**
 * 真人接手中（待真人／真人處理中）的會話**不吃 24 小時自動結束**——客人隔天回一句
 * 「好，那就這樣訂」要接在同一場，不能被判成新的一場讓 AI 搶答（見
 * isHumanOwnedSessionStatus）。代價是這種場不會自己消失，這支就是唯一的收殮機制：
 * 雙方都沒動靜超過 aiSettings.humanSessionMaxIdleHours 就自動結束。
 *
 * 為什麼非有不可：真人接手期間機器人是閉嘴的，客服忘了按「結束會話」等於這位客人從此
 * 收不到任何自動回覆；而沒關的場會一直被背景查詢掃到（2026-08-11 讀取費暴衝有這一份）。
 * 所以門檻可調但**不可關閉**（下界見 MIN_HUMAN_SESSION_MAX_IDLE_HOURS）。
 *
 * 判斷基準用 lastActivityAt（雙方任一有動靜就會被 bump），不是 humanLastRepliedAt——
 * 客人還在講話的場不該被收掉，那是客服該去回的，靠 SLA 提醒與每日摘要催。
 */
export async function autoCloseIdleHumanSessions(db: Firestore) {
  const now = Date.now()
  let closed = 0
  let skippedFresh = 0
  let skippedDisabled = 0
  let scanned = 0
  let truncated = false

  for (const status of HUMAN_OWNED_STATUSES) {
    const snap = await db.collection('conversationSessions')
      .where('status', '==', status)
      .limit(SESSION_SCAN_LIMIT)
      .get()
    scanned += snap.size
    // 掃到上限＝這一輪沒看完，剩下的下一輪再收。不出聲的話「掃過了」與「掃完了」看起來一樣
    if (snap.size >= SESSION_SCAN_LIMIT) truncated = true

    for (const doc of snap.docs) {
      const data = doc.data() as any
      const workspaceId = String(data?.workspaceId ?? '')
      const userId = String(data?.userId ?? '')
      if (!workspaceId || !userId) continue

      try {
        const settings = await getAiSettings(workspaceId, db)
        /**
         * 0 ＝ 這個工作區把「自動結束」關掉了（預設，2026-08-21 拍板）：真人接手的對話
         * 只有真人自己按「結束會話」／「交還機器人」才結束，這支不代勞。
         * ⛔ 不可以只靠下面的 `idleMs <` 比較——0 小時代表「零容忍」，每一場都會被收掉，
         * 正好是關閉的反面。
         */
        if (!settings.humanSessionMaxIdleHours) {
          skippedDisabled++
          continue
        }
        const idleMs = now - (tsToMs(data.lastActivityAt) || tsToMs(data.openedAt))
        if (idleMs < settings.humanSessionMaxIdleHours * 3600_000) {
          skippedFresh++
          continue
        }
        await closeConversationSession(doc.id, userId, { reason: 'idle_auto' })
        closed++
      }
      catch (err) {
        // 單筆失敗不影響整批（下一輪會再撿到它）
        console.warn('[auto-close-idle] session close failed:', doc.id, err)
      }
    }
  }

  const tally = { scanned, closed, skippedFresh, skippedDisabled, truncated }
  if (closed || truncated) console.log('[conversation:auto-close-idle]', tally)
  return tally
}

// ── 機器人那半的會話：閒置過久自動收尾（`D-64`）─────────────────────────────

/** 機器人在處理、或還沒有人接手的兩種狀態（真人那兩種由上面那支負責） */
const BOT_OWNED_STATUSES: ConversationStatus[] = ['open', 'bot_handling']

/**
 * 客人問完就沒再回來的對話，超過 `BOT_SESSION_MAX_IDLE_DAYS` 天沒動靜就自動結束。
 *
 * **為什麼非有不可（`D-64`，2026-09-04 老闆拍板）**：24 小時換場是**懶惰觸發**——只在
 * 「客人下一則訊息進來、開新場」那個交易裡才把上一場關掉。客人沒再回來就永遠不關。
 * 而 AI 讀對話貼標籤**只讀已結束的對話**，於是那些對話 AI 永遠讀不到：實測 MYFEEL
 * 8/23 之後有動靜的 770 場只有 205 場（26.6%）進得了掃描器，另有 2,978 場超過 30 天
 * 沒動靜還掛著。真人那半早就有收殮（見上面那支），機器人這半一直沒有。
 *
 * ⛔ **一定要帶 `preserveLastActivityAt`**：不帶的話那 2,978 場會被蓋成「剛剛結束」、
 *   整批跳到 AI 掃描器的游標後面＝約三千次 LLM。理由見 `closeConversationSession` 的註解。
 * ⛔ **沒有「關掉這個功能」的設定**（跟真人那邊不同）：關掉等於把問題養回來，
 *   而且背景查詢會一直掃這批殭屍場。要調天數改 `BOT_SESSION_MAX_IDLE_DAYS`。
 * ⛔ **不吃 workspace 設定**：這支跟真人那支不同，不需要逐場讀 `getAiSettings`
 *   （那支每場都讀一次是因為門檻可調且預設關閉）。少掉那個讀取，一輪省 200 次查詢。
 *
 * 判斷基準用 `lastActivityAt`（雙方任一有動靜就會被 bump），沒有這個欄位的舊資料
 * 退回 `openedAt`；兩個都沒有就**跳過不猜**——寧可留著，也不要把剛開的場誤收掉。
 */
export async function autoCloseIdleBotSessions(db: Firestore) {
  const now = Date.now()
  const maxIdleMs = BOT_SESSION_MAX_IDLE_DAYS * 24 * 3600_000
  let closed = 0
  let skippedFresh = 0
  let skippedNoTime = 0
  let scanned = 0
  let truncated = false

  for (const status of BOT_OWNED_STATUSES) {
    const snap = await db.collection('conversationSessions')
      .where('status', '==', status)
      .limit(SESSION_SCAN_LIMIT)
      .get()
    scanned += snap.size
    // 掃到上限＝這一輪沒看完，剩下的下一輪再收（第一次上線要收幾千場，本來就會跑好幾輪）
    if (snap.size >= SESSION_SCAN_LIMIT) truncated = true

    for (const doc of snap.docs) {
      const data = doc.data() as any
      const userId = String(data?.userId ?? '')
      if (!userId) continue

      const lastMs = tsToMs(data.lastActivityAt) || tsToMs(data.openedAt)
      // ⛔ 兩個時間都讀不到就跳過：猜一個等於可能把剛開的場收掉，代價比留著大得多
      if (!lastMs) {
        skippedNoTime++
        continue
      }
      if (now - lastMs < maxIdleMs) {
        skippedFresh++
        continue
      }

      try {
        await closeConversationSession(doc.id, userId, {
          reason: 'idle_bot_auto',
          preserveLastActivityAt: true,
        })
        closed++
      }
      catch (err) {
        // 單筆失敗不影響整批（下一輪會再撿到它）
        console.warn('[auto-close-idle-bot] session close failed:', doc.id, err)
      }
    }
  }

  const tally = { scanned, closed, skippedFresh, skippedNoTime, truncated }
  if (closed || truncated) console.log('[conversation:auto-close-idle-bot]', tally)
  return tally
}

// ── 轉真人逾時 SLA 提醒 ────────────────────────────────────────────────────

/**
 * 原子認領一場會話的 SLA 提醒權：交易內確認還沒被提醒，同時把章蓋上。
 *
 * 為什麼一定要用交易：`slaRemindedAt` 的「先讀再寫」中間有空窗，只要有**兩個排程執行者**
 * 同時跑這一輪，兩邊都會讀到「還沒提醒」→ 客服收到兩則一模一樣的提醒，而後蓋的章覆蓋
 * 前一個，資料上只留一個章、完全看不出重複過。
 * （2026-08-07 現場：本機 `nuxt dev` 的 Nitro scheduledTasks 用 .env 的正式憑證，
 *  與 Amplify 上的 Cloud Scheduler 同時打同一份正式庫，13:40 與 14:30 兩則各重複一次。
 *  Cloud Scheduler 逾時重試、Lambda 併發也是同一個坑，所以修在這裡而不是叫人關 dev。）
 *
 * humanFirstRepliedAt 在交易內再確認一次：這一輪跑到一半真人剛接手，就不該再催了。
 */
async function claimSlaReminder(
  db: Firestore,
  ref: FirebaseFirestore.DocumentReference,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const data = snap.data() as any
    if (!snap.exists || data?.slaRemindedAt || data?.humanFirstRepliedAt) return false
    tx.update(ref, { slaRemindedAt: FieldValue.serverTimestamp() })
    return true
  }).catch((err) => {
    console.warn('[handoff-sla] claim failed:', ref.id, err)
    return false
  })
}

/** 推播沒送出去 → 把章拆掉，讓下一輪重試（否則這一場的提醒永遠補不回來） */
async function releaseSlaReminders(refs: FirebaseFirestore.DocumentReference[]): Promise<void> {
  await Promise.all(refs.map(ref =>
    ref.update({ slaRemindedAt: FieldValue.delete() })
      .catch(err => console.warn('[handoff-sla] release failed:', ref.id, err)),
  ))
}

/**
 * pending_human 超過 aiSettings.handoffNotify.slaRemindMinutes 仍無人回應
 * → 再推播提醒值班客服一次。每場會話只提醒一次（session.slaRemindedAt 標記）。
 *
 * 同一輪同一 workspace 有多場逾時 → 合併成一則清單通知（見 notifyOverdueHandoffBatch）。
 * 一場一則的舊行為在「勿擾結束後的第一輪」會把整晚累積的請求一次全轟出來，
 * 所以這支必須先按 workspace 分組、再決定發幾則，不能逐場獨立處理。
 */
export async function remindOverdueHandoffs(db: Firestore) {
  const snap = await db.collection('conversationSessions')
    .where('status', '==', 'pending_human')
    .limit(SESSION_SCAN_LIMIT)
    .get()

  const now = Date.now()
  let reminded = 0 // 被提醒到的「場數」
  let messages = 0 // 真正送出的訊息則數（合併的效果看這個與 reminded 的差距）
  let skipped = 0

  interface Candidate {
    doc: FirebaseFirestore.QueryDocumentSnapshot
    lineUserId: string
    requestedMs: number
  }
  const byWs = new Map<string, Candidate[]>()
  for (const doc of snap.docs) {
    const data = doc.data() as any
    const workspaceId = String(data?.workspaceId ?? '')
    const lineUserId = String(data?.userId ?? '')
    if (!workspaceId || !lineUserId) continue
    if (data.slaRemindedAt || data.humanFirstRepliedAt) {
      skipped++
      continue
    }
    const requestedMs = tsToMs(data.handoffRequestedAt)
    if (!requestedMs) continue
    const list = byWs.get(workspaceId) ?? []
    list.push({ doc, lineUserId, requestedMs })
    byWs.set(workspaceId, list)
  }

  for (const [workspaceId, candidates] of byWs) {
    try {
      // getAiSettings 有 60 秒 in-memory cache；分組後每個 workspace 只讀一次
      const settings = await getAiSettings(workspaceId, db)
      const sla = settings.handoffNotify.slaRemindMinutes
      if (!settings.handoffNotify.enabled || !sla) {
        skipped += candidates.length
        continue
      }
      // 勿擾時段先不蓋章,等勿擾結束的下一輪再發(通知函式內部的勿擾檢查會把推播吞掉,
      // 但這裡蓋了 slaRemindedAt 就永遠補不回來——在 missed_only 模式這是唯一的一則
      // 通知,吞掉等於整場轉真人無聲無息)。
      if (isServiceHoursDnd(settings.serviceHours)) {
        skipped += candidates.length
        continue
      }

      const overdue = candidates.filter(c => now - c.requestedMs >= sla * 60_000)
      skipped += candidates.length - overdue.length
      if (!overdue.length) continue

      // 撈暱稱讓提醒可讀（一場會話只發一次，這個讀取量可接受）。
      // 暱稱存在 users 集合（ensureUser 寫入），conversations doc 從來沒有這個欄位——
      // 之前讀錯集合,提醒永遠 fallback 成 33 碼原始 userId。
      // 另外 profile 抓取失敗時 ensureUser 會把 userId 存進 displayName,一樣要擋:
      // 原始 ID 在後台搜不到、也認不出是誰,不如老實說「未知暱稱」。
      const enriched = await Promise.all(overdue.map(async (c) => {
        const docId = lineUserFirestoreDocId(c.lineUserId, workspaceId)
        const [userSnap, convSnap] = await Promise.all([
          db.collection('users').doc(docId).get().catch(() => null),
          db.collection('conversations').doc(docId).get().catch(() => null),
        ])
        const rawName = String(userSnap?.data()?.displayName ?? '').trim()
        const displayName = rawName && rawName !== c.lineUserId
          ? rawName
          : `未知暱稱（…${c.lineUserId.slice(-6)}）`

        // missed_only 模式下這是唯一的一則通知:把轉真人當下存的摘要/客人訊息補回來。
        // 只認這一場存的（at 不早於 handoffRequestedAt 太多），避免撈到上一場的舊內容。
        const ctx = (convSnap?.data()?.handoffNotifyContext ?? null) as
          { summary?: string; message?: string; reason?: string | null; at?: unknown } | null
        const ctxFresh = Boolean(ctx && tsToMs(ctx.at) >= c.requestedMs - 10 * 60_000)
        return {
          ...c,
          displayName,
          message: ctxFresh ? String(ctx?.message ?? '') : '',
          summary: ctxFresh ? String(ctx?.summary ?? '') : '',
          reason: ctxFresh ? ((ctx?.reason ?? null) as HandoffReason | null) : null,
        }
      }))

      // 先原子認領、認領成功才推播:另一個執行者搶到的場次會在這裡被過濾掉,
      // 兩邊同時跑最壞的結果是「一邊發完整批、另一邊完全不發」,而不是各發一則。
      // 認領（寫）排在推播（發訊息）之前是刻意的:失敗時可以拆章重試,反過來
      // 「先發再蓋」則沒有任何辦法把已經送出去的訊息收回。
      const claimed = (await Promise.all(
        enriched.map(async e => (await claimSlaReminder(db, e.doc.ref)) ? e : null),
      )).filter(Boolean) as typeof enriched
      skipped += enriched.length - claimed.length
      if (!claimed.length) continue

      // 1 位：維持完整格式（帶摘要與客人原話，客服看完就能接手）
      // ≥2 位：合併一則清單，每位一行「暱稱＋等了多久＋原因」
      const single = claimed.length === 1 ? claimed[0]! : null
      let sent = false
      try {
        sent = single
          ? await notifyHandoffToStaff({
              workspaceId,
              customerLineUserId: single.lineUserId,
              customerName: single.displayName,
              customerMessage: single.message,
              reason: single.reason,
              summary: single.summary,
              slaReminderMinutes: sla,
            })
          : await notifyOverdueHandoffBatch({
              workspaceId,
              slaReminderMinutes: sla,
              items: claimed.map(e => ({
                customerLineUserId: e.lineUserId,
                customerName: e.displayName,
                waitedMs: now - e.requestedMs,
                reason: e.reason,
              })),
            })
      }
      catch (err) {
        console.warn('[handoff-sla] notify threw:', workspaceId, err)
      }
      // 沒送出去（被節流吞掉、丟例外等）就把章拆掉，留給下一輪重試
      if (!sent) {
        await releaseSlaReminders(claimed.map(e => e.doc.ref))
        skipped += claimed.length
        continue
      }
      reminded += claimed.length
      messages++
    }
    catch (err) {
      console.warn('[handoff-sla] workspace check failed:', workspaceId, err)
    }
  }

  const tally = { scanned: snap.size, reminded, messages, skipped }
  if (reminded) console.log('[conversation:handoff-sla]', tally)
  return tally
}

// ── webhook 冪等鎖清理 ─────────────────────────────────────────────────────

/**
 * 刪除過期的 webhook 冪等鎖（expiresAt < now）。
 * Firestore TTL policy 也會清（splash 已設定），此函式作為不依賴 console 權限的保底。
 */
export async function cleanupExpiredWebhookEventLocks(db: Firestore) {
  let deleted = 0
  // 每輪最多清 5 批（2500 筆），避免單次跑太久；剩餘的留給下一輪
  for (let i = 0; i < 5; i++) {
    const snap = await db.collection(WEBHOOK_EVENT_LOCKS_COLLECTION)
      .where('expiresAt', '<', Timestamp.now())
      .limit(500)
      .get()
    if (snap.empty) break
    const batch = db.batch()
    snap.docs.forEach(doc => batch.delete(doc.ref))
    await batch.commit()
    deleted += snap.size
    if (snap.size < 500) break
  }
  if (deleted > 0) {
    console.log('[webhook:cleanup-event-locks] deleted', deleted, 'expired locks')
  }
  return { deleted }
}

// ── 每日客服摘要 ─────────────────────────────────────────────────────────
// 「知道就好」的事全部收進每天一則:昨天的成績＋客人正在等的事＋知識庫待辦
// (來源待審/同步失敗/到期卡/建議收件匣)＋黃級異常一行(D-36①,清單在 shared 的
// DIGEST_WARNING_ALERTS)。2026-08-06 拍板:原本各自即時推播的知識庫通知一律併進來,
// LINE 按則計費,一則錢講完全部;事件當下的標記(outdatedAt/status='failed'/expiredAt/
// pending)都留在資料上,摘要每天照著標記喊,直到有人處理——比「事件當下那一則」更不會漏。
// 每 workspace 每天最多一則(標記存 cronState/backlog-digest)。
// 發送時段由各 workspace 的 handoffNotify.digestHour 自選(台北時間整點);
// 休假日(服務時間有開 + 週六日休息)整天不發,週末累積的事上班日那則會一次講完。
//
// ── 2026-09-17 改版（`D-81` 老闆拍板三題）─────────────────────────────
// ① **開頭先講昨天的成績**（場數／AI 自己搞定／你出手／沒人回／新朋友）。數字取
//    `loadDayStats` 的日結,**與統計頁、後台那張「昨日摘要」卡同一支算式**——
//    ⛔不可以在這裡自己數一遍,兩把尺遲早算出不同的數字。
// ② **每天都發**（拍板選項 B）:沒事的日子發一行短版。原本「沒事就不發」的結果是
//    「昨天很順」與「通知壞掉了」長得一模一樣,而通知名單沒設好會讓所有推播全靜音。
// ③ 三段結構仍然是**一則純文字**（文案與排版在 `daily-digest-message.ts`）。
//
// ⛔ 同時修掉的正確性問題:原本七個來源查詢全是「**不分工作區**撈全站前 200 筆、
//    沒有 orderBy、也沒有撈滿了的旗標」——租戶一多就會有帳號的數字被別家吃掉、
//    甚至整家從摘要裡消失,而訊息照發、看起來完全正常。現在**逐工作區查**,
//    而且排在所有便宜閘門（今天發過沒／通知開著沒／時段到了沒／休假日）之後,
//    所以每個工作區一天只查一次。任何一類查失敗都不當成 0,改由訊息講「這次查不到」。

/** 逐工作區撈明細的上限（只有需要細節的兩類會撈 doc,其餘一律用 count 聚合） */
const DIGEST_SCAN_LIMIT = 200
/** 點名幾位（跟後台那張卡同一個數字：看得到名字才點得進去） */
const DIGEST_SAMPLE_LIMIT = 3

/**
 * 原子認領「某 workspace 今天的摘要名額」：交易內確認今天還沒發，同時把日期記上。
 *
 * 與 claimSlaReminder 同一個理由，而且這裡的空窗更大——原本是「開頭讀一次整份 state、
 * 整批跑完才在最後寫回」，中間夾著逐 workspace 的設定讀取與推播。只要有第二個執行者
 * （Cloud Scheduler 逾時重試、Lambda 併發、本機 dev 的排程）就會發出兩份一樣的摘要。
 *
 * 每個 workspace 都認領同一份 doc 的不同欄位，會有交易競爭；租戶數是個位數、
 * 一天各一次，Firestore 自動重試吃得下。
 */
async function claimDailyDigest(
  db: Firestore,
  stateRef: FirebaseFirestore.DocumentReference,
  workspaceId: string,
  today: string,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef)
    const data = (snap.data() ?? {}) as Record<string, string>
    if (data[workspaceId] === today) return false
    // 用 set+merge 而不是 update:doc 可能還不存在,而且 workspaceId 當欄位名時
    // update 會把它當 field path 解析（這裡是 UUID 沒有點，但別留這種地雷）
    tx.set(stateRef, { [workspaceId]: today }, { merge: true })
    return true
  }).catch((err) => {
    console.warn('[backlog-digest] claim failed:', workspaceId, err)
    return false
  })
}

/** 摘要沒送出去 → 把今天的記錄拆掉，讓下一輪重試（否則今天就整天沒摘要了） */
async function releaseDailyDigest(
  stateRef: FirebaseFirestore.DocumentReference,
  workspaceId: string,
): Promise<void> {
  await stateRef.set({ [workspaceId]: FieldValue.delete() }, { merge: true })
    .catch(err => console.warn('[backlog-digest] release failed:', workspaceId, err))
}

// ── 節慶行銷提醒 ─────────────────────────────────────────────────────────
// 節日前 7／3／1 天，在每日摘要那則訊息裡多加一段（不另發一則，LINE 按則計費）。
// 節日表與「今天該講哪一個」的判定都在 shared/taiwan-festivals.ts。
//
// 這裡只負責記帳：哪個 workspace 對哪個節日講到第幾個里程碑了。
// 形狀 `{ [workspaceId]: { [festivalId]: 已送出的最小里程碑 } }`。
// 一天一則的防重複沿用 claimDailyDigest，所以這份不需要交易——節慶提醒是搭在那則
// 已認領成功的訊息上，走到這裡就代表今天這個 workspace 只會有一則。

/** workspaces 全掃上限（節慶提醒才需要「連沒積壓的帳號也要發」，見呼叫處） */
const DIGEST_WORKSPACE_SCAN_CAP = 2000

type FestivalSentState = Record<string, Record<string, number>>

/**
 * 記下「這個節日講到第幾個里程碑」，順手清掉已經過完的節日。
 *
 * 不清的話這份 doc 會逐年變肥（每個 workspace 每年二十幾筆），而且過期的 key 會讓
 * 日後改節日表時難以看出哪些還有效。表上已被刪掉的 id 也一併清掉。
 */
async function recordFestivalReminder(
  stateRef: FirebaseFirestore.DocumentReference,
  workspaceId: string,
  current: Record<string, number>,
  festivalId: string,
  milestone: number,
  today: string,
): Promise<void> {
  const patch: Record<string, unknown> = { [festivalId]: milestone }
  for (const id of Object.keys(current)) {
    if (id === festivalId) continue
    const f = TAIWAN_FESTIVALS.find(x => x.id === id)
    if (!f || daysBetween(today, f.date) < 0) patch[id] = FieldValue.delete()
  }
  await stateRef.set({ [workspaceId]: patch }, { merge: true })
    .catch(err => console.warn('[festival-digest] record failed:', workspaceId, err))
}

/** 撈客人的顯示名稱（點名用）。查不到就給「LINE 用戶」，不讓一個名字弄垮整則摘要 */
async function digestDisplayNames(db: Firestore, ws: string, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return []
  return Promise.all(userIds.map(async (uid) => {
    const snap = await db.collection('users').doc(lineUserFirestoreDocId(uid, ws)).get().catch(() => null)
    return String(snap?.data()?.displayName || '').trim() || 'LINE 用戶'
  })).catch(() => [])
}

/**
 * 昨天的成績。**數字一律取 `loadDayStats`**（統計頁與後台那張卡同一支算式）——
 * ⛔不可以在這裡自己數一遍，兩把尺遲早算出不同的數字，而使用者只會看到
 * 「LINE 說 23 場、後台說 21 場」。查不到回 `null`（⛔不是 0 場）。
 */
async function loadDigestYesterday(db: Firestore, ws: string, dayKey: string): Promise<DigestYesterday | null> {
  const day = await loadDayStats(db, ws, [dayKey])
    .then(r => r.days.get(dayKey) ?? null)
    .catch((e) => {
      console.warn('[backlog-digest] 昨天的數字查不到:', ws, (e as Error)?.message)
      return null
    })
  if (!day) return null

  // 互斥三類，相加等於總場數（見 daily-digest-message.ts 的「加得起來才能並排」）：
  //   自己搞定＝AI／機器人首接**且沒轉真人**；你出手＝真人首接 ＋ 先機器人後轉真人
  const escalated = (day.aiEscalated ?? 0) + (day.botEscalated ?? 0)
  const names = await digestDisplayNames(
    db, ws,
    day.unhandledSamples.slice(0, DIGEST_SAMPLE_LIMIT).map(s => String(s.userId || '')).filter(Boolean),
  )
  return {
    total: day.total,
    selfServed: Math.max(0, day.ai + day.bot - escalated),
    humanServed: day.human + escalated,
    unhandled: day.unhandled,
    unhandledNames: names,
    newFriends: day.newFriends,
  }
}

/**
 * 發送當下「客人正在等」的即時狀況。查不到回 `null`（⛔不是「沒有人在等」）。
 *
 * 下班時段進來的要分開講：後台那張卡早就這樣做了，理由是「這行天天紅字＝狼來了」。
 */
async function loadDigestWaiting(
  db: Firestore,
  ws: string,
  nowMs: number,
  serviceHours: Parameters<typeof isServiceHoursDnd>[0],
): Promise<DigestWaiting | null> {
  const sessions = db.collection('conversationSessions').where('workspaceId', '==', ws)
  const [pendingSnap, humanSnap] = await Promise.all([
    sessions.where('status', '==', 'pending_human').limit(DIGEST_SCAN_LIMIT).get().catch(() => null),
    sessions.where('status', '==', 'human_handling').limit(DIGEST_SCAN_LIMIT).get().catch(() => null),
  ])
  if (!pendingSnap) return null

  const rows = pendingSnap.docs.map((doc) => {
    const d = doc.data() as any
    const sinceMs = tsToMs(d.handoffRequestedAt) || tsToMs(d.lastActivityAt)
    return {
      userId: String(d.userId ?? ''),
      sinceMs,
      // 服務時間沒啟用時 isServiceHoursDnd 恆 false → 整個「下班時段」子句不會出現
      offHours: sinceMs ? isServiceHoursDnd(serviceHours, new Date(sinceMs)) : false,
    }
  })
  // 服務時間內的排前面（真正要檢討的是「上班還讓客人等」那幾位），再依等最久的排
  rows.sort((a, b) =>
    Number(a.offHours) - Number(b.offHours)
    || (a.sinceMs || Number.MAX_SAFE_INTEGER) - (b.sinceMs || Number.MAX_SAFE_INTEGER))

  const picked = rows.filter(r => r.sinceMs).slice(0, DIGEST_SAMPLE_LIMIT)
  const names = await digestDisplayNames(db, ws, picked.map(r => r.userId))

  let staleHumanCount = 0
  for (const doc of humanSnap?.docs ?? []) {
    const d = doc.data() as any
    const lastMs = tsToMs(d.humanLastRepliedAt) || tsToMs(d.lastActivityAt)
    if (lastMs && nowMs - lastMs >= HUMAN_STALE_HOURS * 3600_000) staleHumanCount++
  }

  return {
    count: rows.length,
    offHoursCount: rows.filter(r => r.offHours).length,
    // 名字查掛了就不點名（數字照講）：寧可少一行，也不要印出一排「LINE 用戶」
    samples: names.length === picked.length
      ? picked.map((r, i) => ({ name: names[i]!, waitedMinutes: (nowMs - r.sinceMs) / 60_000 }))
      : [],
    // 撈滿上限＝實際可能更多，說法要退成「至少 N 位」（⛔不可以靜靜地少講）
    truncated: pendingSnap.size >= DIGEST_SCAN_LIMIT,
    staleHumanCount,
  }
}

/** 「今天可以處理」那一段的件數。每一類各自 `null`＝這一類查不到（⛔不是 0） */
async function loadDigestCounts(db: Firestore, ws: string, nowMs: number) {
  // 只要數字就用 count 聚合：不論命中幾筆都只計 1 次讀取，而且沒有「撈滿上限」的問題
  const countOf = (q: FirebaseFirestore.Query): Promise<number | null> =>
    q.count().get().then(s => s.data().count).catch(() => null)

  const sources = db.collection(KNOWLEDGE_SOURCES_COLLECTION).where('workspaceId', '==', ws)
  const [outdatedSources, failedSources, expiredCards, suggestions, tagSuggestUsers] = await Promise.all([
    countOf(sources.where('outdatedAt', '>', Timestamp.fromMillis(0))),
    countOf(sources.where('status', '==', 'failed')),
    // 近 24 小時剛到期下架的卡；更早的到期卡當天已經講過，不重複喊。
    // 只算「這次真的被下架」的：先前就 disabled/failed 的到期只是搬欄位去重。
    countOf(db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
      .where('workspaceId', '==', ws)
      .where('status', '==', 'disabled')
      .where('expiredAt', '>', Timestamp.fromMillis(nowMs - 24 * 3600_000))),
    countOf(db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION)
      .where('workspaceId', '==', ws)
      .where('status', '==', 'pending')),
    // 貼標建議待審（D-43①）：一份文件＝一位有待審建議的客人。
    // hasPending 是收件匣非空的鏡像欄位（C-108）。
    countOf(db.collection('userTagSuggestions')
      .where('workspaceId', '==', ws)
      .where('hasPending', '==', true)),
  ])

  return {
    outdatedSources,
    failedSources,
    expiredCards,
    suggestions,
    tagSuggestUsers,
    unknown: [outdatedSources, failedSources, expiredCards, suggestions, tagSuggestUsers].some(v => v === null),
  }
}

export async function dailyBacklogDigest(db: Firestore) {
  const taipeiNow = new Date(Date.now() + 8 * 3600_000)
  const taipeiHour = taipeiNow.getUTCHours()
  const today = taipeiNow.toISOString().slice(0, 10)
  /** 摘要講的「昨天」＝台北日曆的前一天（⛔不可以用伺服器本機時區算） */
  const yesterdayKey = taipeiDateKey(new Date(Date.now() - 24 * 3600_000))

  const stateRef = db.collection('cronState').doc('backlog-digest')
  // 這一份只用來便宜地早退「今天已經發過」的 workspace（省掉設定讀取與聚合）；
  // 真正防重複的判斷在 claimDailyDigest 的交易裡，不能靠這個快照。
  const state = ((await stateRef.get()).data() ?? {}) as Record<string, string | number>

  // 掃描節流（C-49D）：發送時段各 workspace 自選、沒有全域「幾點前免查」的早退，
  // 但也不必每 10 分鐘就跑滿 6 個查詢——一天 144 輪裡 143 輪的結果注定被丟掉，
  // 最壞 17 萬次白讀（8/11 讀取費暴衝就是這種「掃全部再跳過」的形狀）。
  // 改成半小時掃一輪：摘要的語意是「當天的 digestHour 那個小時內送到」，±30 分鐘無感。
  const nowMs = Date.now()
  const lastScanMs = Number(state.__lastScanMs ?? 0)
  if (nowMs - lastScanMs < 30 * 60_000) {
    return { outcome: 'throttled' as const, sent: 0 }
  }
  await stateRef.set({ __lastScanMs: nowMs }, { merge: true }).catch(() => {})

  // ── 節慶提醒的前置準備 ────────────────────────────────────────────
  // 只有「真的有節日進入 7 天內」才讀提醒進度（1 次讀取），一年裡大多數日子完全跳過。
  const festivalWindowOpen = hasFestivalInWindow(today)
  /** 週一＝摘要尾巴附「本週顧客觀察」（D-25 洞察週報；同節慶的掛法：搭同一則，不另發） */
  const weeklyWindowOpen = isTaipeiMonday(today)
  const festivalStateRef = db.collection('cronState').doc('festival-digest')
  let festivalState: FestivalSentState = {}
  if (festivalWindowOpen) {
    festivalState = ((await festivalStateRef.get()).data() ?? {}) as FestivalSentState
  }

  // 每天都要發（2026-09-17 拍板選項 B）→ 對象是**全部**工作區，不再只有「有積壓的」。
  // 成本：半小時一輪 × 這一個查詢（回 N 筆），一天 48 次；真正的逐工作區查詢排在
  // 下面所有便宜閘門之後，所以每個工作區一天只查一次。
  const wsSnap = await db.collection('workspaces').limit(DIGEST_WORKSPACE_SCAN_CAP).get()
  if (wsSnap.size >= DIGEST_WORKSPACE_SCAN_CAP) {
    console.warn('[digest] workspace 數達掃描上限，部分帳號今天收不到摘要', DIGEST_WORKSPACE_SCAN_CAP)
  }
  const targetWorkspaces = wsSnap.docs.map(d => d.id)

  let notified = 0
  let festivalsSent = 0
  for (const ws of targetWorkspaces) {
    if (state[ws] === today) continue // 今天發過（便宜早退；真正的判斷在 claimDailyDigest）
    // 節慶判定排在讀設定**之前**：純記憶體比對，不用多讀一次設定
    const reminder = festivalWindowOpen ? pickFestivalReminder(today, festivalState[ws] ?? {}) : null
    const settings = await getAiSettings(ws, db)
    const cfg = settings.handoffNotify
    if (!cfg.enabled || !cfg.lineUserIds.length) continue
    const festival = cfg.festivalTips ? reminder : null
    // 休假日整天不發（服務時間有開 + 勾了週六日休息）。摘要是照著資料上的標記每天重
    // 喊一次,今天跳過不會漏掉任何一條——上班日那則照樣會把週末累積的全部講完。
    // 這裡刻意只看「休假日」不看整個勿擾時段:digestHour 是商家自己挑的,設在服務時間
    // 之外（例如 09:00–18:00 上班、20:00 收摘要）很合理,拿勿擾去擋會變成永遠不發。
    if (isServiceDayOff(settings.serviceHours)) continue
    if (taipeiHour < cfg.digestHour) continue // 商家自選時段還沒到,下一輪再看

    // ── 這裡開始才是真的要花錢的查詢（每個工作區一天只會走到一次）──────
    const unknownNotes: string[] = []
    const [yesterday, waiting, counts] = await Promise.all([
      loadDigestYesterday(db, ws, yesterdayKey),
      loadDigestWaiting(db, ws, nowMs, settings.serviceHours),
      loadDigestCounts(db, ws, nowMs),
    ])
    if (!yesterday) unknownNotes.push('昨天的數字')
    if (!waiting) unknownNotes.push('正在等真人的名單')
    if (counts.unknown) unknownNotes.push('知識庫與標籤的部分')

    // 週報查詢排在所有便宜閘門之後：只有真的走到「要發」的帳號、而且是週一才花這幾個查詢。
    // 但要排在認領**之前**——週一「只有週報可講」的帳號得先知道有沒有東西，
    // 先認領再發現是空的會把今天記成發過，當天真正的摘要就再也出不去了。
    // 週報壞了只記 log，不准拖垮摘要本體。
    const insights = weeklyWindowOpen && cfg.weeklyInsights !== false
      ? await buildWeeklyInsights(db, ws, today).catch((e) => {
          console.warn('[weekly-insights] build failed:', ws, e)
          return null
        })
      : null

    // 認領排在所有「發不發」的判斷之後、推播之前:提早認領會讓「時段還沒到」也被
    // 記成今天發過(整天就沒摘要了),延後認領則擋不住重複。
    if (!(await claimDailyDigest(db, stateRef, ws, today))) continue

    // 摘要既然要發了,順路查一次黃級異常(D-36①):黃級只在後台顯示,「推播沒送出去」
    // 這種事商家幾天不開後台就永遠不知道。只跑營運類探針(canSettings:false＝
    // 純 Firestore 窄查詢,不打 LINE/LIFF 外部 API)。
    // ⛔刻意只搭已經要發的摘要,不讓黃級異常單獨觸發——單獨觸發得每輪對全租戶跑探針,
    // 成本形狀跟 08-11 讀取費暴衝同款。查掛了就當沒有,不准拖垮摘要本體。
    const digestWarnings = await collectWorkspaceAlerts(db, ws, { canSettings: false, canOperate: true })
      .then(async (items) => {
        const active = new Set(items.filter(a => a.state === 'active').map(a => a.id))
        // renewalNotBound 不在營運探針組,單獨查這一顆（一次純 Firestore 等值查詢）——
        // 它是唯一「付了錢的客戶會被靜默降級」的黃級,2026-08-28 拍板收進尾巴
        // （規則與理由見 shared/types/alerts.ts 的 DIGEST_WARNING_ALERTS）。
        if (await countRecentUnboundRenewals(db, ws).catch(() => 0))
          active.add('renewalNotBound')
        // DIGEST_WARNING_ALERTS 的順序＝重要度,「最重要」取第一個命中的
        return DIGEST_WARNING_ALERTS.filter(id => active.has(id))
      })
      .catch((e) => {
        console.warn('[backlog-digest] warning probes failed:', ws, e)
        return []
      })

    // 文案與排版全部在 daily-digest-message.ts（純函式，規則逐條有測試）
    const lines = buildDigestLines({
      dateLabel: taipeiDateLabel(today),
      yesterday,
      waiting: waiting ?? { count: 0, offHoursCount: 0, samples: [], truncated: false, staleHumanCount: 0 },
      todo: {
        outdatedSources: counts.outdatedSources ?? 0,
        failedSources: counts.failedSources ?? 0,
        expiredCards: counts.expiredCards ?? 0,
        suggestions: counts.suggestions ?? 0,
        tagSuggestUsers: counts.tagSuggestUsers ?? 0,
        warnings: digestWarnings.length,
        topWarningLabel: digestWarnings.length ? ALERT_LABELS[digestWarnings[0]!] : '',
      },
      festivalText: festival ? festivalReminderText(festival) : '',
      weeklyLines: insights ?? [],
      unknownNotes,
    })
    // 連昨天的數字都查不到、又沒有任何事可講 → 整則不發，但名額已經認領掉了，
    // 所以要拆章讓下一輪重來（否則今天就再也沒有摘要）
    if (!lines) {
      await releaseDailyDigest(stateRef, ws)
      continue
    }
    const msg: messagingApi.TextMessage = { type: 'text', text: lines.join('\n') }
    try {
      const results = await Promise.allSettled(cfg.lineUserIds.map(uid => pushMessage(uid, [msg], ws)))
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          // 最常見原因：該人員不是此官方帳號好友。名單全掛也不重試（設定問題，
          // 重試只會每輪重打 LINE API），所以這裡只記 log、不拆章。
          console.warn('[backlog-digest] push failed for', cfg.lineUserIds[i], (r.reason as any)?.message ?? r.reason)
        }
      })
    }
    catch (err) {
      // 真的丟例外（撈憑證失敗等）→ 拆章，下一輪重來
      console.warn('[backlog-digest] push threw:', ws, err)
      await releaseDailyDigest(stateRef, ws)
      continue
    }
    // 只有真的送出去才記里程碑：上面拆章重來時,這個節日還要能再講一次
    if (festival) {
      await recordFestivalReminder(
        festivalStateRef, ws, festivalState[ws] ?? {},
        festival.festival.id, festival.milestone, today,
      )
      festivalsSent++
    }
    notified++
  }

  const tally = {
    workspacesScanned: targetWorkspaces.length,
    workspacesNotified: notified,
    festivalReminders: festivalsSent,
  }
  if (notified) console.log('[conversation:backlog-digest]', tally)
  return tally
}

// ── 知識卡有效期限：到期自動停用 ─────────────────────────────────────
// 行銷快訊類卡片（募資 / 折扣 / 出貨進度）設了 activeUntil，到期由這支改 status='disabled'
// 並把期限搬到 expiredAt（否則到期卡每輪都被重撈）。答題端另有當場過濾兜底（searchSimilarChunks），
// 這裡是正式下架 + 通知管理員。單一欄位 range 查詢走自動索引，跨全 workspace 一次掃。

const EXPIRE_SCAN_LIMIT = 200

export async function expireKnowledgeCards(db: Firestore) {
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('activeUntil', '<=', Timestamp.now())
    .limit(EXPIRE_SCAN_LIMIT)
    .get()
  if (snap.empty) return { expired: 0 }

  let expired = 0
  for (const d of snap.docs) {
    const c = d.data() as any
    const status = String(c.status ?? 'pending')
    // pending 先放著（幾秒後就會 indexed，下一輪再處理）；disabled 只搬欄位去重
    if (status === 'pending') continue
    const patch: Record<string, unknown> = {
      activeUntil: FieldValue.delete(),
      expiredAt: c.activeUntil,
      updatedAt: FieldValue.serverTimestamp(),
    }
    // failed 也要一併 disabled：到期當天剛好 embedding 失敗的卡，若只搬欄位不改狀態，
    // 十分鐘後 retry 排程把它重試成功就寫回 indexed——而 activeUntil 已被搬走，
    // 這裡不會再撈到它第二次 → 過期卡永久復活。disabled 讓它離開 retry 佇列（查詢只撈 pending/failed）。
    if (status === 'indexed' || status === 'failed') {
      patch.status = 'disabled'
      expired++
    }
    await d.ref.update(patch).catch(e => console.warn(`[expire-knowledge-cards] ${d.id} update failed:`, e))
  }
  // 到期是預先知道的事,不即時推播(2026-08-06 拍板);expiredAt 標記由每日摘要
  // 撈近 24 小時的下架卡統一提一句,細節到後台知識庫看。

  const tally = { expired, scanned: snap.size }
  if (expired) console.log('[ai:expire-knowledge-cards]', tally)
  return tally
}

// ═══════════════════════════════════════════════════════════════════
//  回收桶到期清運
//  軟刪除（單卡刪除 / resync delete_old / gsheet 同步刪列）只標 deletedAt + purgeAfter，
//  這支把過了保留期（RECYCLE_RETENTION_DAYS）的卡與連坐的 manual 來源真刪。
//  單一欄位 range 查詢走自動索引。
// ═══════════════════════════════════════════════════════════════════

const PURGE_SCAN_LIMIT = 200

export async function purgeRecycledKnowledge(db: Firestore) {
  const now = Timestamp.now()
  let purged = 0
  let failed = 0
  for (const col of [KNOWLEDGE_CHUNKS_COLLECTION, KNOWLEDGE_SOURCES_COLLECTION]) {
    const snap = await db.collection(col)
      .where('purgeAfter', '<=', now)
      .limit(PURGE_SCAN_LIMIT)
      .get()
    for (const d of snap.docs) {
      // 逐筆刪並照實計數——「deleted 恆等於 scanned」的假回報是健檢明列的反模式
      try {
        await d.ref.delete()
        purged++
      }
      catch (e) {
        failed++
        console.warn(`[ai:purge-recycled] ${col}/${d.id} delete failed:`, e)
      }
    }
  }
  const tally = { purged, failed }
  if (purged || failed) console.log('[ai:purge-recycled]', tally)
  return tally
}

// ── 嚴重異常主動推到 LINE（D-8②）────────────────────────────────────────
// 小幫手面板只有「人打開後台」才看得到。壞得最嚴重的那幾種（機器人收不到訊息、
// AI 停止回覆、活動連結打不開）通常沒人在看的時候發生，等商家想到要開後台，
// 客人已經被晾了幾小時。這支把**紅色那一級**主動送到值班人員的 LINE。
//
// ⛔ 只推 critical。warning／suggestion 推了就是狼來了，久了連真的紅燈都會被忽略。
// ⛔ 名單沿用「轉真人通知」那一份（handoffNotify.lineUserIds），不另設第二份——
//    第二份名單＝第二個要維護的東西、第二個會忘記填的欄位，而收通知的本來就是同一批人。

/** 一件事最多多久提醒一次：同一個紅燈天天講一次（會煩但不至於淹沒），不是每輪都講 */
const CRITICAL_PUSH_REPEAT_MS = 24 * 3600_000
/** 每個 workspace 多久檢查一次：這輪要跑整套異常彙總，不必每 10 分鐘跑一遍 */
const CRITICAL_PUSH_CHECK_INTERVAL_MS = 60 * 60_000
/** 只在這個時段推（台北時間）。半夜把人吵醒他也修不了，隔天早上照樣會講 */
const CRITICAL_PUSH_HOUR_FROM = 9
const CRITICAL_PUSH_HOUR_TO = 21
/** 一則訊息最多列幾條，其餘用「還有 N 件」帶過（LINE 訊息太長會被截斷） */
const CRITICAL_PUSH_MAX_LINES = 5
/** workspaces 全掃上限（同節慶提醒：這件事跟有沒有積壓無關，得從帳號出發） */
const CRITICAL_PUSH_WORKSPACE_CAP = 2000

type CriticalPushState = Record<string, { checkedAt?: number, sent?: Record<string, number> }>

/** 一行：標題（幾個）＋補充；系統側的當場說明不用他動手 */
function criticalAlertLine(item: WorkspaceAlertItem): string {
  const label = ALERT_LABELS[item.id] ?? item.id
  const detail = item.detail ? `（${item.detail}）` : ''
  const sys = SYSTEM_OWNED_ALERTS.has(item.id) ? '（系統這邊的狀況，不用你操作）' : ''
  return `・${label}${detail}${sys}`
}

export async function pushCriticalAlerts(db: Firestore) {
  const now = Date.now()
  const taipeiHour = new Date(now + 8 * 3600_000).getUTCHours()
  // 時段外整支早退：一個查詢都不做（一天有一半的時間落在這裡）
  if (taipeiHour < CRITICAL_PUSH_HOUR_FROM || taipeiHour >= CRITICAL_PUSH_HOUR_TO)
    return { skipped: 'off-hours' as const }

  const stateRef = db.collection('cronState').doc('critical-alert-push')
  const state = ((await stateRef.get()).data() ?? {}) as CriticalPushState

  const wsSnap = await db.collection('workspaces').select().limit(CRITICAL_PUSH_WORKSPACE_CAP).get()
  let checked = 0
  let notified = 0

  for (const doc of wsSnap.docs) {
    const wid = doc.id
    const prev = state[wid] ?? {}
    // 節流擋在最前面：擋不住的話每 10 分鐘就要跑一整套異常彙總 ×每個帳號
    if (prev.checkedAt && now - prev.checkedAt < CRITICAL_PUSH_CHECK_INTERVAL_MS) continue

    const settings = await getAiSettings(wid, db)
    const cfg = settings.handoffNotify
    // 沒開通知、沒有人收、或商家把這顆關掉 → 不查也不推（省掉整套彙總查詢）
    if (!cfg.enabled || !cfg.lineUserIds.length || !cfg.criticalAlertPush) continue

    let items: WorkspaceAlertItem[]
    try {
      // 排程沒有「使用者」，兩種權限都給：這是在看整個帳號的狀態，不是某個人看得到什麼
      items = await collectWorkspaceAlerts(db, wid, { canSettings: true, canOperate: true })
    }
    catch (err) {
      console.warn('[critical-alert-push] collect failed:', wid, err)
      continue
    }
    checked++
    await stateRef.set({ [wid]: { checkedAt: now } }, { merge: true })
      .catch(err => console.warn('[critical-alert-push] checkedAt write failed:', wid, err))

    // ⚠️ 只認 active。unknown（這次查不到）刻意不推——「查不到」不是「壞掉」，
    // 拿它推播就是把我方的查詢失敗當成商家的災情，一次誤報就會讓人關掉這個功能。
    let criticals = items.filter(i => i.state === 'active' && severityOf(i) === 'critical')
    // 額度用完有自己的專屬通知（🚫 那則：發生當下就推、寫了用量與後果、每期一次）。
    // 同一期那則已經**送達**的話，這裡讓路——不然額度用完那天會連收兩則講同一件事
    // （2026-08-28 拍板修）。專屬那則全滅重試中則照講：寧可重複，不可漏報。
    if (criticals.some(i => i.id === 'quotaExceeded')) {
      const already = await wasQuotaExhaustedNotified(wid, settings.quota?.monthlyTokenCap ?? 0, db)
        .catch(() => false) // 查不到就當沒發過 → 照講（漏報比重複糟）
      if (already) criticals = criticals.filter(i => i.id !== 'quotaExceeded')
    }
    const sent = prev.sent ?? {}
    const fresh = criticals.filter(i => now - (sent[i.id] ?? 0) >= CRITICAL_PUSH_REPEAT_MS)
    if (!fresh.length) {
      // 已經全部講過（還在冷卻）→ 只把已修好的從紀錄裡拿掉，讓它再壞時能立刻再講
      const stillBroken = new Set(criticals.map(i => i.id))
      const stale = Object.keys(sent).filter(id => !stillBroken.has(id as typeof criticals[number]['id']))
      if (stale.length) {
        const patch: Record<string, unknown> = {}
        for (const id of stale) patch[id] = FieldValue.delete()
        await stateRef.set({ [wid]: { sent: patch } }, { merge: true })
          .catch(err => console.warn('[critical-alert-push] prune failed:', wid, err))
      }
      continue
    }

    const shown = fresh.slice(0, CRITICAL_PUSH_MAX_LINES)
    const lines = [
      fresh.length === 1 ? '🔴 有 1 件事正在影響客人' : `🔴 有 ${fresh.length} 件事正在影響客人`,
      ...shown.map(criticalAlertLine),
    ]
    if (fresh.length > shown.length) lines.push(`・還有 ${fresh.length - shown.length} 件，請到後台看`)
    lines.push('請開後台，右下角的小幫手會告訴你每一件要怎麼處理。')

    const msg: messagingApi.TextMessage = { type: 'text', text: lines.join('\n') }
    let anyDelivered = false
    try {
      const results = await Promise.allSettled(cfg.lineUserIds.map(uid => pushMessage(uid, [msg], wid)))
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') anyDelivered = true
        else console.warn('[critical-alert-push] push failed for', cfg.lineUserIds[i], (r.reason as Error)?.message ?? r.reason)
      })
    }
    catch (err) {
      console.warn('[critical-alert-push] push threw:', wid, err)
    }
    // ⛔ 一則都沒送成功就不要記「已通知」：記了的話這件事要 24 小時後才會再試，
    //    而商家從頭到尾沒收到任何東西
    if (!anyDelivered) continue

    const patch: Record<string, unknown> = {}
    for (const i of fresh) patch[i.id] = now
    // 順手把已經修好的從紀錄裡拿掉（同上：再壞時要能立刻再講）
    const stillBroken = new Set(criticals.map(i => i.id))
    for (const id of Object.keys(sent)) {
      if (!stillBroken.has(id as typeof criticals[number]['id'])) patch[id] = FieldValue.delete()
    }
    await stateRef.set({ [wid]: { sent: patch } }, { merge: true })
      .catch(err => console.warn('[critical-alert-push] record failed:', wid, err))
    notified++
  }

  const tally = { workspacesChecked: checked, workspacesNotified: notified }
  if (notified) console.log('[alerts:critical-push]', tally)
  return tally
}
