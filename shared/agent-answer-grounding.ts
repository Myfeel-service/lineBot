/**
 * 「這個回答，站得住腳嗎」——小幫手回答前的最後一道檢查（2026-09-18 壓測）。
 *
 * 要防的兩件事，都是**它沒查，但語氣聽起來像查過**：
 *
 * ① **憑空的數字**：問「這個月 AI 花了我多少錢」，它一個工具都沒呼叫，
 *    直接回「這個月 AI 總共回覆了 123 則訊息，其中有 45 次轉給真人」——
 *    兩個數字都是編的（同一題前一輪查過，真值是 110）。
 * ② **沒查就說沒事**：問「有沒有什麼要處理的」，它只查了用量就順口補一句
 *    「目前沒有需要處理的異常狀況」。
 *
 * ⛔ 這兩條 prompt 裡本來就寫得清清楚楚（「回答裡的每個數字都必須來自工具結果」
 *    「沒查過的那一件絕對不可以順口回答」），照樣中——所以要有機制。
 *
 * ⛔ 機制刻意**不是把句子改掉**，而是**退回去讓它再查一次**：
 *    使用者問的是一個合理的問題，他要的是真的數字，不是一句「我不能回答」。
 *    （同一輪只退一次，⛔不然模型每次都寫同一句話就會無限繞。）
 */
import { numbersWithoutSource } from './agent-reply-numbers'

/** 「目前沒事」這種**全站性**的斷言——只有查過異常總覽才講得出來 */
const CLAIMS_ALL_CLEAR = /(沒有(任何)?(需要|要)(處理|注意)|沒有異常|無異常|一切正常|系統正常|都很正常|沒有待處理)/

/** 講「目前沒事」要先查過的那支工具 */
const ALERTS_TOOL = 'get_current_alerts'

export interface GroundingParams {
  /** 模型這一輪寫的回答 */
  text: string
  /** 數字可以有的出處：這一輪的工具結果 ＋ 使用者自己講過的話 ＋ 提示裡給過的日期 */
  sources: readonly string[]
  /** 這一輪實際呼叫過的工具名 */
  calledTools: readonly string[]
}

/**
 * 回答站不住腳的地方（沒問題回 null）。
 * 回傳的字串會原樣回饋給模型，所以要寫成「該怎麼補」而不是罵它。
 */
export function answerGroundingIssue({ text, sources, calledTools }: GroundingParams): string | null {
  const answer = String(text ?? '').trim()
  if (!answer) return null

  const stray = numbersWithoutSource(answer, sources)
  if (stray.length) {
    return `你的回答裡有「${stray.slice(0, 3).join('、')}」這幾個數字，但這一輪查到的資料裡沒有它們，使用者也沒講過。`
      + '⛔ 數字不可以憑印象寫——請先用對應的工具查一次再回答；'
      + '真的沒有工具查得到就如實說「這個我看不到」,⛔不要給一個數字。'
  }

  if (CLAIMS_ALL_CLEAR.test(answer) && !calledTools.includes(ALERTS_TOOL)) {
    return `你說了「目前沒有要處理的事」，但這一輪沒有查過 ${ALERTS_TOOL}。`
      + '⛔ 沒查就講「沒有異常」是這裡最容易騙到人的一句話（語氣聽起來像查過）。'
      + `請先查 ${ALERTS_TOOL}；或把那句話拿掉，並明說「異常我還沒查，要不要我查一下」。`
  }

  return null
}
