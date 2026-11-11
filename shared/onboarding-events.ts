/**
 * 開通步驟紀錄（`C-250`③，`D-100` C-1 拍板「升格為上線前提」）。
 *
 * ⭐ 為什麼一定要有：新精靈上線第一天沒記＝那一批真實使用者的行為**永遠拿不回來**，
 *    而這幾週的判斷（打造 5 分鐘夠不夠、多少人會回來接 LINE、卡在哪一張教學圖）全都要靠它驗。
 * ⛔ 只寫不讀也要先寫：看的畫面之後再做，資料現在不記就沒有了。
 *
 * 規矩：
 *   - **事件名稱只能用這張表裡的**（伺服器照表收，打錯字的直接丟、而且要記一筆被丟了什麼）
 *   - 附帶的資料只收小東西（字串 ≤ 60 字、數字、真假），⛔ 不收客人講的話、不收他打的答案原文
 *     （這張表是看「行為」的，不是看內容的；內容本來就存在輪廓與草稿裡）
 *   - 「之後」那幾項（第一位真客人的訊息、第一次 AI 自動回覆、第 7 天有沒有回來）
 *     **不在這裡記**：現有的對話、用量資料就算得出來，另記一份就是兩本帳
 *   - **付款也照同一條規矩**（`D-180`，2026-11-11）：「誰付成功了」一律以帳務（`orders`／
 *     訂閱）為準，⛔ 這裡不記；這裡記的是帳務**看不到**的那幾格——看到橫幅沒、打開方案表沒、
 *     按了哪個方案、在確認框縮手沒、從金流頁回來時畫面上顯示什麼。
 *     ⭐ 沒有這幾格，開賣後只答得出「有幾個人付了」，答不出「其他人停在哪一格」。
 */

export const ONBOARDING_EVENTS = {
  // ── 打造那一趟 ──
  build_start: '打開打造精靈',
  build_later: '第一個畫面就按「我晚點再弄」',
  workspace_created: '建好帳號',
  profile_start: '開始回答五題',
  profile_skip: '五題按了先跳過',
  profile_answer: '回答了一題（選項／自己講／打字）',
  site_given: '最後那題網址給了沒',
  site_read: '讀網站的結果',
  profile_edit: '在輪廓卡上就地改了一格',
  draft_decision: '一樣草稿的決定（採用／先不要／改到空的／沒成功；自己改過沒、換過幾次說法）',
  draft_reword: '草稿按了「換個說法」（換成了沒）',
  tag_ask: '標籤卡按了「問 AI」（問成了沒、回幾顆、擋掉幾顆；`D-171`）',
  tag_build: '標籤建好了（新建幾顆、本來就有幾顆、AI 建議貼標開成了沒；`D-171`）',
  site_cards_shown: '看到網站整理出來的卡',
  build_finish: '走到成績單',
  // ── 落地 ──
  landing_tour: '落地導覽走完或關掉',
  playground_sent: '在測試對話送出一題（帶著：幫他填的／自己打的、有沒有用到等你看過的卡）',
  kb_draft_decision: '在知識庫決定等你看過的卡（收進去／不要）',
  // ── 接 LINE 那一趟 ──
  line_start: '進入接 LINE 那一趟（從哪個入口）',
  has_oa: '有沒有 LINE 官方帳號',
  token_mode: '第一組選教我還是直接貼',
  key_saved: '貼了一組連線資訊（存好了，或 LINE 不認得）',
  webhook_check: '檢查 Webhook 的結果',
  phone_wait: '用手機測試的結果（等了多久、按過幾次不是我）',
  birthday_ask: '成績單之前問「要不要順便問生日」（打開／先不要、存成了沒；`C-468`）',
  line_done: '走到接 LINE 的成績單',
  // ── 付款那一段（`D-180`，2026-11-11）──
  // ⚠️ 這五個都帶 `fid`（同一次付款嘗試的識別碼，見 app/composables/useBillingFunnel.ts）：
  //    中間會整頁離開去 PAYUNi 再回來，沒有它就串不起同一個人的同一次嘗試。
  billing_wall_seen: '看到額度橫幅（快用完 near／已停止回覆 over）',
  billing_plans_open: '打開方案表（從哪個畫面按的）',
  billing_plan_click: '在方案表上按了某個方案（升級／續訂／降級／期末降級）',
  billing_checkout: '確認框按下去了沒、訂單建起來了沒（⛔ 不代表付款成功）',
  billing_gateway_back: '從金流頁回到我們這邊，畫面上顯示的是什麼（含「在金流頁按返回」）',
  // ── 兩趟都有 ──
  wizard_leave: '中途按頁首的「之後再說」（停在第幾格）',
} as const

/**
 * 這一筆屬於哪一趟。⛔ 不認得的一律算 `other`（同 `lineFlowEntry` 的規矩：
 * 不讓前端送來的任意字串流進紀錄）。前後端共用這一支，別各自寫一串三元運算。
 */
export const EVENT_FLOWS = ['build', 'line', 'billing', 'other'] as const
export type EventFlow = typeof EVENT_FLOWS[number]
export function eventFlow(raw: unknown): EventFlow {
  // ⛔ 先驗型別再比對：不可以用 `String(raw)` 比完就把 `raw` 原封不動回傳——
  //    那樣一個 `{ toString: () => 'billing' }` 會讓物件本人被當成 flow 寫進資料庫。
  return typeof raw === 'string' && (EVENT_FLOWS as readonly string[]).includes(raw)
    ? raw as EventFlow
    : 'other'
}

/**
 * 從哪個入口進接 LINE 那一趟（`?entry=`，`D-100` C-1：「第 2 段從哪個入口進來」）。
 * ⛔ 不認得的一律算 `direct`，不要讓網址上的任意字串流進紀錄。
 */
export const LINE_FLOW_ENTRIES = ['band', 'hero', 'pullback', 'direct'] as const
export type LineFlowEntry = typeof LINE_FLOW_ENTRIES[number]
export function lineFlowEntry(raw: unknown): LineFlowEntry {
  return (LINE_FLOW_ENTRIES as readonly string[]).includes(String(raw)) ? raw as LineFlowEntry : 'direct'
}

export type OnboardingEventName = keyof typeof ONBOARDING_EVENTS

export function isOnboardingEvent(name: unknown): name is OnboardingEventName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ONBOARDING_EVENTS, name)
}

export type OnboardingEventProps = Record<string, string | number | boolean>

const MAX_PROPS = 8
const MAX_STR = 60

/**
 * 只留小東西：鍵是英數底線、值是短字串／有限的數字／真假；其他一律丟。
 * 回傳丟掉了幾個（⛔ 丟了要說得出來，伺服器會記進那一筆）。
 */
export function sanitizeEventProps(raw: unknown): { props: OnboardingEventProps, dropped: number } {
  const props: OnboardingEventProps = {}
  let dropped = 0
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { props, dropped }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(props).length >= MAX_PROPS || !/^[a-z][a-zA-Z0-9_]{0,30}$/.test(k)) {
      dropped++
      continue
    }
    if (typeof v === 'boolean') props[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) props[k] = Math.round(v * 1000) / 1000
    else if (typeof v === 'string') props[k] = v.slice(0, MAX_STR)
    else dropped++
  }
  return { props, dropped }
}
