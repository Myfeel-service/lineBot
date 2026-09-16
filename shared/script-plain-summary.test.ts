/**
 * 「把流程講成人話」的行為（`D-58`② 用講的建流程）。
 *
 * 這份白話是確認卡上唯一看得懂的東西——它要是漏講或講錯，人就是在盲簽。
 * 釘住：照著流程往下走的順序、繞回去不會無限迴圈、走不到的步驟要講出來不能靜靜吞掉。
 */
import { describe, expect, it } from 'vitest'
import { describeScriptSteps } from './script-plain-summary'

const trigger = (next: string, keywords = ['退貨']) => ({ id: 'n1', type: 'trigger', keywords, matchMode: 'keyword', priority: 1, next }) as any
const collect = (id: string, question: string, next: string, extra = {}) => ({ id, type: 'collect', question, fieldName: 'f', expireMs: 600000, next, ...extra }) as any
const reply = (id: string, text: string, next = '') => ({ id, type: 'reply', text, next }) as any

describe('把流程講成人話', () => {
  it('照著客人會經歷的順序講：什麼時候啟動 → 問什麼 → 回什麼', () => {
    const nodes = [
      trigger('n2'),
      collect('n2', '請給我訂單編號', 'n3'),
      reply('n3', '收到，我們三天內回覆你'),
    ]
    const { steps, unreachable } = describeScriptSteps(nodes, 'n1')

    expect(steps[0]).toContain('客人打「退貨」的時候啟動')
    expect(steps[1]).toContain('請給我訂單編號')
    expect(steps[2]).toContain('三天內回覆')
    expect(unreachable).toEqual([])
  })

  it('有跳過出口要講出來（那顆按鈕客人看得到）', () => {
    const nodes = [trigger('n2'), collect('n2', '請給我訂單編號', 'n3', { skipLabel: '我沒有訂單編號', skipNext: 'n3' }), reply('n3', '好的')]
    expect(describeScriptSteps(nodes, 'n1').steps[1]).toContain('我沒有訂單編號')
  })

  it('⛔ 流程繞回前面的步驟不會卡住（重問、回主選單都會這樣接）', () => {
    const nodes = [trigger('n2'), collect('n2', '請問編號', 'n3'), reply('n3', '再問一次', 'n2')]
    const { steps } = describeScriptSteps(nodes, 'n1')
    expect(steps).toHaveLength(3)
  })

  it('⛔ 走不到的步驟要單獨講出來，不可以靜靜吞掉', () => {
    const nodes = [trigger('n2'), reply('n2', '好的'), reply('n9', '這段沒有人走得到')]
    const { steps, unreachable } = describeScriptSteps(nodes, 'n1')

    expect(steps).toHaveLength(2)
    expect(unreachable[0]).toContain('這段沒有人走得到')
  })

  it('按鈕題要把按鈕字樣列出來（客人看得到的字）', () => {
    const nodes = [
      trigger('n2'),
      { id: 'n2', type: 'quickReply', question: '要辦什麼？', options: [{ label: '退貨', next: '' }, { label: '換貨', next: '' }] } as any,
    ]
    expect(describeScriptSteps(nodes, 'n1').steps[1]).toContain('退貨／換貨')
  })

  it('加好友觸發講「加好友的時候」，不要講成打了什麼字', () => {
    const nodes = [{ id: 'n1', type: 'trigger', triggerEvent: 'follow', keywords: [], priority: 1, next: '' } as any]
    expect(describeScriptSteps(nodes, 'n1').steps[0]).toContain('加好友')
  })

  it('什麼都沒設定的觸發：老實說還沒設定，⛔不要編一個條件出來', () => {
    const nodes = [{ id: 'n1', type: 'trigger', keywords: [], examples: [], priority: 1, next: '' } as any]
    expect(describeScriptSteps(nodes, 'n1').steps[0]).toContain('還沒設定')
  })
})
