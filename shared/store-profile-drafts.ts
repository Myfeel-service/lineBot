/**
 * 從店家輪廓長出來的「五樣草稿」（`D-85` / `C-221`）。
 *
 * ── 為什麼是這五樣 ─────────────────────────────────────────────
 * 輪廓卡本身不值錢，值錢的是它長出來的東西。這五樣正好是新帳號第一天
 * **最常被跳過**的五件事（`D-23` 查到最近 90 天約 667 位加好友的人一句話都沒收到，
 * 就是因為第一樣沒人做）。
 *
 * ── 三條鐵律 ───────────────────────────────────────────────────
 * ① **內容用範本生，不用 LLM**。這幾段話要能被測試釘住、每次一樣、不會幻覺，
 *    而且商家看得懂「它是照我填的東西組的」。⛔ 不要為了「更聰明」把它換成模型生成——
 *    那會讓同一份輪廓每次產出不同文案，人會以為系統壞了。
 * ② **對客人說話的東西一律是草稿**，按了採用才寫出去（08-14 紅線：最後一顆按鈕留人）。
 * ③ **失敗路比成功路重要**：一次建好幾樣，第三樣失敗時如果只說「失敗」，
 *    人會以為什麼都沒發生而重跑 → 多出重複的標籤與腳本，而且他不會知道。
 *    所以 `summarizeDraftApply` 會**點名已經建好、還留在系統裡的東西**（沿用 `campaign-wizard`）。
 */

import {
  STORE_PROFILE_FIELDS,
  type StoreProfileDoc,
  type StoreProfileFieldId,
} from './types/store-profile'
import { TAIWAN_FESTIVALS, type TaiwanFestival } from './taiwan-festivals'
import { daysBetween } from './time'
import { storeBizTypeOf, storeBizWording, welcomeAskFor } from './store-profile-biz'
import { TAG_TEMPLATES } from './tag-templates'
import {
  TONE_ROLES,
  TONE_ROLES_BY_BIZ,
  TONE_SAMPLE_NOTE,
  TONE_SAMPLE_QUESTION,
  pickDefaultToneRole,
  toneSampleAnswer,
  type ToneRoleId,
} from './ai-tone-roles'

// ── 哪幾樣 ─────────────────────────────────────────────────────

export type StoreDraftKey = 'welcome' | 'tone' | 'tags' | 'knowledge' | 'calendar'

export const STORE_DRAFT_KEYS: readonly StoreDraftKey[] = ['welcome', 'tone', 'tags', 'knowledge', 'calendar'] as const

/** 這一樣採用之後，東西會出現在後台哪裡（指路一律用側欄的名字，`C-210` 同一條紀律） */
export const STORE_DRAFT_WHERE: Record<StoreDraftKey, string> = {
  welcome: '自動回應 › 客人加好友時',
  tone: 'AI 設定',
  tags: '標籤管理',
  knowledge: '知識庫',
  calendar: '每天早上的摘要',
}

export const STORE_DRAFT_TITLE: Record<StoreDraftKey, string> = {
  welcome: '加好友歡迎訊息',
  tone: 'AI 說話的語氣',
  tags: '分眾標籤',
  knowledge: '知識庫初稿',
  calendar: '未來 90 天的行銷月曆',
}

/**
 * 這一樣要不要「採用」。
 * - `adopt`：會寫東西，所以要按採用（歡迎、語氣、標籤、知識庫）
 * - `info`：⛔ **沒有東西要寫**——節慶提醒（`C-54`）本來就在跑，
 *   給他看清單是「告訴他已經有了」，不是要他做什麼。假裝它需要採用就是編一顆假按鈕。
 */
export const STORE_DRAFT_KIND: Record<StoreDraftKey, 'adopt' | 'info'> = {
  welcome: 'adopt',
  tone: 'adopt',
  tags: 'adopt',
  knowledge: 'adopt',
  calendar: 'info',
}

// ── 生內容 ─────────────────────────────────────────────────────

export interface DraftContext {
  /** 官方帳號名稱（拿來當店名） */
  shopName: string
  profile: StoreProfileDoc
  /** 今天，YYYY-MM-DD（台北時區）。測試要餵固定值 */
  today: string
  /** `C-220` 讀到了幾頁；0＝沒讀到（知識庫那樣就不給） */
  pagesRead?: number
}

