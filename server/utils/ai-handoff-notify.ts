/**
 * Handoff 通知：AI / 腳本把對話轉真人時，用官方帳號推播提醒指定客服人員。
 *
 * 設定來源：aiSettings.handoffNotify（enabled + lineUserIds）。
 * 限制：收通知的人必須是此官方帳號的好友（LINE push 的先天限制），設定頁有註明。
 * 同一位客人 10 分鐘內只通知一次（per-instance in-memory 節流；多實例下最壞情況
 * 是各實例各通知一次，可接受——通知漏發比重複發更糟）。
 */
import type { messagingApi } from '@line/bot-sdk'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { pushMessage } from './line'
import { getAiSettings } from './ai-settings'
import { getDb } from './firebase'
import { isServiceHoursDnd } from '~~/shared/time'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { HANDOFF_REASON_LABELS } from '~~/shared/types/ai-knowledge'
import type { HandoffReason } from '~~/shared/types/ai-knowledge'
import { capMapSize } from './bounded-cache'

const NOTIFY_THROTTLE_MS = 10 * 60 * 1000
const NOTIFY_MAP_MAX_ENTRIES = 5000
const lastNotifiedAt = new Map<string, number>()

/**
 * 節流閘門：同一位客人 NOTIFY_THROTTLE_MS 內只通知一次。
 * 回傳 true = 可以發（並已記下時間）；false = 太近了，這次別發。
 */
function markNotified(workspaceId: string, customerLineUserId: string, now: number): boolean {
  const key = `${workspaceId}:${customerLineUserId}`
  if (now - (lastNotifiedAt.get(key) ?? 0) < NOTIFY_THROTTLE_MS) return false
  lastNotifiedAt.set(key, now)
  capMapSize(lastNotifiedAt, NOTIFY_MAP_MAX_ENTRIES)
  return true
}

export interface HandoffNotifyParams {
  workspaceId: string
  /** 客人的 LINE userId（節流 key 用） */
  customerLineUserId: string
  /** 客人顯示名稱；沒有就帶 userId */
  customerName: string
  /** 觸發 handoff 的那則客人訊息（腳本流程可為空） */
  customerMessage: string
  /** null = 非 AI 護欄觸發（例如腳本設定轉真人） */
  reason: HandoffReason | null
  /** AI 生成的 2–3 句對話摘要（best-effort，可為空字串 → 不顯示該行） */
  summary?: string
  /** SLA 提醒模式：轉真人後超過 N 分鐘無人回應的再提醒（訊息格式不同） */
  slaReminderMinutes?: number
}

/**
 * 回傳值 = 這次有沒有真的推播出去。呼叫端（SLA 逾時提醒）要據此決定要不要蓋
 * slaRemindedAt——被勿擾/節流吞掉卻蓋了章，那一場的提醒就永遠補不回來。
 * （missed_only 當下不推但已存檔，回 false 也是對的：真正的通知由超時那一則發。）
 */
