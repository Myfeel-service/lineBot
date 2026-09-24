import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-import：只需要 clickTrackingBaseUrl
vi.stubGlobal('useRuntimeConfig', () => ({ clickTrackingBaseUrl: '' }))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({ multicastMessage: vi.fn() }))
vi.mock('./broadcast-claim', () => ({ claimBroadcastForSend: vi.fn() }))
vi.mock('./audience', () => ({ resolveAudienceUserIds: vi.fn() }))
vi.mock('./handler', () => ({ renderModuleToLineMessages: vi.fn() }))
vi.mock('./broadcast-click-track', () => ({
  wrapBroadcastMessagesForClickTracking: vi.fn((m: unknown) => m),
}))

import { executeBroadcastSend } from './broadcast-send'
import { renderModuleToLineMessages } from './handler'
import { getDb } from './firebase'
import { multicastMessage } from './line'
import { claimBroadcastForSend } from './broadcast-claim'
import { BROADCAST_ALL_RECIPIENTS_FAILED } from '~~/shared/broadcast-failure'
import { broadcastAggregationUnit } from '~~/shared/broadcast-insight'

const mockGetDb = vi.mocked(getDb)
const mockMulticast = vi.mocked(multicastMessage)
const mockClaim = vi.mocked(claimBroadcastForSend)

type Patch = Record<string, any>

/**
 * 假 Firestore：
 * - failCommit：batch.commit() 拋錯（真實事故就是這裡逾時，而資料其實已落地）
 * - failStatusWriteNth：讓第 N 次「帶 status 的寫入」拋錯（1=checkpoint、2=最終統計、3=catch 補寫）
 *   之所以只數帶 status 的，是為了不受前面受眾快照等其他 update 影響
 */
function makeDb(opts: { failCommit?: boolean; failStatusWriteNth?: number[] } = {}) {
  const updates: Patch[] = []
  const deliveries: Patch[] = []
  let statusWrites = 0

  const ref = {
    update: vi.fn(async (patch: Patch) => {
      if ('status' in patch) {
        statusWrites++
        if (opts.failStatusWriteNth?.includes(statusWrites)) throw new Error('update-boom')
      }
      updates.push(patch)
    }),
    collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: 'delivery' })) })),
  }

  const db = {
    collection: vi.fn(() => ({ doc: vi.fn(() => ref) })),
    batch: vi.fn(() => ({
      set: vi.fn((_r: unknown, doc: Patch) => { deliveries.push(doc) }),
      commit: vi.fn(async () => {
        if (opts.failCommit) throw new Error('commit-boom')
      }),
    })),
  }

  mockGetDb.mockReturnValue(db as any)
  return { updates, deliveries, ref }
}

/** audienceSource=import：受眾直接來自陣列，不必假造 users 查詢 */
function claimReturns(userIds: string[]) {
  mockClaim.mockResolvedValue({
    workspaceId: 'w1',
    status: 'processing',
    messages: [{ type: 'text', text: 'hi' }],
    audienceSource: { type: 'import', importedUserIds: userIds },
  } as any)
}

/** 送出後的第一筆結果寫入（checkpoint）；狀態與人數在此就該定局 */
const checkpointPatch = (updates: Patch[]) => updates.find(u => 'status' in u)
/** 最後一筆結果寫入——報表最終看到的值 */
const lastStatusPatch = (updates: Patch[]) => [...updates].reverse().find(u => 'status' in u)

beforeEach(() => {
  mockGetDb.mockReset()
  mockMulticast.mockReset()
  mockClaim.mockReset()
  // ⛔ 模組渲染也要重設：上一條的回傳值留著的話，下一條會在「沒選模組」的情境下拿到內容
  vi.mocked(renderModuleToLineMessages).mockReset()
})

