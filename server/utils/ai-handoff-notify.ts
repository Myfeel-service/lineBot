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
import { isServiceHoursDnd } from '~~/shared/time'
import { HANDOFF_REASON_LABELS } from '~~/shared/types/ai-knowledge'
import type { HandoffReason } from '~~/shared/types/ai-knowledge'
import { capMapSize } from './bounded-cache'

const NOTIFY_THROTTLE_MS = 10 * 60 * 1000
const NOTIFY_MAP_MAX_ENTRIES = 5000
const lastNotifiedAt = new Map<string, number>()

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

export async function notifyHandoffToStaff(params: HandoffNotifyParams): Promise<void> {
  const settings = await getAiSettings(params.workspaceId).catch(() => null)
  // 勿擾時段內不推播（含腳本/AI 觸發與 SLA 再提醒）：轉真人照常發生,只是不吵客服;
  // 客服上班回來看「對話」佇列即可。這是所有 handoff 通知的單一收斂點。
  if (isServiceHoursDnd(settings?.serviceHours)) return
  const cfg = settings?.handoffNotify
  if (!cfg?.enabled || !cfg.lineUserIds.length) return

  const throttleKey = `${params.workspaceId}:${params.customerLineUserId}`
  const last = lastNotifiedAt.get(throttleKey) ?? 0
  const now = Date.now()
  if (now - last < NOTIFY_THROTTLE_MS) return
  lastNotifiedAt.set(throttleKey, now)
  capMapSize(lastNotifiedAt, NOTIFY_MAP_MAX_ENTRIES)

  const reasonLabel = params.reason
    ? (HANDOFF_REASON_LABELS[params.reason] ?? params.reason)
    : '腳本轉真人'
  const lines = params.slaReminderMinutes
    ? [
        '⏰ 提醒：真人客服請求尚未回應',
        `客人：${params.customerName}`,
        `已等待超過 ${params.slaReminderMinutes} 分鐘`,
        '請至後台「對話」頁回覆。',
      ]
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
}

// ── AI 額度 80% 預警 ────────────────────────────────────────────────
// 額度用完的瞬間所有客人訊息會轉真人(懸崖式)——在 80% 先通知管理員,留反應時間。
// 每個「額度期間」只警告一次(標記存 aiQuotaAlerts/{workspaceId},換期自動重新警戒);
// 收件人沿用轉真人通知名單(名單沒設就發不出去——那本來就是最優先待辦)。
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
  if ((snap.data() as { periodKey?: string } | undefined)?.periodKey === params.periodKey) return
  // 先寫標記再推播:併發最壞重複推一次,可接受(同 handoff 通知取捨)
  await ref.set({ periodKey: params.periodKey, ratioPct: Math.round(params.ratio * 100), warnedAt: FieldValue.serverTimestamp() })

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
}

/**
 * 知識庫來源事件通知（內容變動 / 同步失敗）：推播給 handoffNotify 的同一批收件人。
 * 與 handoff 通知共用收件人與勿擾時段——維運通知不比轉真人急，勿擾時段一樣不吵人；
 * 來源上的「已變動 / 失敗」標記不會消失，上班後看後台即可。
 * 呼叫端自行控制頻率（變動靠 hash 更新天然去重；失敗只在「連續第 3 次」跨門檻時叫一次）。
 */
export async function notifyKnowledgeSourceEvent(workspaceId: string, text: string): Promise<void> {
  const settings = await getAiSettings(workspaceId).catch(() => null)
  if (isServiceHoursDnd(settings?.serviceHours)) return
  const cfg = settings?.handoffNotify
  if (!cfg?.enabled || !cfg.lineUserIds.length) return
  const msg: messagingApi.TextMessage = { type: 'text', text }
  const results = await Promise.allSettled(cfg.lineUserIds.map(uid => pushMessage(uid, [msg], workspaceId)))
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn('[kb-source-notify] push failed for', cfg.lineUserIds[i], (r.reason as any)?.message ?? r.reason)
    }
  })
}