export async function notifyHandoffToStaff(params: HandoffNotifyParams): Promise<boolean> {
  const settings = await getAiSettings(params.workspaceId).catch(() => null)
  const cfg = settings?.handoffNotify
  if (!cfg?.enabled || !cfg.lineUserIds.length) return false

  // missed_only 模式：轉真人當下不推播,把通知內容存到 conversations doc;
  // 超時仍沒人接手時 remindOverdueHandoffs 會撈回來,發成一則完整的請求通知。
  // 存檔不算打擾,所以放在勿擾檢查之前——勿擾時段轉真人的內容也要留下來,
  // 否則上班後發的那一則會缺摘要。
  if (cfg.mode === 'missed_only' && !params.slaReminderMinutes) {
    const docId = lineUserFirestoreDocId(params.customerLineUserId, params.workspaceId)
    await getDb().collection('conversations').doc(docId).set({
      handoffNotifyContext: {
        summary: params.summary?.trim().slice(0, 300) ?? '',
        message: params.customerMessage.trim().slice(0, 200),
        reason: params.reason,
        at: FieldValue.serverTimestamp(),
      },
    }, { merge: true }).catch(e => console.warn('[handoff-notify] context save failed:', e))
    return false
  }

  // 勿擾時段內不推播（含腳本/AI 觸發與 SLA 再提醒）：轉真人照常發生,只是不吵客服;
  // 客服上班回來看「對話」佇列即可。這是所有 handoff 通知的單一收斂點。
  if (isServiceHoursDnd(settings?.serviceHours)) return false

  const now = Date.now()
  if (!markNotified(params.workspaceId, params.customerLineUserId, now)) return false

  const reasonLabel = params.reason
    ? (HANDOFF_REASON_LABELS[params.reason] ?? params.reason)
    : '腳本轉真人'
  const hasContext = Boolean(params.summary?.trim() || params.customerMessage.trim())
  const lines = params.slaReminderMinutes
    // missed_only 的首次通知帶完整內容（摘要/訊息由 remindOverdueHandoffs 從存檔補回）;
    // always 模式的再提醒維持短版——完整內容第一則已經發過了。
    ? (hasContext
        ? [
            `🙋 真人客服請求（已等超過 ${params.slaReminderMinutes} 分鐘沒人接手）`,
            `客人：${params.customerName}`,
            ...(params.summary?.trim() ? [`📋 摘要：${params.summary.trim()}`] : []),
            ...(params.customerMessage.trim() ? [`訊息：${params.customerMessage.trim().slice(0, 200)}`] : []),
            `原因：${reasonLabel}`,
            '請至後台「對話」頁回覆。',
          ]
        : [
            '⏰ 提醒：真人客服請求尚未回應',
            `客人：${params.customerName}`,
            `已等待超過 ${params.slaReminderMinutes} 分鐘`,
            '請至後台「對話」頁回覆。',
          ])
    : [
        '🙋 真人客服請求',
        `客人：${params.customerName}`,
        ...(params.summary?.trim() ? [`📋 摘要：${params.summary.trim()}`] : []),
        ...(params.customerMessage.trim() ? [`訊息：${params.customerMessage.trim().slice(0, 200)}`] : []),
        `原因：${reasonLabel}`,
        '請至後台「對話」頁回覆。',
      ]
  const msg: messagingApi.TextMessage = { type: 'text', text: lines.join('\n') }

  const results = await Promise.allSettled(
    cfg.lineUserIds.map(uid => pushMessage(uid, [msg], params.workspaceId)),
  )
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      // 最常見原因：該人員不是此官方帳號好友
      console.warn('[handoff-notify] push failed for', cfg.lineUserIds[i], r.reason?.message ?? r.reason)
    }
  })
  // 名單上全部推播失敗（例如都不是好友）仍算「已發」：那是設定問題，
  // 重試也只會一直失敗，蓋章讓它停在後台待辦裡比每輪重打 LINE API 好。
  return true
}

// ── 逾時提醒合併成一則 ──────────────────────────────────────────────
// 同一輪同一 workspace 有多位客人逾時未接手時,一場一則會連續轟炸客服——最痛的情境是
// 勿擾時段刻意不蓋 slaRemindedAt(吞掉等於永遠補不回來),整晚累積的請求會在勿擾結束
// 後的同一輪 cron 全部一起送出。改成:1 位維持完整格式(帶摘要與客人原話),
// ≥2 位合併成一則清單,每位一行「暱稱＋等了多久＋原因」,省下 N-1 則訊息錢。

/**
 * 合併訊息最多列幾位客人,其餘只給筆數。
 * LINE 單則文字上限 5000 字遠不是瓶頸,是「再長就沒人讀了」——沒列到名的那幾位
 * 每日摘要仍會算進「等待真人」人數,後台「對話」頁也一直看得到。
 */
const OVERDUE_BATCH_LIST_MAX = 10

export interface OverdueHandoffItem {
  /** 客人的 LINE userId（節流 key 用） */
  customerLineUserId: string
  /** 客人顯示名稱；沒有就帶「未知暱稱（…尾六碼）」 */
  customerName: string
  /** 已等待毫秒（排序與文案用） */
  waitedMs: number
  /** null = 非 AI 護欄觸發（例如腳本設定轉真人），或存檔內容已過期 */
  reason: HandoffReason | null
}

/** 「等了多久」的白話寫法：一小時內講分鐘，超過講小時（不寫「1.8 小時」這種要換算的數字） */
function waitedText(waitedMs: number): string {
  const minutes = Math.max(1, Math.round(waitedMs / 60_000))
  if (minutes < 60) return `等 ${minutes} 分鐘`
  return `等 ${Math.max(1, Math.round(minutes / 60))} 小時`
}

