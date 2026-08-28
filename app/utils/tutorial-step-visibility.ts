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
