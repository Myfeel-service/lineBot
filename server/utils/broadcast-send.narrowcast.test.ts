/**
 * 發送主線怎麼選送法（`D-154`②③）：大家同一份內容、50 人以上 → narrowcast（之後才能補發）；
 * 其他照舊。narrowcast 交不出名單＝什麼都還沒送 → 當場改用群發。
 * 「名單好了才送、送完收結果」那半在 broadcast-narrowcast.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('./broadcast-click-track', () => ({ wrapBroadcastMessagesForClickTracking: vi.fn((m: unknown) => m) }))
vi.mock('./broadcast-plan-gate', () => ({ workspaceBroadcastTier: vi.fn(async () => null) }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn(async () => ({ added: [] })) }))
vi.mock('./broadcast-narrowcast', () => ({
  narrowcastDisabled: vi.fn(() => false),
  startNarrowcast: vi.fn(),
  startFollowUpNarrowcast: vi.fn(),
}))

import { executeBroadcastSend } from './broadcast-send'
import { getDb } from './firebase'
import { multicastMessage, pushMessagesPerRecipient } from './line'
import { claimBroadcastForSend } from './broadcast-claim'
import { narrowcastDisabled, startFollowUpNarrowcast, startNarrowcast } from './broadcast-narrowcast'
import { FOLLOW_UP_PERSONALIZED_ERROR, NARROWCAST_MIN_RECIPIENTS } from '~~/shared/broadcast-follow-up'

type Patch = Record<string, any>

function makeDb() {
  const updates: Patch[] = []
  const ref = {
    update: vi.fn(async (patch: Patch) => { updates.push(patch) }),
    collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: 'delivery' })) })),
  }
  const db = {
    collection: vi.fn(() => ({ doc: vi.fn(() => ref) })),
    getAll: vi.fn(async () => []),
    batch: vi.fn(() => ({ set: vi.fn(), commit: vi.fn(async () => {}) })),
  }
  vi.mocked(getDb).mockReturnValue(db as any)
  return { updates }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `w1_U${String(i).padStart(32, '0')}`)

function claim(over: Record<string, unknown> = {}) {
  vi.mocked(claimBroadcastForSend).mockResolvedValue({
    workspaceId: 'w1',
    name: '小滑手_開賣',
    status: 'processing',
    messages: [{ type: 'text', text: '開賣了' }],
    audienceSource: { type: 'import', importedUserIds: ids(NARROWCAST_MIN_RECIPIENTS) },
    ...over,
  } as any)
}

const snapshotPatch = (updates: Patch[]) => updates.find(u => 'sendMode' in u && 'audienceSnapshot.resolvedUserIds' in u)

beforeEach(() => {
  vi.mocked(multicastMessage).mockReset().mockResolvedValue({ successCount: 50, failedIds: [], lineAggregationApplied: true })
  vi.mocked(pushMessagesPerRecipient).mockReset()
  vi.mocked(startNarrowcast).mockReset().mockResolvedValue({ ok: true, estimate: 50 })
  vi.mocked(startFollowUpNarrowcast).mockReset().mockResolvedValue({ ok: true, estimate: 1699 })
  vi.mocked(narrowcastDisabled).mockReset().mockReturnValue(false)
})

describe('executeBroadcastSend — 要不要用 narrowcast 送（`D-154`②③）', () => {
  it('大家同一份內容、50 人以上 → 只交出名單、回「還在送」，⛔ 不群發', async () => {
    claim()
    const { updates } = makeDb()
    const res = await executeBroadcastSend('bc1')

    expect(res).toMatchObject({ pending: true, sentCount: 0, totalCount: 50, allFailed: false })
    expect(startNarrowcast).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startNarrowcast).mock.calls[0]![0].lineUserIds).toHaveLength(50)
    expect(multicastMessage).not.toHaveBeenCalled()
    // 送法寫在呼叫 LINE 之前（看門狗與 narrowcast 往前推都靠它）；上一輪的 narrowcast 進度清掉
    expect(snapshotPatch(updates)).toMatchObject({ sendMode: 'narrowcast', narrowcast: '__delete__', lineRequestId: null, narrowcastFallback: null })
    // 還沒送出去：⛔ 不可以寫成 completed
    expect(updates.some(u => u.status === 'completed')).toBe(false)
  })

  it('名單交不出去（還沒送任何東西）→ 當場改用群發，記下原因給報表講', async () => {
    claim()
    vi.mocked(startNarrowcast).mockResolvedValue({ ok: false, reason: 'LINE 名單建不起來：403 x' })
    const { updates } = makeDb()
    const res = await executeBroadcastSend('bc1')

    expect(res.pending).toBeUndefined()
    expect(multicastMessage).toHaveBeenCalledTimes(1)
    expect(updates).toContainEqual(expect.objectContaining({ sendMode: 'multicast', narrowcastFallback: 'LINE 名單建不起來：403 x' }))
    expect(updates.find(u => u.status)).toMatchObject({ status: 'completed', sentCount: 50 })
  })

  it.each([
    ['不到 50 人', () => claim({ audienceSource: { type: 'import', importedUserIds: ids(NARROWCAST_MIN_RECIPIENTS - 1) } }), `發給不到 ${NARROWCAST_MIN_RECIPIENTS} 人`],
    ['有設發完貼記號', () => claim({ completionTagIds: ['t1'] }), '有設定「發完貼記號」，要知道每一位有沒有收到'],
    ['總開關關掉', () => { claim(); vi.mocked(narrowcastDisabled).mockReturnValue(true) }, '系統暫時改用一般方式送'],
  ])('%s → 照舊群發，原因寫在推播上', async (_label, setup, reason) => {
    setup()
    const { updates } = makeDb()
    await executeBroadcastSend('bc1')
    expect(startNarrowcast).not.toHaveBeenCalled()
    expect(multicastMessage).toHaveBeenCalledTimes(1)
    expect(snapshotPatch(updates)).toMatchObject({ sendMode: 'multicast', narrowcastFallback: reason })
  })

  it('放了客人名字 → 一人一則（名字優先），不走 narrowcast、也不記「改用群發」的原因', async () => {
    claim({ messages: [{ type: 'text', text: '{{displayName}} 開賣了' }] })
    vi.mocked(pushMessagesPerRecipient).mockResolvedValue({ successCount: 50, failedIds: [], lineAggregationApplied: true, failureReasons: {}, stoppedReason: null, alreadySentCount: 0 } as any)
    const { updates } = makeDb()
    await executeBroadcastSend('bc1')
    expect(startNarrowcast).not.toHaveBeenCalled()
    expect(snapshotPatch(updates)).toMatchObject({ sendMode: 'perRecipient', narrowcastFallback: null })
  })
})

describe('executeBroadcastSend — 補發（`D-154`②③）', () => {
  const followUp = { type: 'followUp', sourceBroadcastId: 'src1', followUpTarget: 'unopened', sourceName: '小滑手_開賣' }

  it('不算名單（是誰只有 LINE 知道）→ 交給 LINE 圈名單、回「還在送」，人數用建草稿時估的', async () => {
    claim({ audienceSource: followUp, audienceSnapshot: { estimatedCount: 1699 } })
    const { updates } = makeDb()
    const res = await executeBroadcastSend('bc2')

    expect(res).toMatchObject({ pending: true, totalCount: 1699 })
    expect(startFollowUpNarrowcast).toHaveBeenCalledTimes(1)
    expect(startNarrowcast).not.toHaveBeenCalled()
    // ⛔ 估的人數不可以被蓋成 0
    expect(snapshotPatch(updates)).not.toHaveProperty('audienceSnapshot.estimatedCount')
  })

  it('⛔ 補發放了客人名字 → 不送、標失敗，原因講清楚', async () => {
    claim({ audienceSource: followUp, messages: [{ type: 'text', text: '{{displayName}} 你還沒看' }] })
    const { updates } = makeDb()
    await expect(executeBroadcastSend('bc2')).rejects.toThrow(FOLLOW_UP_PERSONALIZED_ERROR)
    expect(startFollowUpNarrowcast).not.toHaveBeenCalled()
    expect(updates.find(u => u.status === 'failed')!.failureReason).toBe(`${FOLLOW_UP_PERSONALIZED_ERROR}這則沒有送出任何訊息。`)
  })

  it('LINE 圈不出名單 → ⛔ 沒有群發的退路，標失敗、講原因與「可以重設再發」', async () => {
    claim({ audienceSource: followUp })
    vi.mocked(startFollowUpNarrowcast).mockResolvedValue({ ok: false, reason: '原本那則發完超過 60 天，LINE 不再提供名單' })
    const { updates } = makeDb()
    await expect(executeBroadcastSend('bc2')).rejects.toThrow()
    expect(multicastMessage).not.toHaveBeenCalled()
    expect(updates.find(u => u.status === 'failed')!.failureReason)
      .toBe('補發沒有送出：原本那則發完超過 60 天，LINE 不再提供名單。沒有送出任何訊息，處理好之後可以按「重設為草稿」再發一次。')
  })
})
