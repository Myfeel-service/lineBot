import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-import：只需要 clickTrackingBaseUrl
vi.stubGlobal('useRuntimeConfig', () => ({ clickTrackingBaseUrl: '' }))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__delete__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({ multicastMessage: vi.fn(), pushMessagesPerRecipient: vi.fn() }))
vi.mock('./broadcast-claim', () => ({ claimBroadcastForSend: vi.fn() }))
vi.mock('./audience', () => ({ resolveAudienceUserIds: vi.fn() }))
vi.mock('./handler', () => ({ renderModuleToLineMessages: vi.fn() }))
vi.mock('./broadcast-click-track', () => ({
  wrapBroadcastMessagesForClickTracking: vi.fn((m: unknown) => m),
}))

import { broadcastRetryKey, executeBroadcastSend } from './broadcast-send'
import { renderModuleToLineMessages } from './handler'
import { getDb } from './firebase'
import { multicastMessage, pushMessagesPerRecipient } from './line'
import { claimBroadcastForSend } from './broadcast-claim'
import { BROADCAST_ALL_RECIPIENTS_FAILED } from '~~/shared/broadcast-failure'
import { broadcastAggregationUnit } from '~~/shared/broadcast-insight'

const mockGetDb = vi.mocked(getDb)
const mockMulticast = vi.mocked(multicastMessage)
const mockPush = vi.mocked(pushMessagesPerRecipient)
const mockClaim = vi.mocked(claimBroadcastForSend)

type Patch = Record<string, any>

/**
 * 假 Firestore：
 * - failCommit：batch.commit() 拋錯（真實事故就是這裡逾時，而資料其實已落地）
 * - failStatusWriteNth：讓第 N 次「帶 status 的寫入」拋錯（1=checkpoint、2=最終統計、3=catch 補寫）
 *   之所以只數帶 status 的，是為了不受前面受眾快照等其他 update 影響
 */