describe('executeBroadcastSend — 送出後記帳失敗不可謊報失敗', () => {
  it('全員送達 → 一筆 deliveries 都不寫（消掉大量推播最容易逾時的一步）', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 3, failedIds: [], lineAggregationApplied: true })
    // commit 只要被呼叫就會炸；沒炸即證明完全沒進批次寫入
    const { deliveries } = makeDb({ failCommit: true })

    const res = await executeBroadcastSend('bc1')
    expect(res).toMatchObject({ success: true, sentCount: 3, failedCount: 0 })
    expect(res.postSendError).toBeNull()
    expect(deliveries).toEqual([])
  })

  it('只把沒收到的人寫進 deliveries，成功者不逐筆記錄', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 2, failedIds: ['U2'], lineAggregationApplied: true })
    const { deliveries } = makeDb()

    await executeBroadcastSend('bc1')

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      userId: 'w1_U2',
      deliveryStatus: 'failed',
      sentAt: null,
    })
  })

  it('失敗名單寫入掛掉：訊息已送出 → 狀態仍是 completed，成功數照實寫', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 2, failedIds: ['U2'], lineAggregationApplied: true })
    const { updates } = makeDb({ failCommit: true })

    // 名單寫失敗不該讓整個發送流程視為失敗
    const res = await executeBroadcastSend('bc1')
    expect(res).toMatchObject({ success: true, sentCount: 2, failedCount: 1 })
    // 誠實揭露名單不全，而不是靜靜當作一切正常
    expect(res.postSendError).toContain('沒收到的名單未寫完')

    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('completed')
    expect(final.sentCount).toBe(2)
    expect(final.failedCount).toBe(1)
    expect(final.postSendError).toContain('沒收到的名單未寫完')
  })

  it('最終統計寫入掛掉：catch 仍把狀態寫成 completed，且不對外報發送失敗', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 3, failedIds: [], lineAggregationApplied: true })
    // checkpoint 成功、最終統計掛掉、catch 補寫成功
    const { updates } = makeDb({ failStatusWriteNth: [2] })

    // 訊息已送出，呼叫端不可收到錯誤——否則畫面會顯示「發送失敗」而被重發
    const res = await executeBroadcastSend('bc1')
    expect(res).toMatchObject({ success: true, sentCount: 3, failedCount: 0 })
    expect(res.postSendError).toContain('訊息已送出')

    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('completed')
    expect(final.sentCount).toBe(3)
    expect(final.postSendError).toContain('訊息已送出')
  })

  it('送出後每一次寫入都掛掉：checkpoint 已先把狀態與人數寫死，不會卡在 processing', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 3, failedIds: [], lineAggregationApplied: true })
    // checkpoint 之後的兩次結果寫入都掛掉
    const { updates } = makeDb({ failStatusWriteNth: [2, 3] })

    const res = await executeBroadcastSend('bc1')
    expect(res.sentCount).toBe(3)

    // checkpoint 必須自帶 status，否則後續全失敗時會永遠停在 processing、無法編輯或重發
    const checkpoint = checkpointPatch(updates)!
    expect(checkpoint.status).toBe('completed')
    expect(checkpoint.sentCount).toBe(3)
    expect(checkpoint.failedCount).toBe(0)
    expect(checkpoint.lineInsightAggregationApplied).toBe(true)
  })

  it('LINE 真的全數退回 → 才是 failed', async () => {
    claimReturns(['w1_U1', 'w1_U2'])
    mockMulticast.mockResolvedValue({
      successCount: 0,
      failedIds: ['U1', 'U2'],
      lineAggregationApplied: true,
    })
    const { updates } = makeDb()

    const res = await executeBroadcastSend('bc1')
    expect(res.sentCount).toBe(0)

    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('failed')
    expect(final.failedCount).toBe(2)
    expect(final.postSendError).toBeNull()
    // 每一條寫 failed 的路徑都要留下人看得懂的原因（小幫手警示承諾了「進去看失敗原因」）
    expect(final.failureReason).toBe(BROADCAST_ALL_RECIPIENTS_FAILED)
  })

  it('成功時把 failureReason 清成 null（不留上一輪嘗試的舊原因）', async () => {
    claimReturns(['w1_U1'])
    mockMulticast.mockResolvedValue({ successCount: 1, failedIds: [], lineAggregationApplied: true })
    const { updates } = makeDb()

    await executeBroadcastSend('bc1')

    expect(lastStatusPatch(updates)!.failureReason).toBeNull()
  })

  it('名單有無效收件人被濾掉、其餘全退回 → 仍要判成 failed（不可寫成已完成）', async () => {
    // 空字串轉不出 LINE userId 會被濾掉：resolvedUserIds=3 但實際只送 2 人
    claimReturns(['w1_U1', 'w1_', 'w1_U2'])
    mockMulticast.mockResolvedValue({
      successCount: 0,
      failedIds: ['U1', 'U2'],
      lineAggregationApplied: true,
    })
    const { updates } = makeDb()

    await executeBroadcastSend('bc1')

    // 用 resolvedUserIds(3) 當母體比 failedIds(2) 會判成 completed，報表就會出現「已完成／成功 0」
    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('failed')
    expect(final.sentCount).toBe(0)
  })

  it('還沒送出就失敗（受眾為空）→ 維持 failed，且不寫成功數', async () => {
    claimReturns([])
    const { updates } = makeDb()

    await expect(executeBroadcastSend('bc1')).rejects.toThrow('Resolved audience is empty')
    expect(mockMulticast).not.toHaveBeenCalled()

    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('failed')
    expect(final).not.toHaveProperty('sentCount')
    // 內部英文錯誤不可直接端到畫面上；要換成看得懂的一句，並講明沒有人收到
    expect(final.failureReason).toContain('0 人')
    expect(final.failureReason).not.toContain('Resolved audience is empty')
  })

  it('重發過的推播換一個 LINE 彙總單位（開封／點擊不可跟上一次疊在一起）', async () => {
    claimReturns(['w1_U1'])
    mockClaim.mockResolvedValue({
      workspaceId: 'w1',
      status: 'processing',
      retryCount: 1,
      messages: [{ type: 'text', text: 'hi' }],
      audienceSource: { type: 'import', importedUserIds: ['w1_U1'] },
    } as any)
    mockMulticast.mockResolvedValue({ successCount: 1, failedIds: [], lineAggregationApplied: true })
    makeDb()

    await executeBroadcastSend('bc1')

    const unitUsed = mockMulticast.mock.calls[0]![3]!.customAggregationUnits![0]
    expect(unitUsed).toBe(broadcastAggregationUnit('bc1', 2))
    expect(unitUsed).not.toBe(broadcastAggregationUnit('bc1'))
  })

  it('LINE 未套用彙總單位時不寫 unit，報表才知道查不到開封數', async () => {
    claimReturns(['w1_U1'])
    mockMulticast.mockResolvedValue({ successCount: 1, failedIds: [], lineAggregationApplied: false })
    const { updates } = makeDb()

    await executeBroadcastSend('bc1')

    const final = lastStatusPatch(updates)!
    expect(final.lineAggregationUnit).toBeNull()
    expect(final.lineInsightAggregationApplied).toBe(false)
  })
})

