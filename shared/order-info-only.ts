/**
 * 客人只丟訂單資料、沒說要做什麼 → 機器人先問一句他想詢問什麼（`D-133`，2026-10-19 老闆：「是否先問他想幹嘛 再決定」）。
 *
 * 2026-10-09 正式站（MYFEEL）：客人「白」先點了「出貨進度查詢 → 電淨艙」看過「10 月底出貨」，45 秒後打了
 * 「M20261007002452KOYK訂單編號／名字白坤永／電話0982085948」。句子裡有「訂單」，店家設的「查詢訂單」流程攔下來、
 * 再問一次編號、收完轉真人——連假期間他只收到「非客服服務時間」。他想要什麼其實沒人知道：可能是確認那一筆、
 * 可能要改資料、也可能只是想再確認出貨時間（知識庫就答得出來）。
 *
 * 做法：認出「只有資料、沒有問題」就先問，附三顆按鈕。按鈕送出的是**文字**，之後完全走現有的分流：
 *   - 「請問什麼時候出貨？」→ 出貨時程題（`C-343`／`C-344`）：認得出商品就由 AI 直接答，認不出先問是哪一個
 *   - 「我想修改訂單資料」→ 店家自己的流程（有設的話）或 AI／轉真人；剛剛丟的資料流程撿得到、不再問一次
 *   - 「找真人」→ 轉真人（跟其他地方同一顆、同一個字；⛔ 不用「轉接專員」，那四個字只有 AI 剛問完要不要轉接時才認得）
 *
 * ⛔ 多租戶：判斷只看格式（有沒有訂單編號這種長代碼）與有沒有問句／意圖詞，不看任何店家的商品或流程名稱。
 */
import { prefillCollectFields, type ScriptNode } from './types/ai-script'

/** 機器人問的那一句（不是 AI 寫的、不扣則） */
export const ORDER_INFO_ASK_TEXT = '收到您的訂單資料了，請問想詢問什麼呢？'

/**
 * 三顆按鈕。text 是客人點了之後「代他送出」的那句話，後面的分流都靠這幾個字：
 * 出貨那句要讓 `isShipTimingQuestion` 認得（出貨＋什麼時候、沒有延遲／改單字眼）——
 * ⛔ 不能寫「出貨進度」：那四個字刻意不算出貨時程題（可能是在問「寄了沒」，要查他那一筆）。
 */
export const ORDER_INFO_SHIP_OPTION = { label: '什麼時候出貨', text: '請問什麼時候出貨？' } as const
export const ORDER_INFO_MODIFY_OPTION = { label: '修改訂單資料', text: '我想修改訂單資料' } as const
export const ORDER_INFO_HUMAN_OPTION = { label: '🙋 找真人', text: '找真人' } as const

/**
 * 問過之後多久內：①客人點「什麼時候出貨」直接交給 AI；②流程撿得到剛剛那筆資料；③再丟一次資料不重問。
 * 快速回覆按鈕在客人下一次傳訊息前都還在，他可能先去忙、過一陣子才點。
 */
export const ORDER_INFO_ASK_TTL_MS = 2 * 60 * 60 * 1000

/**
 * 有沒有在問／要做什麼。字有出現就當他講了（漏判＝照舊走流程或 AI，安全；誤判成「只有資料」才會多問一句）。
 * ⛔ 欄位名稱（訂單編號、姓名、電話、地址）不算——那是資料的標籤。
 * ⛔ 「麻煩／協助／處理／確認／謝謝」不算——那是客氣話，還是沒講要做什麼（正是要問的情況）。
 */
const INTENT_RE = /[?？嗎呢吗]|請問|想|要|能否|可否|可以|能不能|怎麼|怎樣|如何|為什麼|為何|什麼|甚麼|何時|幾時|哪時|多久|幾天|幾號|查|詢|問一下|改|換|修正|更正|錯|取消|退|寄|出貨|發貨|到貨|收到|送達|配送|物流|進度|狀態|延|急|還沒|沒|未|發票|付款|匯款|刷卡|補|加購|合併|拆/

/** 先撿用的探針：跟流程「先撿客人講過的資料」同一套規則（`C-343` 的 prefillCollectFields） */
const PROBE_NODES = [
  { id: 'probe-code', type: 'collect', question: '', fieldName: 'code', format: 'alphanumericSymbol', next: '' },
] as unknown as ScriptNode[]

