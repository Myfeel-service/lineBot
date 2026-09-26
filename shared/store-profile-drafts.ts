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
  tags: '建議的分眾標籤',
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
export function buildToneDraft(ctx: DraftContext): string {
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
  const lines = [
    shop ? `你是${shop}的客服助理。` : '你是這家店的客服助理。',
    ...(industry ? [`店的類型：${industry}`] : []),
    ...(products.length ? [`${storeBizWording(industry).productsLabel}：${products.join('、')}`] : []),
    ...(customers ? [`主要客群：${customers}`] : []),
  ]

  return [
    ...lines,
    tone ? `說話的口氣：${tone}。` : '說話的口氣：親切、口語、不誇大。',
    '',
    '回覆原則（⛔ 這幾條不要刪）：',
    '1. 只能根據提供的「知識卡內容」回答；知識卡沒寫到的，不要自己編、也不要拿沾邊的內容硬湊。',
    '   （需要轉真人時，系統會自動安排，你不必、也不要在回覆裡寫「我幫您轉接」之類的話。）',
    '2. 回覆要簡短、口語、有禮貌；不要使用 markdown 或項目符號。',
    '3. 價格、成分、出貨天數這類數字，只能講知識卡上寫的，不要估、不要四捨五入。',
    '4. 涉及退費、法律糾紛、醫療診斷等，務必交給專人，不要自己給建議。',
  ].join('\n')
}

export interface TagDraft {
  name: string
  /** 給人看的一句話：這顆標籤之後拿來做什麼 */
  why: string
}

/**
 * 建議的三顆標籤。
 * ⛔ **名字要照使用者的單位取**：正式庫實況是標籤全叫「問卷 - X」「客服 - X」，
 *    也就是他們的單位是「一檔商品」不是「一種屬性」（`D-83` 盤點）。
 *    所以這裡給的是**用得上的三種分眾**，不是漂亮的分類學。
 */
export function buildTagDrafts(ctx: DraftContext): TagDraft[] {
  const channel = fieldValue(ctx.profile, 'channel')
  const season = fieldValue(ctx.profile, 'season')

  /**
   * 🔴 2026-09-26（`C-250`／`D-99`）三顆標籤照型換。⛔ 原本固定是賣東西那一套——
   *    牙醫診所拿到「送禮客」「問過出貨」，那是兩顆一輩子用不到的標籤，
   *    而標籤是**建了就留在帳號裡**的東西（名字可改、代號改不了）。
   */
  const type = storeBizTypeOf(fieldValue(ctx.profile, 'industry'))
  if (type === 'service') {
    return [
      { name: '回訪客', why: '來過第二次的人。要提醒定期回訪時挑這一顆。' },
      { name: '問過沒預約', why: '問了但還沒約時間的人。有空檔時最值得回頭找的一群。' },
      { name: '預約過', why: '約過一次的人。改時間或臨時有空檔時要優先通知他們。' },
    ]
  }
  if (type === 'class') {
    return [
      { name: '續報家長', why: '續報第二期的人。下一期招生時先找他們。' },
      { name: '問過沒報名', why: '問了但還沒報名的人。開課前最值得回頭找的一群。' },
      { name: '問過時段', why: '在意上課時間的人。調課或加開時段時要優先通知。' },
    ]
  }
  if (type === 'neutral') {
    return [
      { name: '回頭客', why: '來過第二次的人。要發新消息或老客優惠時挑這一顆。' },
      { name: '問過沒成交', why: '問了但還沒下一步的人。有檔期時最值得回頭找的一群。' },
      { name: '問過細節', why: '問過價格或時間的人。有變動時要優先通知他們。' },
    ]
  }

  const drafts: TagDraft[] = [
    { name: '回購客', why: '買過第二次的人。之後要發新品或老客優惠，挑這一顆。' },
  ]

  if (season.includes('送禮') || season.includes('春節') || season.includes('中秋')) {
    drafts.push({ name: '送禮客', why: '買來送人的人。節慶檔期的推播最先想到的就是這一群。' })
  }
  else {
    drafts.push({ name: '問過還沒買', why: '問了但沒下單的人。檔期開跑時最值得回頭找的一群。' })
  }

  drafts.push(channel.includes('預約')
    ? { name: '預約過', why: '來過一次的人。要提醒回訪或推新服務時用得到。' }
    : { name: '問過出貨', why: '在意到貨時間的人。出貨有變動時要優先通知他們。' })

  return drafts.slice(0, 3)
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

export interface StoreDraft {
  key: StoreDraftKey
  title: string
  where: string
  kind: 'adopt' | 'info'
  /** 給人看的內容（歡迎訊息＝那段話；標籤＝三個名字；月曆＝節日清單） */
  body: string
  /** 採用之後這一樣要講的補充（例如去 LINE 後台關掉內建歡迎） */
  note?: string
  /** 標籤那一樣的結構化內容（套用時要用） */
  tags?: TagDraft[]
  /** 月曆那一樣的結構化內容 */
  calendar?: CalendarEntry[]
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
    body: buildWelcomeDraft(ctx),
    // ⚠️ LINE 沒有開放介面讓我們讀那個開關，所以只能講、⛔ 不可以寫成「已為你關閉」。
    // 🔴 2026-09-26（`C-250`／`D-100`）：原本叫他「採用之後記得去 LINE 後台把內建那則關掉」，
    //    而接 LINE 那一趟站在那顆開關前面時卻寫「不用動」＝兩處教相反。
    //    ⭐ 改成**在對的時間點講一次**：接 LINE 那一趟的回應設定照「有沒有採用」換圖說，這裡只預告。
    note: '接上 LINE 那一步會提醒你關掉 LINE 內建的那則，客人才不會收到兩則。',
  })

  drafts.push({
    key: 'tone',
    title: STORE_DRAFT_TITLE.tone,
    where: STORE_DRAFT_WHERE.tone,
    kind: 'adopt',
    body: buildToneDraft(ctx),
    note: '這會取代原本那段通用的設定。裡面的安全規則都留著。',
  })

  const tags = buildTagDrafts(ctx)
  drafts.push({
    key: 'tags',
    title: `${STORE_DRAFT_TITLE.tags} ${tags.length} 顆`,
    where: STORE_DRAFT_WHERE.tags,
    kind: 'adopt',
    body: tags.map(t => `${t.name}——${t.why}`).join('\n'),
    note: '先建起來放著，之後發推播就是挑它們來分眾。現在還沒有人身上有這些標籤。',
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
