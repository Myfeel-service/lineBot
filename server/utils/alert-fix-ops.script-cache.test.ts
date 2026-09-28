/**
 * 一鍵修改腳本之後，送訊息熱路徑的腳本快取要一起清（`G-107` #14）。
 *
 * 🔴 原本兩個腳本修復只清「健康狀態」那層（5 分鐘，只影響畫面），沒清送訊息用的那層（60 秒）：
 *    畫面上說「客人的訊息現在輪得到 AI 了」，接下來一分鐘客人照樣被那條攔截接走；
 *    補跳過按鈕也一樣，一分鐘內客人拿到的還是沒有退路的舊流程。
 *    小幫手上下架（admin-ops.ts）踩過同一個坑，那邊的註解與測試記得很清楚。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hotCacheCleared: string[] = []
const healthCacheCleared: string[] = []
const updates: { id: string, patch: Record<string, unknown> }[] = []

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) } }))
vi.mock('./audit-log', () => ({ writeAuditLog: async () => {} }))
vi.mock('./ai-scripts', () => ({
  SCRIPTS_COLLECTION: 'scripts',
  invalidateScriptsCache: (wid: string) => { hotCacheCleared.push(wid) },
}))
vi.mock('./script-health', () => ({
  invalidateScriptHealthCache: (wid: string) => { healthCacheCleared.push(wid) },
}))
vi.mock('./workspace-alerts', async () => {
  const actual = await vi.importActual<typeof import('./workspace-alerts')>('./workspace-alerts')
  return { ...actual, findAnyTextBlockingScripts: async () => [{ id: 's1', name: '全部攔截' }] }
})

const { ALERT_FIX_OPS } = await import('./alert-fix-ops')

/** 一條啟用中、收集題沒有退路的流程（listStuckScripts 直接查 scripts 集合） */
const stuckScript = {
  name: '訂單查詢',
  enabled: true,
  rootNodeId: 't',
  nodes: [
    { id: 't', type: 'trigger', keywords: ['訂單'], matchMode: 'keyword', next: 'c' },
    // 格式限定成英數＝客人手上可能根本沒有的資料，沒有跳過鈕就會被同一題無限重問
    { id: 'c', type: 'collect', question: '請給我訂單編號', fieldName: 'orderNo', format: 'alphanumeric', next: 'r' },
    { id: 'r', type: 'reply', text: '收到', next: '' },
  ],
}

const chain: any = {
  where: () => chain,
  get: async () => ({ docs: [{ id: 's2', data: () => ({ workspaceId: 'w1', ...stuckScript }) }] }),
}
const db = {
  collection: () => ({
    ...chain,
    doc: (id: string) => ({ update: async (patch: Record<string, unknown>) => { updates.push({ id, patch }) } }),
  }),
} as any
const ctx = { db, workspaceId: 'w1', uid: 'u1' }

beforeEach(() => {
  hotCacheCleared.length = 0
  healthCacheCleared.length = 0
  updates.length = 0
})

describe('一鍵修腳本：兩層快取都要清', () => {
  it('🔴 停用「輸入任何內容」的攔截：送訊息用的快取也清掉（⛔不清的話「輪得到 AI 了」是假的）', async () => {
    const res = await ALERT_FIX_OPS['script-disable-anytext'].execute(ctx)
    expect(res.ok).toBe(true)
    expect(updates).toEqual([{ id: 's1', patch: { enabled: false, updatedAt: { __op: 'ts' } } }])
    expect(hotCacheCleared).toEqual(['w1'])
    expect(healthCacheCleared).toEqual(['w1'])
  })

  it('🔴 補跳過按鈕：送訊息用的快取也清掉（⛔不清的話客人一分鐘內拿到的還是舊流程）', async () => {
    const res = await ALERT_FIX_OPS['script-add-skip-exit'].execute(ctx)
    expect(res.ok).toBe(true)
    expect(updates).toHaveLength(1)
    expect(Object.keys(updates[0]!.patch).sort()).toEqual(['nodes', 'updatedAt'])
    expect(hotCacheCleared).toEqual(['w1'])
    expect(healthCacheCleared).toEqual(['w1'])
  })
})
