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
 *   - 「之後」那幾項（第一位真客人的訊息、第一次 AI 自動回覆、第 7 天有沒有回來、升級付費）
 *     **不在這裡記**：現有的對話、用量、帳務資料就算得出來，另記一份就是兩本帳
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
  draft_decision: '一樣草稿的決定（採用／先不要／改到空的／沒成功）',
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
  line_done: '走到接 LINE 的成績單',
  // ── 兩趟都有 ──
  wizard_leave: '中途按頁首的「之後再說」（停在第幾格）',
} as const

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