/**
 * 多位客人逾時未接手 → 合併推播一則清單通知。
 * enabled / 名單 / 勿擾三道檢查與 notifyHandoffToStaff 完全一致（同一個收斂點的規則），
 * 回傳實際送出與否，呼叫端據此決定要不要蓋 slaRemindedAt。
 *
 * 刻意不做「逐位客人的節流檢查」（只在發完之後記時間）：這一則是整批共用的，
 * 為了某一位在節流窗內就把他從名單刪掉，反而讓客服少看到一個在等的人——
 * 合併訊息的內容與即時通知本來也不同（沒有摘要與客人原話），不算重複。
 *
 * 註：原因（reason）只在 missed_only 模式有值——always 模式不寫
 * handoffNotifyContext，轉真人當下那一則已經把原因與客人原話講過了。
 */
export async function notifyOverdueHandoffBatch(params: {
  workspaceId: string
  /** 該 workspace 設定的 SLA 分鐘數（同一批共用同一個門檻） */
  slaReminderMinutes: number
  items: OverdueHandoffItem[]
}): Promise<boolean> {
  if (!params.items.length) return false

  const settings = await getAiSettings(params.workspaceId).catch(() => null)
  const cfg = settings?.handoffNotify
  if (!cfg?.enabled || !cfg.lineUserIds.length) return false
  if (isServiceHoursDnd(settings?.serviceHours)) return false

  // 等最久的排前面：真的要先救的在第一行，被 LIST_MAX 砍掉的是最不急的那些
  const sorted = [...params.items].sort((a, b) => b.waitedMs - a.waitedMs)
  const listed = sorted.slice(0, OVERDUE_BATCH_LIST_MAX)
  const rest = sorted.length - listed.length

  const lines = [
    `🙋 ${sorted.length} 位客人在等真人客服（都已超過 ${params.slaReminderMinutes} 分鐘沒人接手）`,
    ...listed.map((item) => {
      const reasonLabel = item.reason ? (HANDOFF_REASON_LABELS[item.reason] ?? item.reason) : ''
      return `・${item.customerName} — ${waitedText(item.waitedMs)}${reasonLabel ? `・${reasonLabel}` : ''}`
    }),
    ...(rest > 0 ? [`・另有 ${rest} 位客人在等（完整名單請看後台）`] : []),
    '請至後台「對話」頁回覆。',
  ]
  const msg: messagingApi.TextMessage = { type: 'text', text: lines.join('\n') }

  const results = await Promise.allSettled(
    cfg.lineUserIds.map(uid => pushMessage(uid, [msg], params.workspaceId)),
  )
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn('[handoff-notify] batch push failed for', cfg.lineUserIds[i], (r.reason as any)?.message ?? r.reason)
    }
  })

  // 這一則已經替整批客人講過話了 → 全部記進節流 map（含沒列到名的），
  // 否則接下來 10 分鐘內他們再觸發一次轉真人，又會各自補一則即時通知。
  const now = Date.now()
  for (const item of sorted) markNotified(params.workspaceId, item.customerLineUserId, now)
  return true
}

// ── AI 額度 80% 預警 ────────────────────────────────────────────────
// 額度用完的瞬間所有客人訊息會轉真人(懸崖式)——在 80% 先通知管理員,留反應時間。
// 每個「額度期間」只警告一次(標記存 aiQuotaAlerts/{workspaceId},換期自動重新警戒);
// 收件人沿用轉真人通知名單(名單沒設就發不出去——那本來就是最優先待辦)。

