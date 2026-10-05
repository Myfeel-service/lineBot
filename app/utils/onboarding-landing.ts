/**
 * 開帳走完回到後台之後（`C-250`②，示意頁 v80／`D-101`／`D-102`）。
 *
 * 三支導覽＋「開帳那一趟建了什麼」這份紀錄：
 *   - **落地 3 步**：打造完按「進入後台」→ 測試對話頁一落地就跑（你做的在哪／LINE 準備好再接／按送出問它一句）
 *   - **上線之後 3 步**：接完 LINE 按「去看看」→ 客服對話頁（你剛剛那一下在這／先看待真人／接下來小幫手會提醒你）
 *   - **看看你剛剛做的東西**：手動按（不自動跑）——小幫手「目前狀況」裡「開帳那一趟幫你建的」那一塊、全部教學最上面（`D-114` 前在「教學」分頁）
 *
 * ⛔ 步驟內容都在這裡組好、元件只負責開跑：文案要照「他這一趟真的做了什麼」換，
 *    寫在元件裡就測不到，而這幾句正是最容易變成假話的地方（講了他沒建的東西、指一排空頁）。
 */
import type { StoreDraftKey } from '~~/shared/store-profile-drafts'
import type { TutorialStep } from '~/utils/tutorial-topics'

/** `?from=` 的兩個值：打造完「進入後台」／接完 LINE「去看看」。讀到之後由 `TutorialAgent` 拿掉（重新整理不重跑） */
export const LANDING_FROM_BUILD = 'onboarding'
export const LANDING_FROM_LINE = 'line-done'

/** 接 LINE 那一趟要多久（跟精靈頁首 `ONBOARDING_FLOWS.line.time` 同一個數字，守門測試鎖著） */
export const LINE_FLOW_MINUTES = '10–15 分鐘'

export interface OnboardingBuiltItem {
  key: StoreDraftKey
  /** 成績單上那一行的字（標籤那一樣帶顆數：「建議的分眾標籤 2 顆」） */
  label: string
}

interface BuiltPlace {
  /** 側欄上那一列的名字（指路一律用側欄的字，`C-210` 同一條紀律） */
  page: string
  /** 側欄那一列的錨點 */
  nav: string
  path: (wid: string) => string
  /** 導覽裡的短名（頁名已經標亮了，⛔ 不再逐一念「在『自動回應』」） */
  short: string
  icon: string
}

/**
 * 每一樣住在哪一頁。⛔ 只列**真的會建出東西**的那幾樣：知識庫初稿與月曆 `C-250` 起不再建
 * （待看過的知識卡是第三批），列進來就是指一頁什麼都沒有的地方。
 */
/** 知識庫那一列（等你看過的卡住在那裡，`C-250`③） */
export const KNOWLEDGE_NAV = '[data-tour="nav-knowledge"]'

export const BUILT_PLACE: Partial<Record<StoreDraftKey, BuiltPlace>> = {
  welcome: { page: '自動回應', nav: '[data-tour="nav-auto-response"]', path: wid => `/admin/${wid}/ai-scripts`, short: '歡迎訊息', icon: '👋' },
  tone: { page: 'AI 設定', nav: '[data-tour="nav-ai-settings"]', path: wid => `/admin/${wid}/ai-settings`, short: 'AI 口氣', icon: '💬' },
  tags: { page: '標籤管理', nav: '[data-tour="nav-tags"]', path: wid => `/admin/${wid}/tags`, short: '分眾標籤', icon: '🏷️' },
}

// ── 紀錄（存在他這台瀏覽器）──────────────────────────────────────
//
// ⚠️ 為什麼只存瀏覽器：這份紀錄只是**指路**（「剛剛那幾樣在哪一頁」），東西本身早就存在
//    腳本／AI 設定／標籤裡了。換一台電腦看不到這份清單＝少一個捷徑，不會少任何資料。
// ⛔ 一律 try/catch：無痕視窗、被擋的儲存空間都會丟例外，指路不可以把頁面弄壞。

const builtKey = (wid: string) => `minime:onb-built:${wid}`
const triedKey = (wid: string) => `minime:pg-tried:${wid}`

export function saveOnboardingBuilt(wid: string, items: OnboardingBuiltItem[]) {
  if (!wid) return
  try {
    localStorage.setItem(builtKey(wid), JSON.stringify(items.filter(i => BUILT_PLACE[i.key])))
  }
  catch {}
}

