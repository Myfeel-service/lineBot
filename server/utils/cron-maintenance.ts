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
import { tryAutoApplyMinorChange } from './ai-knowledge-autoapply'
import { extractUrlText } from './ai-source-extractors'
import { syncGoogleSheetSource } from './gsheet-sync'
import { handBackSessionToBot } from './conversation-session'
import { getAiSettings } from './ai-settings'
import { notifyHandoffToStaff, notifyKnowledgeSourceEvent } from './ai-handoff-notify'
import { pushMessage } from './line'
import type { messagingApi } from '@line/bot-sdk'
import { WEBHOOK_EVENT_LOCKS_COLLECTION } from './webhook-dedup'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { HUMAN_STALE_HOURS } from '~~/shared/types/conversation-stats'
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
      const r = await syncGoogleSheetSource(db, data.workspaceId, sourceId, data)
      // 同步成功就清掉失敗標記（連 unchanged 也要清）。少了這段，商家把 Sheet 分享權限
      // 修好、同步其實已經成功，體檢仍永遠顯示「來源同步失敗」——做對了也看不到結果。
      // 注意不能沿用下面 url 分支的 clearFailure：那個變數宣告在本分支的 return 之後。
      await clearSourceFailure(db, sourceId, data.status)
      if (r.outcome === 'unchanged') return { sourceId, outcome: 'unchanged' }
      // 自動套用後給一份摘要通知——自動化不等於無聲,管理員要知道知識庫剛剛變了什麼
      notifyKnowledgeSourceEvent(data.workspaceId, [
        '📗 Google 試算表知識已自動同步',
        `來源：${sourceTitleOf(data)}`,
        `新增 ${r.added}、更新 ${r.updated}、刪除 ${r.deleted} 張知識卡。`,
      ].join('\n')).catch(e => console.warn('[detect-source-updates] notify gsheet failed:', e))
      return { sourceId, outcome: 'gsheet_synced', message: `+${r.added} ~${r.updated} -${r.deleted}` }
    }

    if (data.type !== 'url' || !data.url) {
      return { sourceId, outcome: 'unchanged' } // 不該被撈到，保險
    }

    const extracted = await extractUrlText(data.url)
    const newHash = await sha256(extracted.text)

    // 檢查成功：清掉先前的失敗標記（說明見 buildSourceClearFailure）
    const clearFailure = buildSourceClearFailure(data.status)

    // 首次觀測（匯入時前端沒帶 hash → contentHash 為空）：只存 baseline,不標 outdated。
    // 內容並沒有「變」,只是還沒有比較基準;沒有這個分支的話,每個新 URL 來源
    // 第一次排程必被誤報「偵測到變動」,狼來了幾次使用者就不理警示了。
    if (!data.contentHash) {
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
        contentHash: newHash,
        lastFetchedAt: FieldValue.serverTimestamp(),
        ...clearFailure,
      })
      return { sourceId, outcome: 'unchanged' }
    }

    // 比對 contentHash
    if (data.contentHash === newHash) {
      // 沒變 → 只更新 lastFetchedAt。先前若有「待確認新值」代表內容又跳回原樣
      // （輪播/隨機區塊的假變動），一併清掉。
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
        lastFetchedAt: FieldValue.serverTimestamp(),
        pendingHash: FieldValue.delete(),
        ...clearFailure,
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
    const applied = String(data.appliedContentHash ?? '').trim()
    if (applied && applied === newHash) {
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
        contentHash: newHash,
        pendingHash: FieldValue.delete(),
        outdatedAt: null,
        lastFetchedAt: FieldValue.serverTimestamp(),
        ...clearFailure,
      })
      return { sourceId, outcome: 'unchanged', message: 'back-to-applied-version' }
    }

    // 與上次不同：先不算真變——輪播 / 隨機推薦 / 計數器頁面每次抓 hash 都不同，一次差異就
    // 通知會狼來了。新值先記 pendingHash，**下一輪仍是同一個新值才確認變動**；
    // 又變成別的值則以最新值重新等待。代價：真變動晚一個檢查週期通知。
    if (data.pendingHash !== newHash) {
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
        pendingHash: newHash,
        lastFetchedAt: FieldValue.serverTimestamp(),
        ...clearFailure,
      })
      return { sourceId, outcome: 'unchanged', message: 'pending-change（待下一輪確認）' }
    }

    // 變了（連兩輪抓到同一個新值）：依設定決定行為
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
      db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
        contentHash: newHash,
        pendingHash: FieldValue.delete(),
        lastFetchedAt: FieldValue.serverTimestamp(),
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
        const auto = await tryAutoApplyMinorChange(db, sourceId, data, extracted.text)
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
          notifyKnowledgeSourceEvent(data.workspaceId, [
            '📘 知識庫來源已自動更新',
            `來源：${sourceTitleOf(data)}`,
            `偵測到小幅文字變動,已自動更新 ${auto.updated} 張知識卡${auto.failed ? `(另有 ${auto.failed} 張索引失敗,排程會重試)` : ''}。`,
            '新增、刪除或大幅改版仍會等你人工確認才套用。',
          ].join('\n')).catch(e => console.warn('[detect-source-updates] notify auto-apply failed:', e))
          return { sourceId, outcome: 'auto_applied', message: `~${auto.updated}` }
        }
        // 不符合自動條件 → 走人工審,通知帶上原因(店家知道為什麼要自己看)
        await commitChange()
        await markSourceOutdated(db, sourceId)
        notifyKnowledgeSourceEvent(data.workspaceId, [
          '📚 知識庫來源內容有變動',
          `來源：${sourceTitleOf(data)}`,
          `這次變動不適合自動更新(${auto.reason}),請至後台「AI 知識庫」檢視差異,決定是否更新知識卡。`,
        ].join('\n')).catch(e => console.warn('[detect-source-updates] notify change failed:', e))
        return { sourceId, outcome: 'changed_notified' }
      }
      await commitChange()
      await markSourceOutdated(db, sourceId)
      // 主動推播（不只後台標記——標記沒人天天看,變動掛一個月也沒人知道）。
      // 頻率天然去重:contentHash 已更新,下次檢查 unchanged 就不會再進到這裡。
      notifyKnowledgeSourceEvent(data.workspaceId, [
        '📚 知識庫來源內容有變動',
        `來源：${sourceTitleOf(data)}`,
        '偵測到來源內容與上次不同。請至後台「AI 知識庫」檢視差異，決定是否更新知識卡。',
      ].join('\n')).catch(e => console.warn('[detect-source-updates] notify change failed:', e))
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
    // 只在「連續第 3 次失敗、剛跨過門檻標成 failed」時通知一次——之後每輪檢查仍會失敗,
    // 但 failCount 已 >3 不再吵人(gsheet 403 壞半個月沒人知道的教訓;修好後 clearFailure 歸零)。
    if (failCount === 3) {
      notifyKnowledgeSourceEvent(data.workspaceId, [
        '⚠️ 知識庫來源同步失敗',
        `來源：${sourceTitleOf(data)}`,
        `原因：${msg}`,
        '在修復之前,這個來源的知識卡會停留在最後一次成功同步的內容。請至後台「AI 知識庫」檢查。',
      ].join('\n')).catch(e => console.warn('[detect-source-updates] notify failure failed:', e))
    }
    return { sourceId, outcome: 'error', message: msg }
  }
}

