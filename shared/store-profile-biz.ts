/**
 * 店家的「型」（`D-99`，2026-09-24 拍板；2026-09-26 `C-250` 落地）。
 *
 * ── 為什麼要有這一層 ───────────────────────────────────────────
 * 產業別那一題早就有餐飲／美容／教育／醫療…，但後面的問法、欄位名、標籤、歡迎訊息
 * **全部寫死在賣東西**：問牙醫「主要賣什麼」、叫補習班的客人「想問出貨直接留言」、
 * 給診所建「送禮客／問過出貨」兩顆一輩子用不到的標籤（而標籤代號建了就改不掉）。
 *
 * ── 三條規矩 ───────────────────────────────────────────────────
 * ① **不做八套模板**：八種產業各一套＝八份要一起維護的文案，而且切不乾淨。
 *    收斂成三型＋一個中性型，由產業別那一題的答案直接對應。
 * ② **自己打的產業別（「都不是，我自己講」）一律落在中性型**。⛔ 不猜：
 *    猜錯型比講通用話更傷——把手工皂工作室猜成「做服務」，後面每一句都是錯的。
 * ③ 這裡只放**跨產業通用**的說法，⛔ 不放任何特定客戶的商品或產業（多租戶）。
 */

export type StoreBizType = 'goods' | 'service' | 'class' | 'neutral'

/**
 * 產業別選項 → 型。⚠️ key 要跟 `STORE_PROFILE_FIELDS` 裡產業別的選項**逐字相同**
 * （守門測試會比對）；對不到的一律是中性型。
 */
export const INDUSTRY_BIZ_TYPE: Readonly<Record<string, StoreBizType>> = {
  '零售／電商': 'goods',
  '餐飲／飲料': 'goods',
  '美容／美業': 'service',
  '服務／預約': 'service',
  '醫療／健康': 'service',
  '旅遊／住宿': 'service',
  '教育／課程': 'class',
}

/** ⛔ 對不到就回中性型，**不要**回 `goods`——那是在猜。 */
export function storeBizTypeOf(industry: string | null | undefined): StoreBizType {
  return INDUSTRY_BIZ_TYPE[String(industry ?? '').trim()] ?? 'neutral'
}

export interface StoreBizWording {
  /** 「主要○什麼」的那個動詞：賣／做／開／提供（歡迎訊息「我們主要○…」用） */
  verb: string
  /** 「○○等商品」的那個名詞（歡迎訊息的正式說法用） */
  noun: string
  /** 第 2 題（products）的問法與例子 */
  productsQuestion: string
  productsPlaceholder: string
  /** 輪廓卡上 products／priceRange／channel 三格的欄位名 */
  productsLabel: string
  priceLabel: string
  channelLabel: string
  /** 第 4 題（channel）的問法 */
  channelQuestion: string
  /** 歡迎訊息裡「可以問什麼」那半句（賣東西的另外照銷售方式換，見 `welcomeAskFor`） */
  welcomeAsk: string
  /** 測試對話頁預填的第一題，與「再問一題價格」接在商品名後面的那半句 */
  tryQuestion: string
  priceAsk: string
}

export const STORE_BIZ_WORDING: Readonly<Record<StoreBizType, StoreBizWording>> = {
  goods: {
    verb: '賣',
    noun: '商品',
    productsQuestion: '主要賣什麼？講三樣最重要的就好，用頓號分開。',
    productsPlaceholder: '例：黑豆水、養生茶包、節慶禮盒',
    productsLabel: '主打商品',
    priceLabel: '價格帶',
    channelLabel: '銷售方式',
    channelQuestion: '客人通常怎麼買？',
    welcomeAsk: '想問商品、出貨或購買方式',
    tryQuestion: '你們有賣什麼？',
    priceAsk: '多少錢？',
  },
  service: {
    verb: '做',
    noun: '服務',
    productsQuestion: '主要做哪些服務？講三樣最重要的就好，用頓號分開。',
    productsPlaceholder: '例：全口檢查、牙齒矯正、植牙諮詢',
    productsLabel: '主要服務',
    priceLabel: '收費區間',
    channelLabel: '接觸方式',
    channelQuestion: '客人通常怎麼找你？',
    welcomeAsk: '想預約時段、問服務內容',
    tryQuestion: '你們有做哪些服務？',
    priceAsk: '怎麼收費？',
  },
  class: {
    verb: '開',
    noun: '課程',
    productsQuestion: '主要開哪些課？講三樣最重要的就好，用頓號分開。',
    productsPlaceholder: '例：國中數學、英文會話、暑期作文班',
    productsLabel: '主要課程',
    priceLabel: '學費區間',
    channelLabel: '接觸方式',
    channelQuestion: '學生通常怎麼報名？',
    welcomeAsk: '想問課程、上課時段或怎麼報名',
    tryQuestion: '你們有開什麼課？',
    priceAsk: '學費多少？',
  },
  neutral: {
    verb: '提供',
    noun: '項目',
    productsQuestion: '你主要提供什麼？講三樣最重要的就好，用頓號分開。',
    productsPlaceholder: '例：手工皂、香氛蠟燭、體驗課',
    productsLabel: '主要項目',
    priceLabel: '價格帶',
    channelLabel: '接觸方式',
    channelQuestion: '客人通常怎麼找你？',
    welcomeAsk: '有什麼想問的',
    tryQuestion: '你們有提供什麼？',
    priceAsk: '怎麼收費？',
  },
}

export function storeBizWording(industry: string | null | undefined): StoreBizWording {
  return STORE_BIZ_WORDING[storeBizTypeOf(industry)]
}

/**
 * 輪廓卡上那一格的欄位名照型換（`D-99`）。
 * ⛔ 牙醫診所的卡片上寫「主打商品」「價格帶」，他一眼就知道這東西不是為他做的——
 *    而那張卡是他在精靈裡看得最久的一張。
 */
export function storeProfileLabelFor(fieldId: string, defaultLabel: string, industry: string | null | undefined): string {
  const w = storeBizWording(industry)
  if (fieldId === 'products') return w.productsLabel
  if (fieldId === 'priceRange') return w.priceLabel
  if (fieldId === 'channel') return w.channelLabel
  return defaultLabel
}

/**
 * 歡迎訊息裡「可以問什麼」那半句。
 * 賣東西的照銷售方式再換一次（沿用 `C-221` 原本那條：預約制的人問時段、實體店問營業時間）；
 * 其他型直接用自己那一句——⛔ 對診所講「想問出貨」就是 `D-99` 要修的病。
 */
export function welcomeAskFor(industry: string | null | undefined, channel: string | null | undefined): string {
  const type = storeBizTypeOf(industry)
  if (type !== 'goods') return STORE_BIZ_WORDING[type].welcomeAsk
  const ch = String(channel ?? '')
  if (ch.includes('預約')) return '想預約時段、問服務內容'
  if (ch.includes('實體') && !ch.includes('網購')) return '想問營業時間、怎麼過來'
  return STORE_BIZ_WORDING.goods.welcomeAsk
}
