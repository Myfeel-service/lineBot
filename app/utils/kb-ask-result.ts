/**
 * 知識庫頁右邊「問 AI 一題」（`C-315`，2026-10-15 老闆拍板 D-126②）：一題試答的結果要怎麼講。
 *
 * 為什麼抽成純函式：這一區的價值是**照實講客人會拿到什麼**——答不出來時說成「轉真人」就是騙人
 * （正式 LINE 上信心不足／知識庫沒有的那幾種，AI 先問客人「需要幫您轉接專員嗎？」，客人按了才轉），
 * 寫在元件裡沒有東西守得住它。判讀規則沿用「測試對話」頁（ai-playground.vue）的 decision／handoffReason 分法，
 * 只是字縮成一兩句、不講門檻與信心分數（店家拿那個數字不知道要做什麼）。
 */
import {
  HANDOFF_REASON_LABELS,
  type AiAnswerResult,
  type HandoffReason,
} from '~~/shared/types/ai-knowledge'

/** /api/ai/playground 的回應：多一格「這句會由自動回應接手」（命中腳本時 AI 不出手） */
export type AskResult = AiAnswerResult & {
  scriptTrigger?: { name: string; mode: 'keyword' | 'semantic' }
}

/**
 * 正式 LINE 上「先問客人要不要轉真人」的那幾種（⛔ 跟 server/utils/handler.ts 的 `HANDOFF_CONFIRM_REASONS` 同一份，
 * 有測試讀那支檔案對照——那邊加減一種，這裡講的「客人會收到什麼」就錯了）。
 * 也正好是「補一條答案有用」的那幾種：知識庫沒有、或有但不夠準。
 * 其他（客人自己要真人、敏感主題、額度用完、查訂單…）補知識也一樣會轉，不給「寫一句正確答案」那顆主要按鈕。
 */
export const ASK_FIRST_REASONS: readonly HandoffReason[] = ['low_confidence', 'no_grounding', 'unresolved', 'product_mismatch']
const ASK_FIRST = new Set<HandoffReason>(ASK_FIRST_REASONS)

/** 轉真人的原因，講成店家聽得懂的一句；沒有特別寫的沿用全站的 HANDOFF_REASON_LABELS（同一件事不要兩種說法） */
const WHY: Partial<Record<HandoffReason, string>> = {
  no_grounding: '知識庫裡沒有這題的答案',
  low_confidence: '有找到相關的，但 AI 沒把握',
  sensitive_topic: '這類問題設定成交給真人',
  quota_exceeded: '這個月的 AI 回覆用完了',
  user_request: '客人說要找真人',
}

export interface AskSourceRow {
  /** 畫面上的編號（1 起算，照 AI 用到的順序） */
  n: number
  chunkId: string
  sourceId: string | null
  title: string
  /** 「等你看過」的那幾條：試答讀得到、客人問不會用（`C-250`③） */
  draft: boolean
}

export type AskView =
  /** 答得出來。sources 可能是空的（招呼語、跟店無關的問題走固定回覆，不查知識庫） */
  | { kind: 'answer'; answer: string; sources: AskSourceRow[]; draftOnly: boolean; canAddOne: boolean }
  /** 先反問客人是指哪一個 */
  | { kind: 'ask'; clarification: string; options: Array<{ chunkId: string; text: string }>; canAddOne: boolean }
  /** 轉真人（或先問要不要轉） */
  | { kind: 'handoff'; why: string; customerGets: string; canAddOne: boolean }
  /** 這句會交給自動回應，AI 不出手 */
  | { kind: 'script'; name: string }
  /** AI 服務這次沒回應：再問一次就好，跟知識沒關係 */
  | { kind: 'retry'; why: string }
  /** AI 跳過、客人什麼都不會收到 */
  | { kind: 'silent' }

export function askSourceRows(r: Pick<AiAnswerResult, 'sources'>): AskSourceRow[] {
  return (r.sources ?? [])
    .filter(s => s && String(s.chunkId ?? '').trim())
    .map((s, i) => ({
      n: i + 1,
      chunkId: String(s.chunkId),
      sourceId: s.sourceId ? String(s.sourceId) : null,
      title: String(s.title ?? '').trim() || '（沒有標題）',
      draft: s.draft === true,
    }))
}

export function askView(r: AskResult): AskView {
  if (r.scriptTrigger) return { kind: 'script', name: r.scriptTrigger.name }

  if (r.decision === 'answered') {
    const sources = askSourceRows(r)
    // 招呼語／跟店無關（`AiAnswerKind`）沒查知識庫：⛔ 不給「寫一句正確答案」——會把「謝謝」建成一條知識
    const kb = (r.answerKind ?? 'kb') === 'kb'
    return {
      kind: 'answer',
      answer: String(r.answer ?? ''),
      sources,
      draftOnly: sources.length > 0 && sources.every(s => s.draft),
      canAddOne: kb,
    }
  }

  if (r.decision === 'disambiguate' && r.disambiguation) {
    return {
      kind: 'ask',
      clarification: String(r.disambiguation.clarification ?? ''),
      options: (r.disambiguation.options ?? []).map(o => ({
        chunkId: String(o.chunkId ?? ''),
        // 跟測試對話頁同一個退路：短名稱優先，沒有才用完整標題（客人按下去送出的也是這個字）
        text: String(o.label || o.title || '').trim(),
      })).filter(o => o.text),
      canAddOne: true,
    }
  }

  const reason = r.handoffReason
  if (reason === 'llm_error') return { kind: 'retry', why: HANDOFF_REASON_LABELS.llm_error }
  if (reason === 'manual' || (r.decision === 'skipped' && !reason)) return { kind: 'silent' }

  const askFirst = !!reason && ASK_FIRST.has(reason)
  return {
    kind: 'handoff',
    why: (reason && (WHY[reason] ?? HANDOFF_REASON_LABELS[reason])) || '這題 AI 不回答',
    customerGets: askFirst ? '客人會收到：AI 說不確定，問要不要轉給真人' : '客人會直接轉給真人',
    canAddOne: askFirst,
  }
}

/**
 * 面板只留最近幾題（`C-315`）：這裡是「確認一題」的地方，不是第二個測試對話頁；
 * 留太多的話右邊那一欄捲很長，最新那題反而要找。
 */
export const ASK_PANEL_MAX_TURNS = 5

export function keepRecentTurns<T>(turns: readonly T[], max = ASK_PANEL_MAX_TURNS): T[] {
  return turns.length > max ? turns.slice(turns.length - max) : [...turns]
}

/**
 * 「用了這 N 條」每一條後面的「· 哪一份資料」。
 * - 就是現在打開的那一份 → 「這一份」（示意頁 v2 的寫法）
 * - 手寫的那種「一份資料就一條」，資料名＝那一條的標題 → 不重講
 * - 查不到名字（資料剛刪掉、清單還沒載入）→ 不講，⛔ 不猜
 */
export function askSourceLabel(
  row: Pick<AskSourceRow, 'sourceId' | 'title'>,
  names: Readonly<Record<string, string>> | null | undefined,
  currentSourceId?: string | null,
): string {
  if (!row.sourceId) return ''
  if (currentSourceId && row.sourceId === currentSourceId) return '這一份'
  const name = String(names?.[row.sourceId] ?? '').trim()
  if (!name || name === row.title.trim()) return ''
  return name
}
