import type { Capability } from '~~/shared/permissions'
import type { TutorialStep } from './tutorial-topics'

/**
 * 這一步在**這個角色的畫面上**有沒有東西可以指（2026-08-28）。
 *
 * 為什麼需要：導覽的 target 是真實元素，而右半邊那幾顆（接手、回覆框、客服預存）
 * 對觀察者根本不渲染。不擋的話他會連續看到好幾句「這一步要指的位置目前不在畫面上」，
 * 看起來像教學壞掉。
 *
 * `G-109`：以前問的是「客服以上／管理員以上」兩顆大開關，現在問 `requires` 那一項能力——
 * 跟那顆按鈕在頁面上的 `v-if="can('…')"` 讀同一張表，門檻調了兩邊一起動。
 * 主題層級（`TutorialTopic.requires`）也走這支，形狀一樣。
 *
 * ⛔ 型別是 `import type`，執行期不會把 tutorial-topics 拉進來——那支相依 Element Plus
 *    的圖示元件，在 node 測試環境載不動（同 tutorial-topics.test.ts 檔頭的理由）。
 */
export function stepAllowedForRole(
  step: Pick<TutorialStep, 'requires'>,
  role: { can: (capability: Capability) => boolean },
): boolean {
  return !step.requires || role.can(step.requires)
}

/**
 * 這一步的**前提**在畫面上嗎（2026-08-28 code review 修）。
 *
 * 跟 `stepAllowedForRole` 的分工：那支問「這個角色有沒有權限看到」，這支問
 * 「這個帳號現在有沒有東西可以指」。空收件匣的新帳號權限完全正常，但對話頁右半邊
 * 那幾步一場對話都點不開——不擋的話會連續跳五次「位置不在畫面上」、每次乾等兩秒。
 *
 * `has` 由呼叫端提供（實際上就是 `document.querySelector`）：DOM 查詢注入進來，
 * 這支才測得到——⛔別在這裡直接摸 document，測試環境沒有。
 */
export function stepPreconditionMet(
  step: Pick<TutorialStep, 'requiresPresent'>,
  has: (selector: string) => boolean,
): boolean {
  return !step.requiresPresent || has(step.requiresPresent)
}

/**
 * 這一步的 `clickBefore` 現在該不該點（2026-08-28 code review 修）。
 *
 * `clickBeforeUnless` 指的東西已經在畫面上＝使用者手上已經有開著的東西，
 * 這時候點下去就是把他正在看的切掉（對話頁實測：客服正在回第七位客人，
 * 導覽一開就跳到第一位；按「上一步」回來又跳一次）。
 */
export function shouldRunClickBefore(
  step: Pick<TutorialStep, 'clickBefore' | 'clickBeforeUnless'>,
  has: (selector: string) => boolean,
): boolean {
  if (!step.clickBefore)
    return false
  return !step.clickBeforeUnless || !has(step.clickBeforeUnless)
}

interface Span { top: number, bottom: number }

/**
 * 標亮的那幾列（`TutorialStep.mark`）要**全部看得到**：回傳捲動區還要往下捲多少（負＝往上，0＝不用動）。
 *
 * 為什麼需要（2026-11-05 實走量到）：打造完落地第 1 步說「亮起來的這幾頁：歡迎訊息、AI 口氣、分眾標籤」，
 * 框的是整條側欄（`.sidebar-scroll`），但側欄自己會捲——**「AI 設定」那一列在 1440×900、1536×864、
 * 甚至 1920×1080 都落在側欄看得到的範圍下面**。字說三頁亮了、畫面上只看得到兩頁。
 *
 * - `view`＝捲動區**看得到的那一段**（呼叫端先跟視窗取交集）；`marks`＝每一列的上下緣（同一套座標）。
 * - 塞得下：捲最少的距離讓全部進來（上面露出來就不動上面）。
 * - 塞不下：對齊最上面那一列（⛔ 不置中：上下各切一半＝兩頭都看不完整）。
 * - `pad`：留一點邊，外框（2px）與圓角才不會貼著捲動區邊緣被切。
 */
export function marksScrollDelta(view: Span, marks: Span[], pad = 12): number {
  if (!marks.length || view.bottom <= view.top)
    return 0
  const top = Math.min(...marks.map(m => m.top)) - pad
  const bottom = Math.max(...marks.map(m => m.bottom)) + pad
  if (bottom - top > view.bottom - view.top)
    return top - view.top
  if (top < view.top)
    return top - view.top
  if (bottom > view.bottom)
    return bottom - view.bottom
  return 0
}