/**
 * `C-245`／`C-246`：**送出去的到底是哪一份**。
 *
 * 這一組是整件事的地基：推播存的那張「觸發模組」卡片，送出前會被整張換成模組自己的訊息，
 * 而後台的預覽在 2026-09-24 之前畫的是那張**沒人收到過的卡**。這裡釘住兩件事：
 *   ① 換掉這件事真的會發生（拿掉替換 → 這組要當場紅）
 *   ② 換完的那一份要存進推播紀錄，否則「我那天發了什麼」沒有答案
 */
describe('executeBroadcastSend — 模組型推播送的是模組的內容，而且要留存', () => {
  /** 模組型推播存的就是這張卡（`unifiedActionToLineMessages` 產的形狀） */
  const moduleCard = [{
    type: 'template',
    altText: '有一則訊息',
    template: {
      type: 'buttons',
      text: '點下面的按鈕看看',
      actions: [{ type: 'postback', label: '開始', data: 'triggerModule=mod_abc' }],
    },
  }]

  function claimModuleBroadcast() {
    mockClaim.mockResolvedValue({
      workspaceId: 'w1',
      status: 'processing',
      messages: moduleCard,
      audienceSource: { type: 'import', importedUserIds: ['w1_U1'] },
    } as any)
  }

  it('⭐ 客人收到的是模組裡那幾則，那張卡一個字都不會送出去', async () => {
    claimModuleBroadcast()
    vi.mocked(renderModuleToLineMessages).mockResolvedValue({
      flow: { name: '乾淨方MAX＿超早鳥倒數' },
      lineMessages: [{ type: 'imagemap' }, { type: 'text', text: '倒數最後 3 天' }],
      hydratedMessages: [{ type: 'richMessageRef', richMessageId: 'r1', payload: { heroImageUrl: 'https://x/y.png' } }, { type: 'text', text: '倒數最後 3 天' }],
    } as any)
    mockMulticast.mockResolvedValue({ successCount: 1, failedIds: [], lineAggregationApplied: true })
    makeDb()

    await executeBroadcastSend('bc1')

    const sent = mockMulticast.mock.calls[0]![1] as any[]
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ type: 'imagemap' })
    // ⛔ 這一條是重點：那張卡不可以出現在送出去的東西裡
    expect(JSON.stringify(sent)).not.toContain('點下面的按鈕看看')
    expect(JSON.stringify(sent)).not.toContain('triggerModule')
  })

  it('⭐ 送出當下把「真的送出去的那一份」存進推播紀錄（編輯器格式，圖文訊息連內容一起）', async () => {
    claimModuleBroadcast()
    vi.mocked(renderModuleToLineMessages).mockResolvedValue({
      flow: { name: '乾淨方MAX＿超早鳥倒數' },
      lineMessages: [{ type: 'imagemap' }, { type: 'text', text: '倒數最後 3 天' }],
      hydratedMessages: [
        { type: 'richMessageRef', richMessageId: 'r1', payload: { heroImageUrl: 'https://x/y.png', heroImageWidth: undefined } },
        { type: 'text', text: '倒數最後 3 天' },
      ],
    } as any)
    mockMulticast.mockResolvedValue({ successCount: 1, failedIds: [], lineAggregationApplied: true })
    const { updates } = makeDb()

    await executeBroadcastSend('bc1')

    const snapshotPatch = updates.find(u => 'sentContent' in u)!
    expect(snapshotPatch).toBeDefined()
    expect(snapshotPatch.sentContent).toMatchObject({
      kind: 'module',
      moduleId: 'mod_abc',
      moduleName: '乾淨方MAX＿超早鳥倒數',
      lineMessageCount: 2,
    })
    // ⛔ `undefined` 要被清掉：firebase-admin 沒開 ignoreUndefinedProperties，帶著它整筆寫入會炸
    expect(JSON.stringify(snapshotPatch.sentContent)).not.toContain('undefined')
    expect(snapshotPatch.sentContent.messages[0]).toMatchObject({
      type: 'richMessageRef',
      payload: { heroImageUrl: 'https://x/y.png' },
    })
  })

  it('模組查不到／是空的 → 在送出之前就失敗，一則都不會送', async () => {
    claimModuleBroadcast()
    vi.mocked(renderModuleToLineMessages).mockResolvedValue(null as any)
    makeDb()

    await expect(executeBroadcastSend('bc1')).rejects.toThrow()
    expect(mockMulticast).not.toHaveBeenCalled()
  })

  it('⛔ 純文字推播不走這條路：照原樣送，也不寫留存（`messages` 本身就是送出去的那一份）', async () => {
    claimReturns(['w1_U1'])
    mockMulticast.mockResolvedValue({ successCount: 1, failedIds: [], lineAggregationApplied: true })
    const { updates } = makeDb()

    await executeBroadcastSend('bc1')

    expect(renderModuleToLineMessages).not.toHaveBeenCalled()
    expect(mockMulticast.mock.calls[0]![1]).toEqual([{ type: 'text', text: 'hi' }])
    expect(updates.find(u => 'sentContent' in u)).toBeUndefined()
  })
})
