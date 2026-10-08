/**
 * 同一個東西只有一個名字（`D-116`，2026-10-08 老闆拍板）。
 *
 * 側欄叫「自動回應」、頁面上的開關叫「啟用／停用」；以前異常卡、開帳待辦、小幫手的範例句與「查了：」
 * 還叫「客服流程」「上架／下架」——沒受過訓練的店家第一眼就看到兩個名字，不知道是不是同一樣東西。
 * `D-37`（08-27）統一過一次，側欄改名時沒帶到這幾份，又分開了。這裡釘住所有跨頁共用的標籤。
 */
import { describe, expect, it } from 'vitest'
import { ALERT_LABELS, ALERT_SCOPE_LABELS } from './types/alerts'
import { SETUP_LABELS } from './types/setup'
import { ADMIN_AGENT_TOOL_LABELS } from './types/admin-agent'
import { ADMIN_OP_LABELS } from './types/admin-ops'

const OLD_NAMES = /客服流程|腳本|上架|下架|自動回覆規則/

describe('跨頁共用的標籤跟側欄同一套字', () => {
  it.each([
    ['異常標題', ALERT_LABELS],
    ['異常面向', ALERT_SCOPE_LABELS],
    ['開帳待辦', SETUP_LABELS],
    ['小幫手「查了：」', ADMIN_AGENT_TOOL_LABELS],
    ['小幫手代辦', ADMIN_OP_LABELS],
  ] as const)('%s', (_name, labels) => {
    for (const [id, label] of Object.entries(labels))
      expect(label, `${id}：「${label}」`).not.toMatch(OLD_NAMES)
  })

  it('等真人的兩種分開講：同事接手沒結束⛔不講成「客人在等」', () => {
    expect(ALERT_LABELS.humanBacklog).toContain('客人在等')
    expect(ALERT_LABELS.humanStale).not.toContain('客人在等')
  })
})