/**
 * 對 type='url' 的 source 做變動偵測、type='gsheet' 做自動同步。
 * 每張 source 的實際頻率由自身 refreshIntervalMinutes 決定（含失敗退避），
 * 呼叫端頻率高於來源頻率時只是空查詢。
 */
export async function detectSourceUpdates(db: Firestore) {
  // 撈候選來源：refreshIntervalMinutes > 0（url 偵測 + gsheet 自動同步共用此排程）。
  // 只用單一不等式查詢（免複合索引），type 在 JS 端篩。
  // 進一步用 lastFetchedAt 過濾「到時間了」會比較準，但 Firestore 不易做時間區間查詢，
  // 一律撈出來後用 JS 過濾 — 工作區 source 通常不會多到爆。
  const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('refreshIntervalMinutes', '>', 0)
    .limit(SOURCE_SCAN_LIMIT * 5) // 撈寬一點，過濾後再砍到 SCAN_LIMIT
    .get()

  const now = Date.now()
  const dueDocs: Array<{ id: string; data: KnowledgeSourceDoc }> = []
  for (const d of snap.docs) {
    const data = d.data() as KnowledgeSourceDoc
    if (data.type !== 'url' && data.type !== 'gsheet') continue
    // 退避：失敗的檢查不更新 lastFetchedAt，若只看它會每次排程都重打掛掉的網站。
    // 以「最後一次嘗試」（成功或失敗）起算間隔。
    const lastMs = Math.max(tsToMs(data.lastFetchedAt), tsToMs(data.lastCheckedAt))
    const intervalMs = Number(data.refreshIntervalMinutes || 0) * 60_000
    if (!intervalMs) continue
    if (lastMs && (now - lastMs) < intervalMs) continue
    dueDocs.push({ id: d.id, data })
    if (dueDocs.length >= SOURCE_SCAN_LIMIT) break
  }

  if (!dueDocs.length) return { scanned: 0 }

  // 用 concurrency pool 跑 check;自動套用限額由整輪共用(見 AUTO_APPLY_BUDGET_PER_RUN)
  const run: DetectRunState = { autoApplyRemaining: AUTO_APPLY_BUDGET_PER_RUN }
  const results: SourceCheckResult[] = []
  let cursor = 0
  async function worker() {
    while (cursor < dueDocs.length) {
      const i = cursor++
      const doc = dueDocs[i]!
      const r = await checkOneSource(db, doc.id, doc.data, run)
      results.push(r)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SOURCE_FETCH_CONCURRENCY, dueDocs.length) }, worker),
  )

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

