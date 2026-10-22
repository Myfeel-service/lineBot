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

/**
 * 引用了某條自動回應「現在回給客人的話」（2026-10-22 實測）：問「把「退換貨」的回覆改成「先填表單」」，
 * 它一個工具都沒查就寫「目前這條的回覆內容是：「您好，關於退換貨問題，請參考我們的退換貨政策：[連結]」」——整句是編的。
 * 提示裡寫了「先把 replyText 照抄給他看」，照樣中，所以擋。
 */
const QUOTES_SCRIPT_REPLY = /(回覆(內容|的話)?|回給客人的話)\s*(目前|現在)?\s*(是|為)\s*[：:]?\s*「/
const SCRIPTS_TOOL = 'list_scripts'

/**
 * 叫店家把客人帶去外面填表單（`D-151` 第三輪實測）：「建一條自動回應讓客人先填表單」它回
 * 「表單的連結是什麼？…讓客人在對話中點擊連結填寫表單」。老闆 10-22：「我們做這個流程不是就是為了讓大家在 LINE 上面完成嗎」。
 * 提示寫了照樣中，所以擋。⚠️ 他自己給了網址（「請填寫保固登錄：https://…」）是他的決定，不擋。
 */
const LEADS_OUT_OF_LINE = /(表單|問卷)[^。\n]{0,15}(連結|網址|點擊|點進)|(連結|網址|點擊)[^。\n]{0,10}填[^。\n]{0,4}(表單|問卷)/

/**
 * 被退回時該查、這一輪卻沒查的那一支（`D-151`，2026-10-23）：系統直接幫它查，結果塞進這一輪再讓它重寫。
 * ⛔ 只靠退回不夠：2026-10-22「改「客人等太久」的提醒時間」被退回之後它照樣不查，
 *    第二次的答案（「目前是 0 分鐘」，實際 60）就因為「同一輪只退一次」被放行了。
 */
export function groundingToolToRun({ text, calledTools }: Pick<GroundingParams, 'text' | 'calledTools'>): 'get_ai_settings' | 'list_scripts' | 'get_current_alerts' | null {
  const answer = String(text ?? '')
  if (SETTINGS_TOPIC.test(answer) && !calledTools.includes(SETTINGS_TOOL)) return 'get_ai_settings'
  if (QUOTES_SCRIPT_REPLY.test(answer) && !calledTools.includes(SCRIPTS_TOOL)) return 'list_scripts'
  if (CLAIMS_ALL_CLEAR.test(answer) && !calledTools.includes(ALERTS_TOOL)) return 'get_current_alerts'
  return null
}

export interface GroundingParams {
  /** 模型這一輪寫的回答 */
  text: string
  /**
   * 數字可以有的出處：這一輪的工具結果 ＋ 使用者自己講過的話。
   * ⛔ 不要放「我們自己寫給模型的糾正話」：那是指示不是資料，裡面的數字會變成它下一句的「出處」（`E-40`）。
   */
  sources: readonly string[]
  /**
   * 提示裡給過的日期（今天、昨天、這個月…）。**只能證明寫成日期的數字**（見 DATE_SPAN）。
   * `E-40`（2026-10-18）：原本跟 sources 混在一起，10/18 那天模型憑空講「現在是 09:00–18:00」，
   * 18 撞到今天、09 撞到上個月，整句被當成有出處放行。
   */
  dateSources?: readonly string[]
  /** 這一輪實際呼叫過的工具名 */
  calledTools: readonly string[]
  /** 使用者自己講過的話（判斷「網址是不是他給的」用；沒給＝當成他沒給） */
  userTexts?: readonly string[]
}

/**
 * 回答裡「寫成日期」的那幾段：2026-10-18、2026-09、10/18、10 月 18 日、9 月、18 號。
 * 只有這些數字可以拿提示給的日期當出處；「18:00」「18 則」不行。
 */
const DATE_SPAN = /\d{4}\s*[-/.年]\s*\d{1,2}(?:\s*[-/.月]\s*\d{1,2}\s*[日號]?)?|\d{1,2}\s*[/月]\s*\d{1,2}\s*[日號]?|\d{1,2}\s*月份?|\d{1,2}\s*[日號]/g

/**
 * 回答站不住腳的地方（沒問題回 null）。
 * 回傳的字串會原樣回饋給模型，所以要寫成「該怎麼補」而不是罵它。
 */
export function answerGroundingIssue({ text, sources, dateSources = [], calledTools, userTexts = [] }: GroundingParams): string | null {
  const answer = String(text ?? '').trim()
  if (!answer) return null

  const dateSpans = answer.match(DATE_SPAN) ?? []
  const stray = [
    ...numbersWithoutSource(answer.replace(DATE_SPAN, ' '), sources),
    ...numbersWithoutSource(dateSpans.join(' '), [...sources, ...dateSources]),
  ]
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

  if (LEADS_OUT_OF_LINE.test(answer) && !userTexts.some(t => /https?:\/\//.test(t))) {
    return '你建議把客人帶去外面填表單或點連結。⛔ 這個產品要客人在 LINE 上完成：要客人留資料，'
      + '就是在自動回應裡一題一題問（例如訂單編號、要退哪一件、為什麼退），客人直接在 LINE 上回答。'
      + '請改成這個做法（他講清楚要問哪幾題，就可以提議 script-create-from-description）。'
  }

  if (QUOTES_SCRIPT_REPLY.test(answer) && !calledTools.includes(SCRIPTS_TOOL)) {
    return `你引用了一條自動回應現在回給客人的話，但這一輪沒有查過 ${SCRIPTS_TOOL}。`
      + `⛔ 那句話不可以憑印象寫（語氣聽起來像查過，店家會以為客人收到的就是那句）。請先查 ${SCRIPTS_TOOL}，照抄 replyText。`
  }

  const topic = answer.match(SETTINGS_TOPIC)?.[0]
  if (topic && !calledTools.includes(SETTINGS_TOOL)) {
    return `你講到了「${topic}」，但這一輪沒有查過 ${SETTINGS_TOOL}。`
      + '⛔ AI 設定的現況不可以憑印象講；反問「要改成多少」之前也要先講現在是多少，已經是他要的樣子就直說「已經是這樣了」。'
      + `請先查 ${SETTINGS_TOOL} 再回答。`
  }

  return null
}
