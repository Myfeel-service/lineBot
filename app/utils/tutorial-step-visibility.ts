import type { TutorialStep } from './tutorial-topics'

/**
 * 這一步在**這個角色的畫面上**有沒有東西可以指（2026-08-28）。
 *
 * 為什麼需要：導覽的 target 是真實元素，而右半邊那幾顆（接手、回覆框、客服預存）
 * 對觀察者根本不渲染。不擋的話他會連續看到好幾句「這一步要指的位置目前不在畫面上」，
 * 看起來像教學壞掉。
 *
 * ⛔ 型別是 `import type`，執行期不會把 tutorial-topics 拉進來——那支相依 Element Plus
 *    的圖示元件，在 node 測試環境載不動（同 tutorial-topics.test.ts 檔頭的理由）。
 */
export function stepAllowedForRole(
  step: Pick<TutorialStep, 'requiresOperate' | 'requiresSettings'>,
  role: { canOperate: boolean, canManageSettings: boolean },
): boolean {
  if (step.requiresOperate && !role.canOperate)
    return false
  if (step.requiresSettings && !role.canManageSettings)
    return false
  return true
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
