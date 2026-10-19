/**
 * AI 回答前讀的對話，往回看多久（`C-4`，2026-10-19）。
 *
 * 以前只限「最近幾則」、不看時間：給 AI 讀 8 則、認商品看 16 則。客人兩個月沒講話，
 * 最近 16 則就是兩個月前的事。MYFEEL 近 14 天 445 個 AI 回合裡，給 AI 讀的有超過 7 天的訊息 82 次、
 * 超過 30 天 20 次；10/16 一位客人問「我為何 9/3 買是 22900？」，產品鎖認到的是 **65 天前**
 * 她登記活動時收到的「乾淨方MAX 開賣通知」，把真正相關的卡全擋掉、轉真人。
 *
 * 三把尺（只篩掉，不多讀——訊息照舊讀最近 16 則）：
 *   ① **給 AI 讀的：72 小時內**。為什麼不是「同一場對話」：一場對話是客人 24 小時沒動靜就換新的一場，
 *      客人隔天回來說「昨天問的那個…」已經是新的一場，用「同一場」會讀不到；同一場對話拖過 72 小時、
 *      又只看最近 8 則的情況幾乎不存在——72 小時是兩者裡比較寬、又不用多讀一次會話資料的那個。
 *      週五晚上問、週一早上回來（約 64 小時）也還讀得到。
 *   ② **認商品的：7 天內**。`C-344` 那位客人 10/9 點了「出貨進度查詢－電淨艙」，10/12 晚上才問
 *      「我的會什麼時候出貨」，中間隔 3 天多——要認得到。
 *   ③ **系統主動發的（加好友歡迎、活動登記後的開賣通知）只在 72 小時內拿來認商品**：那是發給每一個登記的人的，
 *      不是客人針對哪一台問過什麼。剛登記就來問「什麼時候開賣」，那一則就是唯一線索（所以留著）；
 *      過了幾天，客人很可能已經在問別台。
 *
 * ⚠️ 時間讀不到的訊息（正式資料不會發生）一律當作「剛剛」——寧可多讀一則，也不要讓 AI 少了上一句。
 */

const HOUR_MS = 60 * 60 * 1000

/** ① 給 AI 讀的對話：72 小時內 */
export const AI_HISTORY_MAX_AGE_MS = 72 * HOUR_MS
/** ② 認商品：7 天內 */
export const PRODUCT_CONTEXT_MAX_AGE_MS = 7 * 24 * HOUR_MS
/** ③ 系統主動發的（加好友、活動登記）認商品：72 小時內 */
export const PUSH_PRODUCT_CONTEXT_MAX_AGE_MS = 72 * HOUR_MS

/**
 * 推播的那幾則跟「客人登記」那一行的時間可能前後顛倒：登記那行是我們記下來的時間，
 * 推播也是我們存的，兩邊並行寫入——實測「客人從活動…登記」排在開賣通知圖片的**後面**。
 * 往前看這麼久以內、中間客人沒動過的店家訊息，也算那次推播。
 */
const PUSH_SKEW_MS = 2 * 60 * 1000

/** 判斷要用到的訊息欄位（對話訊息文件的子集；時間換成毫秒） */
export interface ContextWindowMessage {
  direction?: string
  messageType?: string
  sender?: string
  /** 訊息時間（毫秒）；讀不到給 null */
  timestampMs: number | null
  /** 客人動作那一行的種類（訊息 payload.actionType） */
  actionType?: string
  text?: string
}

export interface ContextWindowFlag {
  /** 進給 AI 讀的那份 */
  forAi: boolean
  /** 進認商品的那份 */
  forProduct: boolean
  /** 這則是系統主動發的（加好友歡迎、活動登記與它帶出來的推播） */
  push: boolean
}

const CUSTOMER_ACTION = 'customer_action'
const PUSH_ACTIONS = new Set(['follow', 'campaign_claim'])

/** 「客人加入好友」「客人從活動…登記」：舊資料沒有 actionType 時看字 */
function isPushEvent(m: ContextWindowMessage): boolean {
  if (m.direction !== 'incoming' || m.messageType !== CUSTOMER_ACTION) return false
  if (m.actionType) return PUSH_ACTIONS.has(m.actionType)
  const t = String(m.text ?? '')
  return t.startsWith('客人加入好友') || t.startsWith('客人從活動')
}

/** 客人自己做了事（打字、傳圖、點按鈕）——推播到這裡為止 */
function isCustomerMove(m: ContextWindowMessage): boolean {
  if (m.direction !== 'incoming') return false
  if (m.messageType !== CUSTOMER_ACTION) return true
  return !isPushEvent(m) && m.actionType !== 'unfollow'
}

/** 推播是機器人／系統發的（真人主動傳的不算推播；舊資料沒有 sender 的也算進來） */
function isPushSender(m: ContextWindowMessage): boolean {
  return m.direction === 'outgoing' && m.sender !== 'human' && m.sender !== 'ai'
}

/**
 * 每一則訊息各自進不進「給 AI 讀」「認商品」兩份。
 * @param newestFirst 新的在前（跟 orderBy('timestamp','desc') 讀回來的順序一樣）
 * @returns 跟 newestFirst 同一個順序
 */
export function contextWindowFlags(newestFirst: readonly ContextWindowMessage[], nowMs: number): ContextWindowFlag[] {
  const msgs = [...newestFirst].reverse() // 由舊到新才看得出「這次推播到客人開口為止」
  const push = msgs.map(() => false)
  msgs.forEach((m, i) => {
    if (!isPushEvent(m)) return
    push[i] = true
    for (let j = i + 1; j < msgs.length; j++) {
      const n = msgs[j]!
      if (isCustomerMove(n)) break
      if (isPushSender(n)) push[j] = true
    }
    const at = m.timestampMs
    for (let j = i - 1; j >= 0; j--) {
      const n = msgs[j]!
      if (isCustomerMove(n)) break
      if (at == null || n.timestampMs == null || at - n.timestampMs > PUSH_SKEW_MS) break
      if (isPushSender(n)) push[j] = true
    }
  })

  const flags = msgs.map((m, i): ContextWindowFlag => {
    const age = m.timestampMs == null ? 0 : nowMs - m.timestampMs
    return {
      forAi: age <= AI_HISTORY_MAX_AGE_MS,
      forProduct: age <= PRODUCT_CONTEXT_MAX_AGE_MS && (!push[i] || age <= PUSH_PRODUCT_CONTEXT_MAX_AGE_MS),
      push: push[i]!,
    }
  })
  return flags.reverse()
}