// ── 轉真人逾時 SLA 提醒 ────────────────────────────────────────────────────

/**
 * pending_human 超過 aiSettings.handoffNotify.slaRemindMinutes 仍無人回應
 * → 再推播提醒值班客服一次。每場會話只提醒一次（session.slaRemindedAt 標記）。
 */
export async function remindOverdueHandoffs(db: Firestore) {
  const snap = await db.collection('conversationSessions')
    .where('status', '==', 'pending_human')
    .limit(SESSION_SCAN_LIMIT)
    .get()

  const now = Date.now()
  let reminded = 0
  let skipped = 0

  for (const doc of snap.docs) {
    const data = doc.data() as any
    const workspaceId = String(data?.workspaceId ?? '')
    const lineUserId = String(data?.userId ?? '')
    if (!workspaceId || !lineUserId) continue

    try {
      if (data.slaRemindedAt || data.humanFirstRepliedAt) {
        skipped++
        continue
      }
      const requestedMs = tsToMs(data.handoffRequestedAt)
      if (!requestedMs) continue

      // getAiSettings 有 60 秒 in-memory cache，同 workspace 多筆不重複讀
      const settings = await getAiSettings(workspaceId, db)
      const sla = settings.handoffNotify.slaRemindMinutes
      if (!settings.handoffNotify.enabled || !sla) {
        skipped++
        continue
      }
      if (now - requestedMs < sla * 60_000) {
        skipped++
        continue
      }

      // 撈 displayName 讓提醒訊息可讀（一場會話只發一次，這個讀取量可接受）
      const convSnap = await db.collection('conversations')
        .doc(lineUserFirestoreDocId(lineUserId, workspaceId))
        .get()
        .catch(() => null)
      const displayName = String(convSnap?.data()?.displayName ?? '') || lineUserId

      await notifyHandoffToStaff({
        workspaceId,
        customerLineUserId: lineUserId,
        customerName: displayName,
        customerMessage: '',
        reason: null,
        slaReminderMinutes: sla,
      })
      await doc.ref.update({ slaRemindedAt: FieldValue.serverTimestamp() })
      reminded++
    }
    catch (err) {
      console.warn('[handoff-sla] session check failed:', doc.id, err)
    }
  }

  const tally = { scanned: snap.size, reminded, skipped }
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

// ── 每日積壓/漏接摘要 ────────────────────────────────────────────────────
// 「客人等到流失沒人知道」的解法:每天早上把「還在等真人的、卡在真人手上太久的」
// 對話數量推播給轉真人通知名單。與 SLA 提醒同一套 status 單欄查詢(免複合索引)。
// 每 workspace 每天最多一則(標記存 cronState/backlog-digest);沒積壓就不打擾。

const DIGEST_HOUR_TAIPEI = 9 // 台北時間 9 點後的第一次排程觸發才發

export async function dailyBacklogDigest(db: Firestore) {
  const taipeiNow = new Date(Date.now() + 8 * 3600_000)
  if (taipeiNow.getUTCHours() < DIGEST_HOUR_TAIPEI) return { skipped: 'before-hour' }
  const today = taipeiNow.toISOString().slice(0, 10)

  const stateRef = db.collection('cronState').doc('backlog-digest')
  const state = ((await stateRef.get()).data() ?? {}) as Record<string, string>

  const [pendingSnap, humanSnap] = await Promise.all([
    db.collection('conversationSessions').where('status', '==', 'pending_human').limit(SESSION_SCAN_LIMIT).get(),
    db.collection('conversationSessions').where('status', '==', 'human_handling').limit(SESSION_SCAN_LIMIT).get(),
  ])

  interface Agg { pending: number; pendingOldestH: number; stale: number }
  const byWs = new Map<string, Agg>()
  const nowMs = Date.now()
  const aggOf = (ws: string): Agg => {
    const a = byWs.get(ws) ?? { pending: 0, pendingOldestH: 0, stale: 0 }
    byWs.set(ws, a)
    return a
  }
  for (const doc of pendingSnap.docs) {
    const d = doc.data() as any
    const ws = String(d?.workspaceId ?? '')
    if (!ws) continue
    const sinceMs = tsToMs(d.handoffRequestedAt) || tsToMs(d.lastActivityAt)
    const a = aggOf(ws)
    a.pending++
    if (sinceMs) a.pendingOldestH = Math.max(a.pendingOldestH, (nowMs - sinceMs) / 3600_000)
  }
  for (const doc of humanSnap.docs) {
    const d = doc.data() as any
    const ws = String(d?.workspaceId ?? '')
    if (!ws) continue
    const lastMs = tsToMs(d.humanLastRepliedAt) || tsToMs(d.lastActivityAt)
    if (lastMs && nowMs - lastMs >= HUMAN_STALE_HOURS * 3600_000) aggOf(ws).stale++
  }

  let notified = 0
  const statePatch: Record<string, string> = {}
  for (const [ws, agg] of byWs) {
    if (state[ws] === today) continue // 今天發過
    if (!agg.pending && !agg.stale) continue
    const settings = await getAiSettings(ws, db)
    const cfg = settings.handoffNotify
    if (!cfg.enabled || !cfg.lineUserIds.length) continue

    const lines = ['📋 客服積壓每日提醒']
    if (agg.pending) lines.push(`・${agg.pending} 位客人在「等待真人」(最久約 ${Math.max(1, Math.round(agg.pendingOldestH))} 小時)`)
    if (agg.stale) lines.push(`・${agg.stale} 條對話停在「真人處理中」超過 ${HUMAN_STALE_HOURS} 小時 — AI 暫停中,處理完請按「交回機器人」或「結束對話」`)
    lines.push('請到後台「對話」頁查看。')
    const msg: messagingApi.TextMessage = { type: 'text', text: lines.join('\n') }
    await Promise.allSettled(cfg.lineUserIds.map(uid => pushMessage(uid, [msg], ws)))
    statePatch[ws] = today
    notified++
  }
  if (Object.keys(statePatch).length) await stateRef.set(statePatch, { merge: true })

  const tally = { pendingScanned: pendingSnap.size, humanScanned: humanSnap.size, workspacesNotified: notified }
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

  const byWs = new Map<string, string[]>()
  let expired = 0
  for (const d of snap.docs) {
    const c = d.data() as any
    const status = String(c.status ?? 'pending')
    // pending 先放著（幾秒後就會 indexed，下一輪再處理）；disabled/failed 只搬欄位去重，不通知
    if (status === 'pending') continue
    const patch: Record<string, unknown> = {
      activeUntil: FieldValue.delete(),
      expiredAt: c.activeUntil,
      updatedAt: FieldValue.serverTimestamp(),
    }
    if (status === 'indexed') {
      patch.status = 'disabled'
      expired++
      const ws = String(c.workspaceId ?? '')
      if (ws) {
        const list = byWs.get(ws) ?? []
        list.push(String(c.title ?? '(未命名卡片)'))
        byWs.set(ws, list)
      }
    }
    await d.ref.update(patch).catch(e => console.warn(`[expire-knowledge-cards] ${d.id} update failed:`, e))
  }

  for (const [ws, titles] of byWs) {
    const shown = titles.slice(0, 5).map(t => `・${t}`)
    if (titles.length > 5) shown.push(`…等共 ${titles.length} 張`)
    notifyKnowledgeSourceEvent(ws, [
      '⏳ 知識卡已到期，AI 停止引用',
      ...shown,
      '要延長或重新啟用，請至後台「AI 知識庫」編輯該卡。',
    ].join('\n')).catch(e => console.warn('[expire-knowledge-cards] notify failed:', e))
  }

  const tally = { expired, scanned: snap.size }
  if (expired) console.log('[ai:expire-knowledge-cards]', tally)
  return tally
}