function makeDb(opts: {
  failCommit?: boolean
  failStatusWriteNth?: number[]
  /** 一人一則送時讀的客人資料（`users/{docId}`），沒列到的＝讀不到 */
  users?: Record<string, Record<string, unknown>>
} = {}) {
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
    collection: vi.fn((name: string) => ({
      doc: vi.fn((docId?: string) => (name === 'users' ? { __user: true, id: docId } : ref)),
    })),
    getAll: vi.fn(async (...args: any[]) => args
      .filter(a => a?.__user)
      .map(r => ({ id: r.id, exists: Boolean(opts.users?.[r.id]), data: () => opts.users?.[r.id] }))),
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
  mockPush.mockReset()
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
    // 呼叫端（排程、手動發送）寫操作紀錄要看這一格，⛔ 只看 success 會寫成「送出了」
    expect(res.allFailed).toBe(true)

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

  it('`D-121`：發完時排上「第 1 天去問 LINE 人數」（排程只讀時間到了的那幾則）；一個人都沒送到的不排', async () => {
    claimReturns(['w1_U1', 'w1_U2'])
    mockMulticast.mockResolvedValue({ successCount: 2, failedIds: [], lineAggregationApplied: true })
    const { updates } = makeDb()
    const before = Date.now()
    await executeBroadcastSend('bc1')
    // checkpoint 與最終統計都要帶：checkpoint 之後的寫入掛掉時，排程照樣找得到它
    for (const p of [checkpointPatch(updates)!, lastStatusPatch(updates)!]) {
      expect(p.lineStatsNextAt).toBeGreaterThanOrEqual(before + 86_400_000)
      expect(p.lineStatsNextAt).toBeLessThanOrEqual(Date.now() + 86_400_000)
    }

    claimReturns(['w1_U1', 'w1_U2'])
    mockMulticast.mockResolvedValue({ successCount: 0, failedIds: ['U1', 'U2'], lineAggregationApplied: true })
    const failedRun = makeDb()
    await executeBroadcastSend('bc1')
    expect(lastStatusPatch(failedRun.updates)!.lineStatsNextAt).toBe('__delete__')
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

/**
 * `D-118` A（2026-10-15 老闆「要看得到名字」）：**用了 {{變數}} 的推播一人一則送**，每一位換上自己的名字。
 *
 * 以前一律群發、名字一律是空白：9/29 起 MYFEEL 7 則上市／倒數推播、約 8,500 人次收到開頭空一格的句子。
 * 這一組釘住：①有變數才一人一則、沒有照舊群發 ②每一位拿到的是**他自己的**名字（名字是 LINE 代號的不算）
 * ③重送編號固定（送到一半斷掉→重設→再送時 LINE 才擋得住已經收過的人）④呼叫 LINE 之前就記下 sendMode。
 */
describe('executeBroadcastSend — 用了客人名字的推播一人一則送', () => {
  const UID_LIKE = 'U4af4980629b8c1d2e3f4a5b6c7d8e9f0'

  function claimText(text: string, userIds: string[], extra: Record<string, unknown> = {}) {
    mockClaim.mockResolvedValue({
      workspaceId: 'w1',
      status: 'processing',
      messages: [{ type: 'text', text }],
      audienceSource: { type: 'import', importedUserIds: userIds },
      ...extra,
    } as any)
  }

  /** 假 LINE：照實呼叫 buildMessages（送到那一位才組），記下每一位收到什麼 */
  function pushRecords(result: Partial<Awaited<ReturnType<typeof pushMessagesPerRecipient>>> = {}) {
    const received = new Map<string, any[]>()
    const keys = new Map<string, string>()
    mockPush.mockImplementation(async (recipients, build) => {
      for (const r of recipients) {
        received.set(r.lineUserId, build(r.lineUserId))
        keys.set(r.lineUserId, r.retryKey)
      }
      return {
        successCount: recipients.length,
        alreadySentCount: 0,
        failedIds: [],
        failureReasons: {},
        lineAggregationApplied: true,
        stoppedReason: null,
        ...result,
      }
    })
    return { received, keys }
  }

  it('⭐ 每一位收到自己的名字；讀不到資料、名字是 LINE 代號的那一格留空', async () => {
    claimText('{{displayName}} 快快快！今晚結束', ['w1_U1', 'w1_U2', 'w1_U3'])
    makeDb({
      users: {
        w1_U1: { displayName: '王小明', lineUserId: 'U1' },
        w1_U2: { displayName: UID_LIKE, lineUserId: UID_LIKE },
      },
    })
    const { received } = pushRecords()

    const res = await executeBroadcastSend('bc1')

    expect(mockMulticast).not.toHaveBeenCalled()
    expect(received.get('U1')![0].text).toBe('王小明 快快快！今晚結束')
    expect(received.get('U2')![0].text).toBe(' 快快快！今晚結束')
    expect(received.get('U3')![0].text).toBe(' 快快快！今晚結束')
    expect(res).toMatchObject({ success: true, sentCount: 3, failedCount: 0 })
  })

  it('⛔ 沒用變數的推播照舊群發（一人一則送不會多得到任何東西，只會更慢）', async () => {
    claimText('今天公休', ['w1_U1', 'w1_U2'])
    mockMulticast.mockResolvedValue({ successCount: 2, failedIds: [], lineAggregationApplied: true })
    const { updates } = makeDb()

    await executeBroadcastSend('bc1')

    expect(mockPush).not.toHaveBeenCalled()
    expect(mockMulticast).toHaveBeenCalledTimes(1)
    expect(updates.find(u => 'sendMode' in u)!.sendMode).toBe('multicast')
  })

  it('⭐ 呼叫 LINE 之前就記下 sendMode（送到一半斷掉時，看門狗與回頭看的預覽都靠它）', async () => {
    claimText('嗨 {{displayName}}', ['w1_U1'])
    const { updates } = makeDb({ users: { w1_U1: { displayName: '吉米' } } })
    let writtenBeforeLine = false
    mockPush.mockImplementation(async (recipients) => {
      writtenBeforeLine = updates.some(u => u.sendMode === 'perRecipient')
      return { successCount: recipients.length, alreadySentCount: 0, failedIds: [], failureReasons: {}, lineAggregationApplied: true, stoppedReason: null }
    })

    await executeBroadcastSend('bc1')

    expect(writtenBeforeLine).toBe(true)
  })

  it('⭐ 重送編號＝這則推播＋這位客人，固定不變、不含重發次數（重設再送才擋得住收過的人）', async () => {
    claimText('嗨 {{displayName}}', ['w1_U1', 'w1_U2'], { retryCount: 1 })
    makeDb()
    const { keys } = pushRecords()

    await executeBroadcastSend('bc1')

    expect(keys.get('U1')).toBe(broadcastRetryKey('bc1', 'U1'))
    expect(keys.get('U2')).toBe(broadcastRetryKey('bc1', 'U2'))
    expect(keys.get('U1')).not.toBe(keys.get('U2'))
    expect(broadcastRetryKey('bc1', 'U1')).not.toBe(broadcastRetryKey('bc2', 'U1'))
    // LINE 要的是十六進位 UUID
    expect(keys.get('U1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // 彙總單位照舊跟著重發次數換（開封／點擊不跟上一次疊在一起）
    expect(mockPush.mock.calls[0]![3]).toEqual({ customAggregationUnits: [broadcastAggregationUnit('bc1', 2)] })
  })

  it('模組型：模組只抓一次，每一位用自己的名字重組', async () => {
    mockClaim.mockResolvedValue({
      workspaceId: 'w1',
      status: 'processing',
      messages: [{ type: 'template', altText: 'x', template: { type: 'buttons', text: '點下面', actions: [{ type: 'postback', label: '開始', data: 'triggerModule=mod_abc' }] } }],
      audienceSource: { type: 'import', importedUserIds: ['w1_U1', 'w1_U2'] },
    } as any)
    vi.mocked(renderModuleToLineMessages).mockResolvedValue({
      flow: { name: '乾淨方MAX推播' },
      lineMessages: [{ type: 'text', text: ' 倒數' }],
      hydratedMessages: [{ type: 'text', text: '{{displayName}} 倒數' }],
      renderFor: (attrs: Record<string, string>) => [{ type: 'text', text: `${attrs.displayName ?? ''} 倒數` }],
    } as any)
    makeDb({ users: { w1_U1: { displayName: '王小明' }, w1_U2: { displayName: '陳小華' } } })
    const { received } = pushRecords()

    await executeBroadcastSend('bc1')

    expect(renderModuleToLineMessages).toHaveBeenCalledTimes(1)
    expect(received.get('U1')![0].text).toBe('王小明 倒數')
    expect(received.get('U2')![0].text).toBe('陳小華 倒數')
  })

  /**
   * `C-322`：模組裡有開了貼標的網址按鈕時，就算沒用名字也要一人一則——貼標連結每個人一條，
   * 群發只能放大家共用的那一條（以前推播裡這種按鈕開關是開的、標籤就是沒貼，`C-238`）。
   */
  it('⭐ 模組裡有開了貼標的網址按鈕（沒用名字）也一人一則，每一位帶自己的 LINE id 去組', async () => {
    mockClaim.mockResolvedValue({
      workspaceId: 'w1',
      status: 'processing',
      messages: [{ type: 'template', altText: 'x', template: { type: 'buttons', text: '點下面', actions: [{ type: 'postback', label: '開始', data: 'triggerModule=mod_tag' }] } }],
      audienceSource: { type: 'import', importedUserIds: ['w1_U1', 'w1_U2'] },
    } as any)
    const renderFor = vi.fn((_attrs: Record<string, string>, uid?: string) => [{ type: 'text', text: `貼標連結給 ${uid ?? '（沒有人）'}` }])
    vi.mocked(renderModuleToLineMessages).mockResolvedValue({
      flow: { name: '新品試用報名' },
      lineMessages: [{ type: 'text', text: '貼標連結給 （沒有人）' }],
      hydratedMessages: [{ type: 'text', text: '報名看這裡', buttons: [{ type: 'uri', uri: 'https://form.example.com', tagging: { enabled: true, addTagIds: ['t-interested'] } }] }],
      renderFor,
    } as any)
    const { updates } = makeDb()
    const { received } = pushRecords()

    await executeBroadcastSend('bc1')

    expect(mockMulticast).not.toHaveBeenCalled()
    expect(updates.find(u => 'sendMode' in u)!.sendMode).toBe('perRecipient')
    expect(received.get('U1')![0].text).toBe('貼標連結給 U1')
    expect(received.get('U2')![0].text).toBe('貼標連結給 U2')
  })

  it('⛔ 模組裡只有「沒開貼標」的網址按鈕、也沒用名字 → 照舊群發', async () => {
    mockClaim.mockResolvedValue({
      workspaceId: 'w1',
      status: 'processing',
      messages: [{ type: 'template', altText: 'x', template: { type: 'buttons', text: '點下面', actions: [{ type: 'postback', label: '開始', data: 'triggerModule=mod_plain' }] } }],
      audienceSource: { type: 'import', importedUserIds: ['w1_U1'] },
    } as any)
    vi.mocked(renderModuleToLineMessages).mockResolvedValue({
      flow: { name: '一般' },
      lineMessages: [{ type: 'text', text: '看這裡' }],
      hydratedMessages: [{ type: 'text', text: '看這裡', buttons: [{ type: 'uri', uri: 'https://a.example.com', tagging: { enabled: false, addTagIds: ['t1'] } }] }],
      renderFor: vi.fn(),
    } as any)
    mockMulticast.mockResolvedValue({ successCount: 1, failedIds: [], lineAggregationApplied: true })
    makeDb()

    await executeBroadcastSend('bc1')

    expect(mockPush).not.toHaveBeenCalled()
    expect(mockMulticast).toHaveBeenCalledTimes(1)
  })

  it('一人一則拿得到每一位沒送到的原因，寫進沒收到的名單；上一輪已收到的算送達', async () => {
    claimText('嗨 {{displayName}}', ['w1_U1', 'w1_U2', 'w1_U3'])
    const { deliveries } = makeDb()
    pushRecords({ successCount: 2, alreadySentCount: 1, failedIds: ['U2'], failureReasons: { U2: 'LINE push failed (400): blocked' } })

    const res = await executeBroadcastSend('bc1')

    expect(res).toMatchObject({ sentCount: 2, failedCount: 1 })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ userId: 'w1_U2', failureReason: 'LINE push failed (400): blocked' })
  })

  it('本月額度用完、一位都沒送到 → 失敗原因講額度，⛔ 不說成「多半是封鎖了」', async () => {
    claimText('嗨 {{displayName}}', ['w1_U1', 'w1_U2'])
    const { updates } = makeDb()
    const quota = '本月推播則數已用完（LINE 官方帳號方案的額度），要等下個月重算或升級方案才能再送。'
    pushRecords({ successCount: 0, failedIds: ['U1', 'U2'], failureReasons: { U1: quota, U2: quota }, stoppedReason: quota })

    await executeBroadcastSend('bc1')

    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('failed')
    expect(final.failureReason).toBe(quota)
  })
})
