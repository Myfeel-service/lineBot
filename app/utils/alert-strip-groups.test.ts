/**
 * 提醒帶分組規則測試。
 *
 * 為什麼值得測：分組錯了的樣子是「有一顆異常從畫面上消失」——畫面看起來完全正常、
 * 沒有錯誤訊息、沒有人會回報。⛔第一條就是釘「一顆都不能掉」。
 */
import { describe, expect, it } from 'vitest'
import { groupStripRows } from './alert-strip-groups'
import type { StripRowLike } from './alert-strip-groups'

const r = (id: string, severity: StripRowLike['severity'], anchorSelector?: string): StripRowLike =>
  ({ id, severity, anchorSelector })

/** 攤平回 id 陣列——用來確認分組前後沒有掉東西 */
const flat = (gs: ReturnType<typeof groupStripRows>) => gs.flatMap(g => [g.lead.id, ...g.rest.map(x => x.id)])

describe('分組不能吃掉任何一件事', () => {
  it('⛔一顆都不能掉：分組後攤平回來要跟輸入一模一樣（含順序）', () => {
    const rows = [
      r('lineWebhookBroken', 'critical', '[data-tour="org-verify"]'),
      r('liffMissing', 'critical', '[data-tour="org-liff"]'),
      r('lineWebhookUrlMismatch', 'critical', '[data-tour="org-verify"]'),
      r('maintenanceStalled', 'warning'),
      r('liffEndpointBroken', 'critical', '[data-tour="org-liff"]'),
    ]
    expect(flat(groupStripRows(rows)).sort()).toEqual(rows.map(x => x.id).sort())
  })
})

describe('按「帶我看會亮哪一區」分組', () => {
  it('組織頁六顆紅 → 收成兩組（檢查連線 3、LIFF 3）', () => {
    const groups = groupStripRows([
      r('lineWebhookBroken', 'critical', '[data-tour="org-verify"]'),
      r('lineWebhookUrlMismatch', 'critical', '[data-tour="org-verify"]'),
      r('lineChannelConflict', 'critical', '[data-tour="org-verify"]'),
      r('liffMissing', 'critical', '[data-tour="org-liff"]'),
      r('liffEndpointBroken', 'critical', '[data-tour="org-liff"]'),
      r('liffEndpointUrlMismatch', 'critical', '[data-tour="org-liff"]'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.lead.id).toBe('lineWebhookBroken')
    expect(groups[0]!.rest.map(x => x.id)).toEqual(['lineWebhookUrlMismatch', 'lineChannelConflict'])
    expect(groups[1]!.lead.id).toBe('liffMissing')
    expect(groups[1]!.rest).toHaveLength(2)
  })

  it('每一組出現在它領頭的位置（⛔不可以把同組的重新排到一起、打亂紅在前）', () => {
    const groups = groupStripRows([
      r('a', 'critical', '[data-tour="x"]'),
      r('b', 'critical', '[data-tour="y"]'),
      r('c', 'critical', '[data-tour="x"]'),
    ])
    expect(groups.map(g => g.lead.id)).toEqual(['a', 'b'])
    expect(groups[0]!.rest.map(x => x.id)).toEqual(['c'])
  })

  it('沒有錨點的一律自己一組——沒有「帶我看」就沒有共同目的地，硬併會騙人', () => {
    const groups = groupStripRows([
      r('maintenanceStalled', 'warning'),
      r('scannerStalled', 'warning'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.rest.length === 0)).toBe(true)
  })

  it('跨頁那顆（逗號列四頁的選擇器）自己一組——它的區塊在別頁，併不得', () => {
    const groups = groupStripRows([
      r('anyTextBlocking', 'critical', '[data-tour="scr-list"]'),
      r('brokenModuleButton', 'critical', '[data-tour="rm-list"], [data-tour="scr-list"]'),
    ])
    expect(groups).toHaveLength(2)
  })

  it('一組的嚴重度取領頭的（rows 紅在前，所以紅琥珀同組時算紅）', () => {
    const groups = groupStripRows([
      r('scriptDeadEnd', 'critical', '[data-tour="scr-list"]'),
      r('scriptUnreachable', 'warning', '[data-tour="scr-list"]'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.severity).toBe('critical')
  })
})
