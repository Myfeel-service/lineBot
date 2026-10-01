/**
 * 小幫手改完，頁面當場跟著變、改到的那一塊亮一下（`D-112` 第 4 件）。
 *
 * **它解的問題**：以前按了確定，結果只在對話裡講一句；他正在看的那一頁不會更新，
 * 要自己重新整理才看得到。更糟的是 AI 設定這種「整份表單一起存」的頁：畫面還是舊值，
 * 他順手按一下儲存，就把小幫手剛改的改回去了（而且兩邊都沒有人講一聲）。
 *
 * 做法：有代辦的那幾頁掛一個「改完怎麼重讀、怎麼找到那一塊」的處理函式；
 * 聊天那邊執行成功就通知掛著的頁。頁面不在畫面上（他在別頁叫它做的）、或這一頁現在看不到那一筆
 * → 聊天給「前往查看」：在別頁就先把這件事留在 `pending`、換頁，到了再亮；
 * 就在這一頁就直接叫那一頁 `reveal`（⛔ 換到同一個網址不會重新掛載，`?id=` 那些不會再跑一次）。
 *
 * ⛔ 三條紀律：
 * 1. **他手上有沒存的修改時不重讀**（回 `dirty`）：重讀會把他打到一半的東西蓋掉。
 *    聊天那邊要照實講「畫面上還是舊的、直接存會改回去」。
 * 2. **亮的方式不碰 class**：同一個元素被 Vue 綁 class、又被 JS 手動加 class，重繪就會洗掉
 *    （記憶 `feedback_verify_new_code_actually_runs` 第四種）。用 `element.animate()`，跟 class 無關。
 * 3. 找不到那一塊就回 `missing`，⛔ 不假裝亮過——聊天會改給「前往查看」。
 */
import type { AgentOpPage } from '~~/shared/agent-entry'
import type { AdminOpId } from '~~/shared/types/admin-ops'

export interface AgentOpDoneEvent {
  opId: AdminOpId
  page: AgentOpPage
  /** 改設定的代辦：那一頁上的哪一塊（`data-agent-target` 的值） */
  section?: string
  /** 改清單的代辦：哪一筆 */
  targetId?: string
  at: number
}

/** shown＝亮起來了；missing＝這頁找不到那一塊；dirty＝他有沒存的修改、沒重讀 */
export type AgentOpShowResult = 'shown' | 'missing' | 'dirty'

/**
 * 三種時機，頁面要做的事不一樣：
 * - `fresh`：剛改完、他人就在這一頁 → 重讀資料、亮那一塊。⛔ 不打開它、不清他的篩選（他可能正在做別的事）
 * - `arrived`：從別頁按「前往查看」剛換過來 → 頁面自己正在載（`?id=` 深連結會打開它），只等那一塊出現再亮
 * - `reveal`：他人在這一頁、按了「前往查看」→ 他明確要看了，可以打開它／清篩選／回到放它的那一區
 */
export type AgentOpShowMode = 'fresh' | 'arrived' | 'reveal'

export type AgentOpHandler = (evt: AgentOpDoneEvent, opts: { mode: AgentOpShowMode }) => Promise<AgentOpShowResult>

/**
 * 掛著的頁。放在模組層：頁面與聊天是兩棵不相干的元件樹，靠這份名冊找到對方。
 * ⚠️ 只在瀏覽器裡有東西（`onMounted` 才登記），伺服器端渲染時永遠是空的。
 */
const handlers = new Set<{ page: AgentOpPage, fn: AgentOpHandler }>()

/** 「前往查看」按了、還沒到那一頁的那件事（超過一分鐘就不追了） */
export function useAgentOpPendingView() {
  return useState<AgentOpDoneEvent | null>('agent-op-pending-view', () => null)
}

export function useAgentOpRefresh(page: AgentOpPage, fn: AgentOpHandler) {
  const pending = useAgentOpPendingView()
  const entry = { page, fn }
  onMounted(() => {
    handlers.add(entry)
    const p = pending.value
    if (p && p.page === page && Date.now() - p.at < 60_000) {
      pending.value = null
      void fn(p, { mode: 'arrived' }).catch(() => {})
    }
  })
  onBeforeUnmount(() => {
    handlers.delete(entry)
  })
}

/**
 * 通知掛著的那一頁。回 `absent`＝那一頁現在不在畫面上。
 * 同一頁掛了好幾個（知識庫頁本身＋「等你看過」那塊）時，任何一個亮了就算亮了；有一個是 dirty 就講 dirty。
 */
export async function dispatchAgentOpDone(
  evt: AgentOpDoneEvent,
  mode: Exclude<AgentOpShowMode, 'arrived'> = 'fresh',
): Promise<AgentOpShowResult | 'absent'> {
  const mine = [...handlers].filter(h => h.page === evt.page)
  if (!mine.length) return 'absent'
  const results = await Promise.all(mine.map(h => h.fn(evt, { mode }).catch(() => 'missing' as const)))
  if (results.includes('dirty')) return 'dirty'
  return results.includes('shown') ? 'shown' : 'missing'
}

/**
 * 把 `data-agent-target="<key>"` 那一塊捲進畫面並亮一下。等它出現最多 `timeoutMs`（清單可能還在載）。
 * 表格裡的那一格會亮整列（`tr`）。
 */
export async function flashAgentTarget(key: string | undefined, timeoutMs = 3000): Promise<boolean> {
  if (!key || typeof document === 'undefined') return false
  const el = await waitForElement(`[data-agent-target="${CSS.escape(key)}"]`, timeoutMs)
  if (!el) return false
  const box = el.closest<HTMLElement>('tr') ?? el
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  box.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  // 顏色取主題變數的實值：關鍵影格裡寫 var() 不保證每個瀏覽器都吃
  const glow = getComputedStyle(document.documentElement).getPropertyValue('--color-line-glow').trim() || 'rgba(6, 199, 85, 0.16)'
  const ring = getComputedStyle(document.documentElement).getPropertyValue('--color-line').trim() || '#06c755'
  // 只給前兩格：最後一格不寫＝退回元素自己原本的底色（被選中的那一列不會閃成透明）
  box.animate(
    [
      { backgroundColor: glow, boxShadow: `inset 0 0 0 2px ${ring}`, offset: 0 },
      { backgroundColor: glow, boxShadow: `inset 0 0 0 2px ${ring}`, offset: reduce ? 0.9 : 0.45 },
    ],
    { duration: 2400, easing: 'ease-out' },
  )
  return true
}