/** 這句裡有沒有訂單編號這種長代碼（6 個以上數字，排除電話、日期、信箱、網址；同 `C-343`） */
export function hasOrderCode(text: string): boolean {
  return Boolean(prefillCollectFields(PROBE_NODES, text).code)
}

/** 這句話有在問、或講了要做什麼 */
export function hasIntent(text: string): boolean {
  return INTENT_RE.test(String(text || ''))
}

/**
 * 這句話只有訂單資料、沒有問題。
 * 一定要有訂單編號這種長代碼：只有電話／姓名的（預約、會員資料）不算——不能確定是訂單的事，
 * 問「什麼時候出貨」反而奇怪。
 */
export function isOrderInfoOnly(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  return hasOrderCode(t) && !hasIntent(t)
}

/** 判斷「要不要問」時看的對話（新的在前；時間讀不到給 null） */
export interface OrderInfoRecentMessage {
  direction?: string
  messageType?: string
  text?: string
  timestampMs: number | null
}

/**
 * 店家上一句在跟他要資料多久以內，這筆資料就算是在回答那一句。
 * 72 小時（同給 AI 讀的對話）：正式站常見真人問「煩請提供您的訂單資訊」、客人隔天才找到編號貼上來——那還是在回答，
 * 不該再問他想做什麼（2026-10-19 拿 MYFEEL 75 天的客人訊息逐句對過，1 小時會把這種誤判成「只丟資料」）。
 */
const ASKED_FOR_DATA_WINDOW_MS = 72 * 60 * 60 * 1000
/** 客人自己幾分鐘內打過有意圖的話，這筆資料就算是在補充那一句 */
const OWN_INTENT_WINDOW_MS = 10 * 60 * 1000

const DATA_WORD_RE = /編號|單號|電話|手機|姓名|大名|名字|信箱|email|e-mail|資料|資訊/i
/** 「再確認一次」「重新輸入」：流程說格式不對、請他再給一次 */
const REQUEST_WORD_RE = /提供|告訴|留下|輸入|回覆|填寫|請問|多少|是[?？]|再確認|重新/

/**
 * 要不要問他想做什麼。只有資料、沒有問題之外，還要排除三種「其實已經知道他要做什麼」的情況：
 *   ① 剛問過（`ORDER_INFO_ASK_TTL_MS` 內）——他又丟一次資料，不要一直問
 *   ② 店家／AI／真人上一句就是在跟他要資料（「請問您的訂單編號是？」）——這筆是答案
 *   ③ 他自己 10 分鐘內打過一句有意圖的話（「我要改地址」）——這筆是在補充那件事
 * @param recent 最近的對話（新的在前），可以含這一句本身（會自動跳過）
 */
export function shouldAskOrderIntent(input: {
  text: string
  recent: readonly OrderInfoRecentMessage[]
  nowMs: number
  /** 上次問的時間（沒問過給 null） */
  lastAskAtMs: number | null
}): boolean {
  const text = String(input.text || '').trim()
  if (!isOrderInfoOnly(text)) return false
  if (input.lastAskAtMs != null && input.nowMs - input.lastAskAtMs < ORDER_INFO_ASK_TTL_MS) return false

  let skippedSelf = false
  let seenOutgoing = false
  for (const m of input.recent) {
    const age = m.timestampMs == null ? 0 : input.nowMs - m.timestampMs
    const t = String(m.text || '').trim()
    if (!skippedSelf && m.direction === 'incoming' && t === text) {
      skippedSelf = true
      continue
    }
    if (m.direction === 'outgoing' && !seenOutgoing) {
      seenOutgoing = true
      if (age <= ASKED_FOR_DATA_WINDOW_MS && DATA_WORD_RE.test(t) && REQUEST_WORD_RE.test(t)) return false
    }
    if (m.direction === 'incoming' && m.messageType === 'text' && age <= OWN_INTENT_WINDOW_MS && hasIntent(t)) return false
  }
  return true
}

/**
 * 按鈕：出貨那顆只在店家可能出貨時放（店家型別是「做服務」「教課」的不放——問他們「什麼時候出貨」很怪）。
 * @param offerShip 由呼叫端依店家輪廓決定；沒填輪廓的（中性型）照放，訂單編號本身就是有出貨的訊號
 */
export function orderInfoAskOptions(offerShip: boolean): Array<{ label: string, text: string }> {
  return [
    ...(offerShip ? [ORDER_INFO_SHIP_OPTION] : []),
    ORDER_INFO_MODIFY_OPTION,
    ORDER_INFO_HUMAN_OPTION,
  ]
}
