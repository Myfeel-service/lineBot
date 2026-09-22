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

/** 把「黑豆水、養生茶包、節慶禮盒」拆成陣列（全形或半形逗號、頓號都收） */
export function splitProducts(raw: string): string[] {
  return String(raw ?? '')
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
  const channel = fieldValue(ctx.profile, 'channel')

  const what = products.length === 0
    ? ''
    : products.length === 1
      ? `我們主要做${products[0]}。`
      : `我們主要做${products.slice(0, 2).join('、')}${products.length > 2 ? '等' : ''}。`

  // 「可以問什麼」照銷售方式換一句：預約制的人問的是時段，網購的人問的是出貨
  const ask = channel.includes('預約')
    ? '想預約時段、問服務內容，直接在這裡留言就好'
    : channel.includes('實體') && !channel.includes('網購')
      ? '想問營業時間、怎麼過來，直接在這裡留言就好'
      : '想問商品、出貨或購買方式，直接在這裡留言就好'

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
  const industry = fieldValue(ctx.profile, 'industry')
  const tone = fieldValue(ctx.profile, 'tone')
  const customers = fieldValue(ctx.profile, 'customers')
  const products = splitProducts(fieldValue(ctx.profile, 'products'))

  const who = [
    industry ? `你是一家${industry}的客服助理` : '你是這家店的客服助理',
    products.length ? `，主要商品是${products.join('、')}` : '',
    customers ? `，客人多半是${customers}` : '',
    '。',
  ].join('')

  return [
    who,
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
    // ⚠️ LINE 沒有開放介面讓我們讀那個開關，所以只能講、⛔ 不可以寫成「已為你關閉」
    note: '採用之後記得去 LINE 官方帳號後台把內建的那則歡迎訊息關掉，不然客人會連收兩則。我們讀不到那個開關，沒辦法幫你確認。',
  })

  drafts.push({
    key: 'tone',
    title: STORE_DRAFT_TITLE.tone,
    where: STORE_DRAFT_WHERE.tone,
    kind: 'adopt',
    body: buildToneDraft(ctx),
    note: '這會取代原本那段通用的設定。裡面的安全規則（只照知識卡回答、不編造）都留著。',
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

  // ⛔ 沒讀到網站就不給這一樣
  if ((ctx.pagesRead ?? 0) > 0) {
    drafts.push({
      key: 'knowledge',
      title: STORE_DRAFT_TITLE.knowledge,
      where: STORE_DRAFT_WHERE.knowledge,
      kind: 'adopt',
      body: `把我讀到的 ${ctx.pagesRead} 頁整理成知識卡，AI 才有東西可以回答客人。`,
      note: '整理完會**先給你看過**再進知識庫——卡片內容要你確認，不是直接上線。',
    })
  }

  const calendar = buildCalendarDraft(ctx)
  drafts.push({
    key: 'calendar',
    title: STORE_DRAFT_TITLE.calendar,
    where: STORE_DRAFT_WHERE.calendar,
    kind: 'info',
    body: calendar.length
      ? calendar.map(c => `${c.date.slice(5).replace('-', '/')}（${c.inDays} 天後）${c.name}——${c.angle}`).join('\n')
      : '未來 90 天內沒有重要節日。',
    note: '這一樣不用採用——節日前 7、3、1 天，我本來就會在早上那則摘要裡提醒你。',
    calendar,
  })

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