export function readOnboardingBuilt(wid: string): OnboardingBuiltItem[] {
  if (!wid) return []
  try {
    const raw = JSON.parse(localStorage.getItem(builtKey(wid)) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((i): i is OnboardingBuiltItem =>
      !!i && typeof i.label === 'string' && typeof i.key === 'string' && !!BUILT_PLACE[i.key as StoreDraftKey])
  }
  catch {
    return []
  }
}

/** 在測試對話頁送出過一題（「上線之後」第 3 步照這個決定要不要叫他去問一題） */
export function markPlaygroundTried(wid: string) {
  if (!wid) return
  try {
    localStorage.setItem(triedKey(wid), '1')
  }
  catch {}
}

export function hasTriedPlayground(wid: string): boolean {
  if (!wid) return false
  try {
    return localStorage.getItem(triedKey(wid)) === '1'
  }
  catch {
    return false
  }
}

// ── 三支導覽的步驟 ──────────────────────────────────────────────

/**
 * 打造完的落地 3 步（`D-102`，老闆 09-25：「目前打造 MiniMe 進入後台沒有 tour」「進去後馬上接 tour」）。
 * ⭐ 只講三件他這一刻需要的事：你做的在哪／LINE 什麼時候接（他自己決定）／先問它一句。
 * ⛔ 什麼都沒採用的人，第 1 步沒東西可以指——⛔ 不指一排空頁，整步拿掉。
 * ⛔ 紅帶沒出現（例如 LINE 其實接好了）就不講第 2 步——由呼叫端量過畫面再決定（`hasBand`）。
 *
 * @param bandAction 紅帶那顆鈕上**現在**寫的字（⚠️ 這一步會叫出它的名字，兩邊要是同一份）
 */
export function landingTourSteps(
  built: OnboardingBuiltItem[],
  opts: { hasBand: boolean, bandAction: string, /** 等你看過的知識卡張數（`C-250`③；0＝沒有） */ draftCards?: number },
): TutorialStep[] {
  const steps: TutorialStep[] = []
  const places = built.map(b => BUILT_PLACE[b.key]).filter((p): p is BuiltPlace => !!p)
  const drafts = opts.draftCards ?? 0
  if (places.length || drafts > 0) {
    steps.push({
      target: '[data-tour="nav-main"]',
      // 選單比側欄可視範圍高（短螢幕）時退去框整條側欄：標亮的那幾列仍然在洞裡
      targetTooTallFallback: '.sidebar-scroll',
      mark: [...places.map(p => p.nav), ...(drafts > 0 ? [KNOWLEDGE_NAV] : [])].join(', '),
      title: '你剛剛做的，都在這幾頁',
      description: `亮起來的這幾頁：${[
        ...places.map(p => `<strong>${p.short}</strong>`),
        ...(drafts > 0 ? [`等你看過的 <strong>${drafts} 張知識卡</strong>`] : []),
      ].join('、')}。<strong>隨時都可以改</strong>。`,
      placement: 'right',
    })
  }
  if (opts.hasBand) {
    steps.push({
      target: '[data-tour="onboarding-band"]',
      title: 'LINE 準備好再接',
      description: `接上之前客人還找不到你。要登入 LINE 官方帳號後台、拿手機，約 <strong>${LINE_FLOW_MINUTES}</strong>——`
        + `準備好了按這顆「${opts.bandAction}」，<strong>不用現在做</strong>。`,
      placement: 'bottom',
    })
  }
  // ⚠️ 頁面那塊虛線提示已經寫了「題目幫你填好了，按送出看它怎麼回」——這一步只講頁面沒講的：按下去**會出現什麼**
  steps.push({
    target: '[data-tour="pg-input"]',
    title: '最後，按「送出」問它一句',
    description: '這裡就會出現<strong>客人問你時，它會怎麼回</strong>。',
    placement: 'top',
  })
  return steps
}

/**
 * 接完 LINE 的「上線之後」3 步（`D-101`）：取代原本結尾那支 7 步「帶你認識後台」——
 * 他已經在後台待過（打造完就進來了），而那 7 步前 4 步念的是側欄上本來就寫著的分組名。
 * ⛔ 沒用手機測試的人第 1 步是空的——⛔ 不指著空氣，整步拿掉（結尾那顆鈕的步數要跟著少一步）。
 * ⛔ 「你的手機也會同時收到通知」「每天早上的摘要會傳到你的手機」**這一批不講**：
 *    那要他的 LINE 在通知名單裡，而接 LINE 這一趟還不會把他加進去（`C-250` 第三批才做）。
 */
export function liveTourSteps(opts: {
  received: boolean
  triedPlayground: boolean
  /** 等你看過的知識卡張數（`C-250`③） */
  draftCards?: number
  /** 這支手機真的加進通知名單了（按了「是我」、名單沒滿）——⛔ 只有這個是真的才講「手機會收到通知」 */
  phoneNotified?: boolean
}): TutorialStep[] {
  const steps: TutorialStep[] = []
  if (opts.received) {
    steps.push({
      // ⚠️ 指**清單裡他那一列**、卡片放右邊（實走 1280px 量到的）：指整塊右半邊、卡片放左邊的話，
      //    右半邊左緣只有 474px，說明卡左半截被切到畫面外。右邊又被客人檔案佔掉，上下也塞不下。
      //    先幫他點開那一場（右半邊同時打開，說明卡剛好落在對話內容上方）。
      target: '.conv-list-row .split-list-item',
      clickBefore: '.conv-list-row .split-list-item',
      clickBeforeUnless: '[data-tour="conv-messages"]',
      requiresPresent: '.conv-list-row .split-list-item',
      title: '你手機剛剛那一下，就在這裡',
      description: '客人加好友、傳訊息都會這樣進來。點開就能<strong>直接回</strong>，送到他的 LINE。',
      placement: 'right-start',
    })
  }
  steps.push({
    target: '[data-tour="conv-tabs"]',
    title: '先看「待真人」這一格',
    description: opts.phoneNotified
      ? 'AI 答不出來、客人說要找真人的，會排在這裡——<strong>你的手機也會同時收到通知</strong>。'
      : 'AI 答不出來、客人說要找真人的，會排在這裡。',
    placement: 'right',
  })
  steps.push({
    target: '[data-tour="ta-fab"]',
    title: '接下來，小幫手會提醒你',
    // ⚠️ 照他**真的還沒做的事**講：打造完就進過測試對話的人，⛔ 不再叫他去問一題
    description: liveTodoText(opts),
    placement: 'top-end',
  })
  return steps
}

/** 「上線之後」最後一步：還差哪幾件（兩條路不一樣，⛔ 講他已經做過的事＝廢話） */
function liveTodoText(opts: { triedPlayground: boolean, draftCards?: number, phoneNotified?: boolean }): string {
  const todo: string[] = []
  if ((opts.draftCards ?? 0) > 0) todo.push(`<strong>看過那 ${opts.draftCards} 張知識卡</strong>，客人問價格、細節它才答得出來`)
  if (!opts.triedPlayground) todo.push('去「<strong>測試對話</strong>」問它一題，看它怎麼回你的客人')
  return todo.length
    ? `還差 ${todo.length} 件：${todo.join('；')}。`
    : `哪裡怪怪的、下一步做什麼，它會<strong>主動說</strong>。${opts.phoneNotified ? '每天早上的摘要也會傳到你的手機。' : ''}`
}

/** 「上線之後」會跑幾步（結尾那顆鈕寫的步數要跟導覽計數同一個數字） */
export function liveTourStepCount(received: boolean): number {
  return received ? 3 : 2
}

/**
 * 「看看你剛剛做的東西」（`D-95`，手動按，入口見檔頭）：一樣一步，只走他真的建了的。
 * ⛔ 標籤那一步不講「客人聊過了就會貼上」：AI 讀對話只會**建議**、要人按採用才貼，而且要先開開關。
 */
export function builtTourSteps(built: OnboardingBuiltItem[]): TutorialStep[] {
  const TEXT: Partial<Record<StoreDraftKey, { title: string, description: string }>> = {
    welcome: {
      title: '你剛採用的歡迎訊息在這裡',
      description: '接上 LINE 之後，客人一加好友就會收到那一則。<strong>內容隨時可以改</strong>，改完存檔，下一個加好友的人就收到新的。',
    },
    tags: {
      title: '你剛建的分眾標籤在這裡',
      description: '之後發推播就是挑這幾顆來分眾。<strong>名字可以改，代號不行</strong>——代號是建立時生的。現在還沒有人身上有這些標籤。',
    },
    tone: {
      title: 'AI 說話的口氣在這裡',
      description: '你剛剛採用的那一段就存在這。<strong>最後那幾條安全規則不要刪</strong>——刪了 AI 就可能自己編價格。',
    },
  }
  return built.flatMap((b) => {
    const place = BUILT_PLACE[b.key]
    const t = TEXT[b.key]
    return place && t ? [{ target: place.nav, title: t.title, description: t.description, placement: 'right' as const }] : []
  })
}
