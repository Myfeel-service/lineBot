/**
 * 「接手前要知道的事」——這場對話到目前為止發生了什麼。
 *
 * 為什麼要有：先前只有「AI 自己決定轉真人」時才會生摘要（見 summarizeHandoffContext 的
 * 呼叫點）。但客服主動按「我接手」的情況完全沒有——而那正是最需要快速掌握前因後果的時刻，
 * 否則接手的人只能自己往上捲十幾則訊息。
 *
 * **按需產生**：只有真的有人要接手時才花 LLM 費用。每次打開對話就生、或背景定時生，
 * 絕大多數都是白花——多數對話根本不會有人接手。
 *
 * 存在對話文件的 `takeoverSummary`，刻意**不放進 aiMeta**：aiMeta 每次 AI 互動都會被
 * 整份覆寫（見 handler 的 AI_META_DEFAULTS），放進去等於客人再問一句摘要就沒了。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { summarizeHandoffContext, type AiChatTurn } from './ai-answer'
import { isCustomerActionMessage } from '~~/shared/customer-action'

/** 進摘要的訊息則數：與 summarizeHandoffContext 內部的 slice(-10) 對齊，多撈也是白撈 */
const HISTORY_LIMIT = 12

export interface TakeoverSummaryDoc {
  text: string
  /** 產生當下最後一則訊息的時間；之後沒有新訊息就直接沿用，不再花錢重生 */
  uptoMessageAtMs: number
  generatedAtMs: number
}

export interface TakeoverSummaryResult {
  text: string
  generatedAtMs: number
  /** true = 直接沿用先前產生的，沒有再打 LLM */
  cached: boolean
}

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/**
 * 產生（或沿用）這場對話的接手摘要。
 *
 * @param force 使用者按「重新整理摘要」時才給 true——否則沒有新訊息就沿用舊的
 */
export async function ensureTakeoverSummary(
  db: Firestore,
  convDocId: string,
  workspaceId: string,
  opts: { force?: boolean } = {},
): Promise<TakeoverSummaryResult> {
  const convRef = db.collection('conversations').doc(convDocId)
  const convSnap = await convRef.get()
  const conv = convSnap.data() as { workspaceId?: string; takeoverSummary?: TakeoverSummaryDoc } | undefined
  if (!convSnap.exists || conv?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }

  const msgSnap = await convRef.collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(HISTORY_LIMIT)
    .get()
  if (msgSnap.empty) return { text: '', generatedAtMs: 0, cached: true }

  const docs = msgSnap.docs.slice().reverse()
  const latestMs = tsToMs(docs[docs.length - 1]?.data()?.timestamp)

  // 沒有新訊息就沿用：同一場對話點兩次「我接手」不該付兩次錢
  const prev = conv?.takeoverSummary
  if (!opts.force && prev?.text && prev.uptoMessageAtMs >= latestMs) {
    return { text: prev.text, generatedAtMs: prev.generatedAtMs, cached: true }
  }

  const history: AiChatTurn[] = docs
    .map(d => d.data() as { direction?: string; text?: string; messageType?: string })
    // 客人動作紀錄（「客人點了…」）不是客人說的話，摘要引用它會變成客人的原句（見 shared/customer-action.ts）
    .filter(m => !isCustomerActionMessage(m.messageType))
    .map(m => ({
      role: m.direction === 'outgoing' ? 'bot' as const : 'user' as const,
      text: String(m.text ?? ''),
    }))
    .filter(t => t.text.trim())
  if (!history.length) return { text: '', generatedAtMs: 0, cached: true }

  // 最後一則已經在 history 裡，latestMessage 給空字串避免重複追加（見 summarizeHandoffContext）
  const text = await summarizeHandoffContext(history, '')
  if (!text) return { text: '', generatedAtMs: 0, cached: false }

  const generatedAtMs = Date.now()
  await convRef.set({
    takeoverSummary: { text, uptoMessageAtMs: latestMs, generatedAtMs },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  return { text, generatedAtMs, cached: false }
}