/** 額度通知推播全滅後的重試退避:期間內不重打,窗過後下一次跨門檻再試(C-89) */
const QUOTA_PUSH_RETRY_MS = 6 * 3600_000
export async function maybeWarnQuotaThreshold(params: {
  workspaceId: string
  /** 0~1 使用比例。呼叫端 <0.8 請勿呼叫,讓熱路徑零額外讀取 */
  ratio: number
  /** 期間識別鍵(則數額度=periodStart、token 上限=YYYY-MM);同鍵只警告一次 */
  periodKey: string
  /** 通知內容的用量描述(例「本期 AI 回覆則數 812/1000」) */
  usageText: string
  db: Firestore
}): Promise<void> {
  if (params.ratio < 0.8) return
  const settings = await getAiSettings(params.workspaceId).catch(() => null)
  const cfg = settings?.handoffNotify
  if (!cfg?.enabled || !cfg.lineUserIds.length) return

  const ref = params.db.collection('aiQuotaAlerts').doc(params.workspaceId)
  const snap = await ref.get()
  const st = snap.data() as { periodKey?: string, warnAttemptKey?: string, warnAttemptAtMs?: number } | undefined
  if (st?.periodKey === params.periodKey) return
  // 全滅退避:上次嘗試整批失敗的退避窗內不再打——名單全失效時,少了這道
  // 每則客人訊息都會重打一輪注定失敗的 LINE API
  if (st?.warnAttemptKey === params.periodKey && Date.now() - (st.warnAttemptAtMs ?? 0) < QUOTA_PUSH_RETRY_MS) return
  // 先記「嘗試過」再推播:併發最壞重複推一次,可接受(同 handoff 通知取捨)。
  // merge:同一份 doc 還有 100% 用完的標記(exhaustedPeriodKey),不能整份蓋掉
  await ref.set({ warnAttemptKey: params.periodKey, warnAttemptAtMs: Date.now() }, { merge: true })

  const msg: messagingApi.TextMessage = {
    type: 'text',
    text: `⚠️ AI 用量預警\n${params.usageText}(約 ${Math.round(params.ratio * 100)}%)。\n額度用完後,客人訊息將全部轉真人或降級模型(依設定)。請留意用量或調整方案。`,
  }
  const results = await Promise.allSettled(cfg.lineUserIds.map(uid => pushMessage(uid, [msg], params.workspaceId)))
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn('[quota-warn] push failed for', cfg.lineUserIds[i], r.reason?.message ?? r.reason)
    }
  })
  // 「這期已警告」只在至少送達一人時才記(C-89):每期一次的警報若在推播全滅的
  // 那一刻記帳,這期就永遠沉默。全滅就留著,退避窗過後下一次跨門檻再試。
  if (results.some(r => r.status === 'fulfilled')) {
    await ref.set({ periodKey: params.periodKey, ratioPct: Math.round(params.ratio * 100), warnedAt: FieldValue.serverTimestamp() }, { merge: true })
  }
}

// ── AI 額度 100% 用完通知 ──────────────────────────────────────────
// 80% 是預告,100% 是事故現場:AI 已停止回覆,客人訊息開始全轉真人(或降級模型)。
// 這件事等不了「下次有人打開後台」——每期最多一則,是全系統資訊價值最高的一則錢。
// 標記與 80% 預警共用 aiQuotaAlerts doc,各記各的鍵(兩者一期各發一次)。
export async function maybeNotifyQuotaExhausted(params: {
  workspaceId: string
  /** 期間識別鍵,同 maybeWarnQuotaThreshold 的 periodKey 規則 */
  periodKey: string
  /** 通知內容的用量描述(例「本期 AI 回覆則數 1000/1000」) */
  usageText: string
  /** 超量後的實際行為(依 quota.onExceed 設定) */
  action: 'handoff' | 'downgrade'
  db: Firestore
}): Promise<void> {
  const settings = await getAiSettings(params.workspaceId).catch(() => null)
  const cfg = settings?.handoffNotify
  if (!cfg?.enabled || !cfg.lineUserIds.length) return

  const ref = params.db.collection('aiQuotaAlerts').doc(params.workspaceId)
  const snap = await ref.get()
  const st = snap.data() as { exhaustedPeriodKey?: string, exhaustedAttemptKey?: string, exhaustedAttemptAtMs?: number } | undefined
  if (st?.exhaustedPeriodKey === params.periodKey) return
  // 全滅退避與「送達才記帳」同 maybeWarnQuotaThreshold(C-89),理由見該處註解
  if (st?.exhaustedAttemptKey === params.periodKey && Date.now() - (st.exhaustedAttemptAtMs ?? 0) < QUOTA_PUSH_RETRY_MS) return
  await ref.set({ exhaustedAttemptKey: params.periodKey, exhaustedAttemptAtMs: Date.now() }, { merge: true })

  const consequence = params.action === 'handoff'
    ? '從現在起,客人訊息會全部轉給真人客服,請盯緊後台「對話」頁。'
    : '已自動改用較精簡的模型繼續回覆,品質可能略降。'
  const msg: messagingApi.TextMessage = {
    type: 'text',
    text: `🚫 AI 額度已用完\n${params.usageText}。\n${consequence}\n要恢復請至後台調整方案,或等下期額度重置。`,
  }
  const results = await Promise.allSettled(cfg.lineUserIds.map(uid => pushMessage(uid, [msg], params.workspaceId)))
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn('[quota-exhausted] push failed for', cfg.lineUserIds[i], (r.reason as any)?.message ?? r.reason)
    }
  })
  if (results.some(r => r.status === 'fulfilled')) {
    await ref.set({ exhaustedPeriodKey: params.periodKey, exhaustedAt: FieldValue.serverTimestamp() }, { merge: true })
  }
}
