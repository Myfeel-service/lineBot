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

/**
 * AI 設定的**現況**話題（`D-116`，2026-10-08）：講到這些——不論是講「現在是什麼」，
 * 還是反問「要改成幾點」——這一輪都要查過設定。
 *
 * ⛔ 數字那道守門擋不到**文字**：實測問「AI 講話太冷淡了」，它一個工具都沒查就說
 *    「AI 的語氣目前設定為『專業簡潔』」——其實是自己寫的指示；
 *    問「晚上不要吵我」，它直接問「勿擾要幾點到幾點」——其實本來就設好了。
 * ⚠️ 刻意不收「等太久」「轉真人」：講對話統計時常出現，收了會一直白查一次。
 */
const SETTINGS_TOPIC = /(語氣|口吻|回覆模式|草稿模式|服務時間|勿擾|提醒時間|自動交還|自動結束)/
const SETTINGS_TOOL = 'get_ai_settings'

/**
 * 把服務時間講成「AI 的」上班時間（`D-116` 實測，兩輪都中）：「目前 AI 自動回覆的服務時間設定為…」。
 * 服務時間只管客人要找真人時會不會通知你們，AI 全天照回——照這句理解，店家會以為週末 AI 不回。
 * 工具說明寫了、提示也寫了，照樣講，所以擋。
 */
// ⚠️ 只認「AI…的服務時間」：「AI 在服務時間以外照常回答」是對的講法，⛔ 不可以誤擋
const AI_SERVICE_HOURS = /AI[^。，,\n]{0,6}的(服務時間|上班時間)|(服務時間|勿擾時段?)[^。，,\n]{0,10}AI[^。，,\n]{0,4}(不會?|沒有?)(回|答)/

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

  const aiHours = answer.match(AI_SERVICE_HOURS)?.[0]
  if (aiHours) {
    return `你寫了「${aiHours}」——服務時間不是 AI 的上班時間。`
      + '⛔ 服務時間只管「客人要找真人時會不會通知你們」（勿擾時段內客人先收到一句稍後回覆），AI 全天照常回答。'
      + '請改寫那句話，⛔ 不要說成「AI 自動回覆的服務時間」。'
  }

  const topic = answer.match(SETTINGS_TOPIC)?.[0]
  if (topic && !calledTools.includes(SETTINGS_TOOL)) {
    return `你講到了「${topic}」，但這一輪沒有查過 ${SETTINGS_TOOL}。`
      + '⛔ AI 設定的現況不可以憑印象講；反問「要改成多少」之前也要先講現在是多少，已經是他要的樣子就直說「已經是這樣了」。'
      + `請先查 ${SETTINGS_TOOL} 再回答。`
  }

  return null
}