function fieldValue(profile: StoreProfileDoc, id: StoreProfileFieldId): string {
  return String(profile.fields?.[id]?.value ?? '').trim()
}

/**
 * 價格帶的起點。`｜`／`|` 是 `aiHint` 教模型用的分隔符，其餘幾種是它實際也會吐的寫法。
 * ⚠️ 只要開頭是價格記號**而且後面接數字**才算，不然「NT 限定款」這種商品名會被砍掉。
 */
const PRICE_BAND_START = /[｜|]|[（(]?\s*(?:NT\s*[$＄]|[$＄]|NT\s*(?=\d)|價格帶?|價位|售價)\s*[:：]?\s*\d/

/**
 * 把價格帶從「主打商品」那一格剝掉（`C-249`／`D-92`）。
 *
 * `priceRange` 拆成獨立欄位之後，新資料的 `products` 裡本來就不該有價格——
 * 但**商家自己打的字不受欄位約束**，而且模型偶爾還是會把價格塞回商品那一格。
 * ⛔ 所以這道剝除不是過渡期措施，是常駐的防守。
 */
export function stripPriceBand(raw: string): string {
  const s = String(raw ?? '')
  const at = s.search(PRICE_BAND_START)
  const head = at >= 0 ? s.slice(0, at) : s
  // 剝完常留下一顆孤兒分隔符或半個括號（「…節慶禮盒、」「…節慶禮盒（」）
  return head.trim().replace(/[、,，/／｜|（(\s]+$/, '')
}

/**
 * 把「黑豆水、養生茶包、節慶禮盒」拆成陣列（全形或半形逗號、頓號都收）。
 *
 * ⛔ **兩道防守缺一不可**，因為它們擋的是不同的東西：
 *   ① 先剝掉價格帶——擋「商品｜NT$180–1,280」這種帶分隔符的寫法。
 *   ② 再把**夾在兩個數字中間的逗號**拿掉——擋剝不掉的漏網之魚。
 *      `1,280` 那顆逗號是千分位，**從來不是商品的分隔符**，留著它就會把
 *      「節慶禮盒｜NT$180–1,280」切成「…NT$180–1」和「280」，
 *      而切壞的前半段會以**商品名**的身分寫進 `aiSettings.systemPrompt`
 *      （`buildToneDraft` 是整包覆蓋），商家在輪廓卡上看到的卻是完整的區間。
 */
export function splitProducts(raw: string): string[] {
  return stripPriceBand(raw)
    .replace(/(\d)[,，](\d)/g, '$1$2')
    .split(/[、,，/／]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 3)
}

/**
 * 加好友歡迎訊息。
 * ⛔ **不要插 `{{displayName}}`**：取不到名字時會變成空字串，而這是客人看到的第一句話
 *    （`BUILTIN_VARIABLE_HINT` 那條警告講的就是這個）。這裡刻意只用店名與商品。
 */
export function buildWelcomeDraft(ctx: DraftContext): string {
  const shop = String(ctx.shopName ?? '').trim() || '我們'
  const products = splitProducts(fieldValue(ctx.profile, 'products'))
  const industry = fieldValue(ctx.profile, 'industry')
  const channel = fieldValue(ctx.profile, 'channel')
  // ⚠️ `C-250`／`D-99`：「主要做」照型換（賣／做／開／提供）
  const verb = storeBizWording(industry).verb

  const what = products.length === 0
    ? ''
    : products.length === 1
      ? `我們主要${verb}${products[0]}。`
      : `我們主要${verb}${products.slice(0, 2).join('、')}${products.length > 2 ? '等' : ''}。`

  // 「可以問什麼」照型換；賣東西的再照銷售方式換（預約制問時段、網購問出貨）。
  // ⛔ 原本只看銷售方式——牙醫診所選了「實體＋網購」就會被寫成「想問商品、出貨」（`D-99` 漏網）
  const ask = `${welcomeAskFor(industry, channel)}，直接在這裡留言就好`

  return `嗨，歡迎加入${shop} 👋\n${what}${ask}，我會盡快回你 😊`
}

/**
 * AI 說話的語氣（會寫進 `aiSettings.systemPrompt`）。
 *
 * ⛔ **一定要保留原本那幾條安全規則**（只照知識卡回答、不編造、敏感題交給人）：
 *    這一格是整包覆蓋 `systemPrompt`，只寫語氣的話，等於把那些紅線刪掉。
 *    這是「加一個功能結果把既有防線拆掉」最典型的形狀。
 */
/**
 * 語氣草稿後半段的安全規則。
 * ⛔ 「換個說法」（`D-89`）**只換開頭那一句和口氣那一行**，這一段一字不動——
 *    讓模型連規則一起重寫＝我們自己把安全網拆了，而且他不會發現（那段字他不會逐字讀）。
 */
export const TONE_SAFETY_RULES = [
  '回覆原則（⛔ 這幾條不要刪）：',
  '1. 只能根據提供的「知識卡內容」回答；知識卡沒寫到的，不要自己編、也不要拿沾邊的內容硬湊。',
  '   （需要轉真人時，系統會自動安排，你不必、也不要在回覆裡寫「我幫您轉接」之類的話。）',
  '2. 回覆要簡短、口語、有禮貌；不要使用 markdown 或項目符號。',
  '3. 價格、成分、出貨天數這類數字，只能講知識卡上寫的，不要估、不要四捨五入。',
  '4. 涉及退費、法律糾紛、醫療診斷等，務必交給專人，不要自己給建議。',
].join('\n')

/** 「換個說法」換的那兩處（其餘的事實行與安全規則照範本） */
export interface ToneVoice {
  /** 開頭那一句（例：「你代表○○回覆客人。」） */
  opener?: string
  /** 口氣那一行冒號後面的字 */
  voice?: string
}

export function buildToneDraft(ctx: DraftContext, voice: ToneVoice = {}): string {
  const shop = String(ctx.shopName ?? '').trim()
  const industry = fieldValue(ctx.profile, 'industry')
  const tone = fieldValue(ctx.profile, 'tone')
  const customers = fieldValue(ctx.profile, 'customers')
  const products = splitProducts(fieldValue(ctx.profile, 'products'))

  /**
   * ⛔ 2026-09-26（`C-250`／`D-99`）**不再寫成「你是一家○○的客服助理」**：產業別現在可以自己打
   *    （「都不是，我自己講」），填「手工皂與香氛的工作室」就會變成「你是一家手工皂與香氛的工作室的客服助理」。
   *    改成**條列**——這段字是給模型看的，結構化本來就比通順的句子好，而且填什麼都不會壞。
   */
  const opener = String(voice.opener ?? '').trim()
  const voiceText = String(voice.voice ?? '').trim().replace(/[。.]+$/, '')
  const lines = [
    opener || (shop ? `你是${shop}的客服助理。` : '你是這家店的客服助理。'),
    ...(industry ? [`店的類型：${industry}`] : []),
    ...(products.length ? [`${storeBizWording(industry).productsLabel}：${products.join('、')}`] : []),
    ...(customers ? [`主要客群：${customers}`] : []),
  ]

  return [
    ...lines,
    voiceText ? `說話的口氣：${voiceText}。` : tone ? `說話的口氣：${tone}。` : '說話的口氣：親切、口語、不誇大。',
    '',
    TONE_SAFETY_RULES,
  ].join('\n')
}

/**
 * 哪幾樣可以「換個說法」（`D-89`）：**只有會被客人看到／決定 AI 怎麼講話的那兩段**。
 * ⛔ 標籤不給：三顆是照旺季與銷售方式挑的，換一版只會得到另外三顆同樣沒有根據的名字。
 */
export const REWORDABLE_DRAFTS: readonly StoreDraftKey[] = ['welcome', 'tone'] as const
/** 一張草稿卡最多換幾次（⛔ 用完要明講，不可以按了沒反應） */
export const REWORD_MAX_PER_CARD = 5

export interface TagDraft {
  name: string
  /** 給人看的一句話：這顆標籤之後拿來做什麼（建立時寫進標籤的說明，給團隊看） */
  why: string
  /**
   * AI 判斷條件（`D-171`）：建立時寫進標籤的 `aiCriteria`，AI 讀對話時照這一句判斷要不要建議貼上。
   * ⛔ **講不出這一句的標籤不放進開帳**——沒有貼法的標籤永遠 0 人（舊版的「回購客」就是這樣）。
   */
  criteria: string
  /**
   * 固定代號。跟「標籤管理」範本是同一顆的就用範本的代號：之後再按範本會認得是同一顆，不會建出第二顆。
   * 沒給（「問 AI」加進來的）就照名字生。
   */
  code?: string
  /** 一開始有沒有勾（`D-171` 示意頁 v2：一排六顆、先勾三顆推薦的） */
  picked: boolean
}

/** 標籤卡上面那一句（`D-171` 示意頁 v2） */
export const TAG_DRAFT_LEAD = '勾起來，之後發推播就能只發給他們。'

/**
 * 每張草稿卡最上面、MiniMe 頭像旁邊講的那一句（`D-174`，John 哥 11-04：「這個看不懂，這一張是什麼東西？」
 * 「M 尼的頭像，然後講話——我幫你整理好了，下面就是內容」）。
 * ⭐ 一句話講「這是什麼」，下面的框就是內容；⛔ 不再是「標題＋→ 放在哪＋框＋小字」四塊分不出誰是誰。
 * 「存在哪」改由採用後那一句講（`已採用 ✓ 存在「…」`）——那一刻才是他需要知道的時候。
 */
export const STORE_DRAFT_SPEECH: Record<'welcome' | 'tone' | 'tags', string> = {
  welcome: '客人加你好友時，我會先傳這則 👇',
  tone: '客人問問題時，你要我像誰一樣回？',
  tags: `以後想分哪幾種客人？${TAG_DRAFT_LEAD.replace(/。$/, '')} 👇`,
}
/**
 * 標籤卡下面那一句：怎麼貼上去。
 * ⚠️ 前提是採用時會順手打開「AI 建議貼標」（`D-171` 甲，2026-11-05 老闆「好 執行」）——
 *    打開失敗時，採用後的那一句要改口（見開帳劇本）。
 */
export const TAG_DRAFT_AI_LINE = '客人在對話裡聊到，AI 會提醒你貼上。'

type TagChip = Omit<TagDraft, 'picked'>

/** 跟「標籤管理」範本同一顆：代號、判斷條件照範本（範本的判斷條件是拿真實對話調過的） */
function fromTemplate(code: string, name: string, why: string): TagChip {
  const t = TAG_TEMPLATES.find(x => x.code === code)
  // ⛔ 範本改了代號這裡要一起改；判斷條件空掉＝這顆永遠 0 人（守門測試鎖著）
  return { code, name, why, criteria: t?.criteria ?? '' }
}

/**
 * 開帳可以挑的標籤（`D-171`）。⛔ **每一顆都要是客人在 LINE 對話裡講得出來的事**：
 *   AI 讀對話判斷得出來，才有人會被貼上。「回購客」「第一次來」「VIP」要訂單或來店紀錄，
 *   我們沒有＝永遠 0 人，⛔ 不放。
 * ⛔ 名字要照使用者的單位取（`D-83` 盤點：正式庫的標籤是「一檔商品」「一件事」，不是漂亮的分類學）。
 */
const TAG_CHIP = {
  price: fromTemplate('asked_price', '問過價格優惠', '對價格敏感的一群，限時折扣一發最快有反應。'),
  complained: fromTemplate('complained', '客訴過', '發優惠前先排除他們，也是要回頭關心的名單。'),
  shipping: fromTemplate('asked_shipping_status', '問過出貨進度', '出貨延誤時一次通知這群人，不用等他們一個個來問。'),
  waiting: fromTemplate('waiting_launch', '在等開賣', '新品開賣、補貨當天最準的名單——他們自己說過在等。'),
  returning: fromTemplate('return_in_progress', '退換貨處理中', '發促銷前先排除，正在辦退貨還收到優惠最容易引爆客訴。'),
  gift: {
    code: 'asked_gift',
    name: '想買來送禮',
    why: '節慶檔期的推播最先想到的就是這一群。',
    criteria: '客人提到要買來送人、問禮盒、包裝、提袋、卡片，或問送長輩、送客戶送什麼好。自己要用的不算。',
  },
  bulk: {
    code: 'asked_bulk',
    name: '問過大量訂購',
    why: '有團購價或企業禮盒時先找他們。',
    criteria: '客人詢問團購、大量購買、公司或活動訂購、企業禮品的數量與價格。只買一兩件的不算。',
  },
  // ── 吃的（餐飲／飲料、不是網購為主） ──
  reserve: {
    code: 'asked_reservation',
    name: '問過訂位',
    why: '平日有空位或有優惠時，先通知想來的這群人。',
    criteria: '客人詢問訂位、還有沒有位子、要不要排隊，或直接說要訂幾位、幾點到。只問營業時間的不算。',
  },
  takeout: {
    code: 'asked_takeout',
    name: '問過外帶外送',
    why: '外帶、外送有活動時只發給他們。',
    criteria: '客人詢問能不能外帶、自取、外送，用哪個外送平台，或外送範圍與運費。',
  },
  diet: {
    code: 'asked_diet',
    name: '問過素食過敏',
    why: '出新的素食或不含過敏原的餐點時先告訴他們。',
    criteria: '客人詢問有沒有素食、蛋奶素、無麩質，或提到自己對某種食物過敏、不吃牛等飲食限制。',
  },
  party: {
    code: 'asked_party',
    name: '問過包場聚餐',
    why: '尾牙、慶生這種聚餐旺季前先找他們。',
    criteria: '客人詢問包場、聚餐、慶生、尾牙、多人訂位或團體套餐。兩三個人的一般訂位不算。',
  },
  // ── 做服務 ──
  booking: {
    code: 'asked_booking',
    name: '問過預約時段',
    why: '臨時有空檔或加開時段時，先通知想約的這群人。',
    criteria: '客人詢問還有沒有空檔、某天某時段能不能約、要等多久，或說想預約。已經約好、只是來確認時間的不算。',
  },
  service: {
    code: 'asked_service',
    name: '問過服務內容',
    why: '還在了解的人；有體驗價或新項目時先找他們。',
    criteria: '客人詢問某項服務或療程怎麼做、要多久、適不適合自己、前後要注意什麼。只問價格的不算。',
  },
  voucher: {
    code: 'asked_voucher',
    name: '問過禮券套票',
    why: '節日推禮券、套票時先找他們。',
    criteria: '客人詢問禮券、儲值、套票、多堂優惠，或想買來送人。',
  },
  reschedule: {
    code: 'asked_reschedule',
    name: '改過時間',
    why: '常改期的人；臨時有空檔釋出時最可能補進來。',
    criteria: '客人要改預約時間、延後、取消，或說臨時不能來。只問「可以改時間嗎」但沒有真的要改的不算。',
  },
  // ── 教課 ──
  schedule: {
    code: 'asked_schedule',
    name: '問過開課時間',
    why: '開新班或加開時段時先通知他們。',
    criteria: '客人詢問下一期什麼時候開、上課時段、平日班或週末班、還有沒有名額。',
  },
  // ⚠️ 跟賣東西那顆「問過價格優惠」同一個代號（同一件事，教課的說法）——兩顆不會出現在同一家店
  tuition: {
    code: 'asked_price',
    name: '問過學費優惠',
    why: '早鳥或團報優惠一發最快有反應。',
    criteria: '客人詢問學費、早鳥價、團報、分期付款或退費規定。',
  },
  trial: {
    code: 'asked_trial',
    name: '問過試聽',
    why: '有試聽或體驗課時先找他們。',
    criteria: '客人詢問能不能試聽、上體驗課、旁聽，或想先看看上課狀況再決定。',
  },
  level: {
    code: 'asked_level',
    name: '問過適不適合',
    why: '還在評估的人；有說明會或程度測驗時先找他們。',
    criteria: '客人詢問程度、年齡、沒有基礎能不能上、要準備什麼，或描述自己（或孩子）的狀況問適不適合。',
  },
  online: {
    code: 'asked_online',
    name: '問過線上補課',
    why: '開線上班或錄影課時先告訴他們。',
    criteria: '客人詢問有沒有線上課、錄影，或請假怎麼補課。',
  },
  // ── 中性（自己打的產業別） ──
  news: {
    code: 'waiting_news',
    name: '在等新消息',
    why: '有新活動、新品推出時先通知他們。',
    criteria: '客人詢問下一次什麼時候有、新活動或新品何時推出，或說有消息再通知他。',
  },
  coop: {
    code: 'asked_cooperation',
    name: '問過合作',
    why: '有企業方案或合作機會時先找他們。',
    criteria: '客人詢問合作、批發、代理、企業或團體方案。一般消費者自己要用的不算。',
  },
  hours: {
    code: 'asked_hours',
    name: '問過時間地點',
    why: '時間或地點有變動時先通知他們。',
    criteria: '客人詢問營業或服務時間、地址、怎麼去、哪天有開。',
  },
} satisfies Record<string, TagChip>

function chipRow(picked: TagChip[], more: TagChip[]): TagDraft[] {
  return [...picked.map(c => ({ ...c, picked: true })), ...more.map(c => ({ ...c, picked: false }))]
}

/**
 * 開帳那張標籤卡的六顆：前三顆先勾好（推薦的），後三顆不勾（`D-171` 示意頁 v2）。
 *
 * 🔴 2026-09-26（`C-250`／`D-99`）照型換：牙醫診所拿到「送禮客」「問過出貨」是兩顆一輩子用不到的標籤，
 *    而標籤**建了就留在帳號裡**（名字可改、代號改不了）。
 * 🔴 2026-11-05（`D-171`）拿掉「回購客／續報家長／回頭客／問過還沒買」這類：要訂單或來店紀錄才分得出來，
 *    我們沒有，那幾顆建了永遠 0 人。換成對話裡講得出來的事，並且每顆帶 AI 判斷條件。
 */
export function buildTagDrafts(ctx: DraftContext): TagDraft[] {
  const channel = fieldValue(ctx.profile, 'channel')
  const season = fieldValue(ctx.profile, 'season')
  const industry = fieldValue(ctx.profile, 'industry')
  const C = TAG_CHIP

  const type = storeBizTypeOf(industry)
  if (type === 'service') return chipRow([C.booking, C.price, C.service], [C.complained, C.voucher, C.reschedule])
  if (type === 'class') return chipRow([C.schedule, C.tuition, C.trial], [C.level, C.online, C.complained])
  if (type === 'neutral') return chipRow([C.price, C.news, C.complained], [C.gift, C.coop, C.hours])

  // 吃的：訂位、外帶外送比「出貨」貼切（⚠️ 網購為主的食品店照一般賣東西那一套：他們真的要出貨）
  if (industry === '餐飲／飲料' && !channel.includes('網購為主')) {
    return chipRow([C.reserve, C.takeout, C.complained], [C.diet, C.price, C.party])
  }

  const giftSeason = season.includes('送禮') || season.includes('春節') || season.includes('中秋')
  const [first, other] = giftSeason ? [C.gift, C.waiting] : [C.waiting, C.gift]
  return channel.includes('網購')
    ? chipRow([C.price, first, C.shipping], [C.complained, other, C.returning])
    : chipRow([C.price, first, C.complained], [other, C.bulk, C.returning])
}

export interface CalendarEntry {
  date: string
  name: string
  /** 跨產業通用的一句話（`taiwan-festivals` 的 angle）。⛔ 這一版不客製，客製是 `C-223` */
  angle: string
  /** 距今幾天 */
  inDays: number
}

/** 未來 N 天內的節日。⛔ 只列、不承諾客製句（那是 `C-223`）。 */
export function buildCalendarDraft(ctx: DraftContext, windowDays = 90): CalendarEntry[] {
  const out: CalendarEntry[] = []
  for (const f of TAIWAN_FESTIVALS as readonly TaiwanFestival[]) {
    const d = daysBetween(ctx.today, f.date)
    if (d < 0 || d > windowDays) continue
    out.push({ date: f.date, name: f.name, angle: f.angle, inDays: d })
  }
  return out
}

// ── 一整包 ─────────────────────────────────────────────────────

/**
 * 語氣卡（`D-175`）：四個「像誰」、每個附同一題的示範回答。
 * ⚠️ 採用時寫出去的是 `buildToneDraft(ctx, { voice: TONE_ROLES[他選的].voice })`，不是 `body` 原文。
 */
export interface ToneDraft {
  /** 示範那一題（「有推薦的嗎？」） */
  question: string
  /** 一開始先選的那一個（照網站猜的口氣挑，`pickDefaultToneRole`） */
  picked: ToneRoleId
  roles: Array<{ id: ToneRoleId, label: string, trait: string, sample: string }>
}

export interface StoreDraft {
  key: StoreDraftKey
  title: string
  where: string
  kind: 'adopt' | 'info'
  /** MiniMe 頭像旁邊那一句（`D-174`，`STORE_DRAFT_SPEECH`） */
  speech: string
  /** 給人看的內容（歡迎訊息＝那段話；標籤＝先勾的那幾個名字；語氣＝寫進 AI 設定的那一段） */
  body: string
  /** 卡片下面的補充（例如去 LINE 後台關掉內建歡迎；標籤卡＝怎麼貼上去） */
  note?: string
  /** 標籤那一樣的結構化內容（套用時要用） */
  tags?: TagDraft[]
  /** 語氣那一樣的四個角色（`D-175`） */
  tone?: ToneDraft
  /** 月曆那一樣的結構化內容 */
  calendar?: CalendarEntry[]
}

/** 語氣卡的四個角色（照店的類型），一開始先選照網站口氣猜的那一個 */
export function buildToneRoleDraft(ctx: DraftContext): ToneDraft {
  const industry = fieldValue(ctx.profile, 'industry')
  const biz = storeBizTypeOf(industry)
  const first = splitProducts(fieldValue(ctx.profile, 'products'))[0] ?? ''
  return {
    question: TONE_SAMPLE_QUESTION[biz],
    picked: pickDefaultToneRole(industry, fieldValue(ctx.profile, 'tone')),
    roles: TONE_ROLES_BY_BIZ[biz].map(id => ({
      id,
      label: TONE_ROLES[id].label,
      trait: TONE_ROLES[id].trait,
      sample: toneSampleAnswer(id, biz, first),
    })),
  }
}

/**
 * 生出這一次要給他看的草稿。
 *
 * ⛔ **生不出來的就不要給**：沒讀到網站就沒有知識庫那一樣，
 *    給一張「我幫你整理了 0 張卡」的卡片比不給還糟。
 */
export function buildStoreDrafts(ctx: DraftContext): StoreDraft[] {
  const drafts: StoreDraft[] = []

  drafts.push({
    key: 'welcome',
    title: STORE_DRAFT_TITLE.welcome,
    where: STORE_DRAFT_WHERE.welcome,
    kind: 'adopt',
    speech: STORE_DRAFT_SPEECH.welcome,
    body: buildWelcomeDraft(ctx),
    // ⚠️ LINE 沒有開放介面讓我們讀那個開關，所以只能講、⛔ 不可以寫成「已為你關閉」。
    // 🔴 2026-09-26（`C-250`／`D-100`）：原本叫他「採用之後記得去 LINE 後台把內建那則關掉」，
    //    而接 LINE 那一趟站在那顆開關前面時卻寫「不用動」＝兩處教相反。
    //    ⭐ 改成**在對的時間點講一次**：接 LINE 那一趟的回應設定照「有沒有採用」換圖說，這裡只預告。
    note: '接上 LINE 那一步會提醒你關掉 LINE 內建的那則，客人才不會收到兩則。',
  })

  /**
   * ⭐ `D-175`：口氣用「像誰」來選（四個角色、每個附同一題的示範回答），⛔ 不再給一大段給模型看的指示叫他改。
   * 他選哪一個只換「說話的口氣：」那一行；開頭、事實行與安全規則照範本（`buildToneDraft`）。
   * 「換個說法」跟著拿掉：四個角色就是四種說法，選完要細調到「AI 設定」改那一段。
   */
  const tone = buildToneRoleDraft(ctx)
  drafts.push({
    key: 'tone',
    title: STORE_DRAFT_TITLE.tone,
    where: STORE_DRAFT_WHERE.tone,
    kind: 'adopt',
    speech: STORE_DRAFT_SPEECH.tone,
    body: buildToneDraft(ctx, { voice: TONE_ROLES[tone.picked].voice }),
    note: TONE_SAMPLE_NOTE,
    tone,
  })

  /**
   * ⭐ `D-171`（示意頁 v2）：一排六顆、先勾三顆，可以用講的再加。
   * ⛔ 標題不帶顆數：勾的數量會變，顆數寫在「建立 N 顆」那顆鈕上。
   */
  const tags = buildTagDrafts(ctx)
  drafts.push({
    key: 'tags',
    title: STORE_DRAFT_TITLE.tags,
    where: STORE_DRAFT_WHERE.tags,
    kind: 'adopt',
    // ⚠️ `D-174`：「以後想分哪幾種客人？」＋「勾起來…」原本一句在對話泡泡、一句在卡片裡，現在併成頭像旁那一句
    speech: STORE_DRAFT_SPEECH.tags,
    body: tags.filter(t => t.picked).map(t => t.name).join('、'),
    note: TAG_DRAFT_AI_LINE,
    tags,
  })

  /**
   * ⛔ 2026-09-26（`C-250`）**知識庫那一樣先不給**：原本是一顆「採用」，按下去什麼都不會建立
   *    （讀過的頁內文一小時後刪掉、沒有交給知識庫）＝一個假的決定。示意頁定稿的樣子是
   *    「我讀了你網站 5 頁、整理成 12 張卡」的**說明卡**，但那要後端真的產生待看過的卡
   *    （`C-250` 第三批）。⛔ 在那之前不可以畫一張「整理成 N 張」的卡——N 是假的。
   * ⛔ 行銷月曆那張整張收掉（示意頁 v75）：三個節日他這一刻一件也做不了，
   *    而每天早上的摘要本來就會講；只留成績單上一行。
   */
  return drafts
}

// ── 套用結果 ───────────────────────────────────────────────────

export type DraftApplyStatus = 'done' | 'failed' | 'skipped' | 'declined'

export interface DraftApplyStep {
  key: StoreDraftKey
  label: string
  status: DraftApplyStatus
  error?: string
  /**
   * 標籤那一樣：「AI 建議貼標」這次有沒有開著（`D-171` 甲）。
   * ⛔ 沒開成就不可以講「AI 會提醒你貼上」——成績單、落地導覽都看這一格。
   */
  aiSuggest?: boolean
}

export interface DraftApplyOutcome {
  /** 有沒有任何一樣真的做成 */
  ok: boolean
  headline: string
  lines: string[]
  /**
   * ⛔ **已經建好、還留在系統裡的東西**。
   * 沒有這一段，失敗時人會以為什麼都沒發生而重跑一次，
   * 於是多出重複的標籤與重複的加好友腳本——而且他不會知道。
   */
  leftovers: string[]
}

/**
 * 把逐樣的結果講成人話。沿用 `summarizeCampaignWizard` 的規矩：
 * ⛔ 有東西成了，標題就不可以用「失敗」嚇人；⛔ 失敗時一定要點名已經建好的東西。
 */
export function summarizeDraftApply(steps: DraftApplyStep[]): DraftApplyOutcome {
  const done = steps.filter(s => s.status === 'done')
  const failed = steps.filter(s => s.status === 'failed')
  const ok = done.length > 0

  const lines = steps.map((s) => {
    if (s.status === 'done') return `✅ ${s.label}`
    if (s.status === 'failed') return `❌ ${s.label}——${s.error || '沒有成功'}`
    if (s.status === 'declined') return `⏭️ ${s.label}（你選了先不要）`
    return `⏭️ ${s.label}（沒有執行）`
  })

  const leftovers = failed.length
    ? done.map(s => `${s.label}已經建好了，在系統裡`)
    : []

  let headline: string
  if (failed.length === 0) {
    headline = ok ? '都幫你準備好了。' : '這次沒有要建的東西。'
  }
  else if (ok) {
    // 有東西成了 → ⛔ 不可以用「失敗」當標題
    headline = `幫你準備好 ${done.length} 樣，有 ${failed.length} 樣沒成。`
  }
  else {
    headline = '這次一樣都沒建成，系統裡也沒有留下東西，可以直接再試一次。'
  }

  return { ok, headline, lines, leftovers }
}

/** 輪廓夠不夠生草稿。太空的話生出來的文案會是一堆空洞的句子，不如不給。 */
export function canBuildDrafts(profile: StoreProfileDoc | null | undefined): boolean {
  if (!profile) return false
  return STORE_PROFILE_FIELDS.some(def => def.askStep != null && Boolean(profile.fields?.[def.id]?.value))
}
