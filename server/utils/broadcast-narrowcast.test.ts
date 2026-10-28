/**
 * narrowcast 推播每一輪排程往前推一步（`D-154`②③，broadcast-narrowcast.ts）。
 * 釘的是會變成「客人收兩次」或「客人一則都沒收到卻顯示送完」的那幾個轉折：
 *   - 叫 LINE 前先記 calling、重叫用同一個重送編號（斷在中間不會重複送）
 *   - 不確定 LINE 收了沒 → ⛔ 不自動重送，標「不確定」
 *   - 確定還沒送出去 → 一般推播改用群發、補發標失敗
 *   - 送完才寫結果（人數用 LINE 回報的）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__delete__' },
}))
vi.mock('./line-narrowcast', () => ({
  audienceReadiness: vi.fn(),
  createRetargetAudience: vi.fn(),
  deleteAudience: vi.fn(async () => {}),
  lineErrorText: (e: any) => String(e?.message ?? e),
  narrowcastProgress: vi.fn(),
  sendNarrowcast: vi.fn(),
  uploadAudience: vi.fn(),
}))
vi.mock('./line', () => ({ multicastMessage: vi.fn() }))
vi.mock('./broadcast-outcome', async (orig) => ({
  ...(await orig<typeof import('./broadcast-outcome')>()),
  writeFailedDeliveries: vi.fn(async () => null),
}))

import { HTTPFetchError } from '@line/bot-sdk'
import {
  advanceNarrowcastBroadcasts,
  narrowcastRetryKey,
  startFollowUpNarrowcast,
  startNarrowcast,
} from './broadcast-narrowcast'
import { audienceReadiness, createRetargetAudience, narrowcastProgress, sendNarrowcast, uploadAudience } from './line-narrowcast'
import { multicastMessage } from './line'
import { BROADCAST_STUCK_SAFE_TO_RESEND, BROADCAST_STUCK_UNVERIFIED } from '~~/shared/broadcast-failure'

const MIN = 60_000

/** 套用 Firestore 的 update（支援 'a.b' 這種點路徑） */
function apply(target: Record<string, any>, patch: Record<string, any>) {
  for (const [k, v] of Object.entries(patch)) {
    const parts = k.split('.')
    let o = target
    for (const p of parts.slice(0, -1)) o = (o[p] ??= {})
    if (v === '__delete__') delete o[parts.at(-1)!]
    else o[parts.at(-1)!] = v
  }
}

function makeDb(docs: Record<string, Record<string, any>>) {
  const writes: Array<{ id: string; patch: Record<string, any> }> = []
  const db: any = {}
  const refOf = (id: string) => ({
    id,
    firestore: db,
    get: async () => ({ data: () => structuredClone(docs[id]) }),
    update: async (patch: Record<string, any>) => { writes.push({ id, patch }); apply(docs[id]!, patch) },
  })
  db.collection = () => ({
    doc: (id: string) => refOf(id),
    where: () => ({
      select: () => ({
        limit: () => ({
          get: async () => ({
            docs: Object.entries(docs)
              .filter(([, d]) => d.status === 'processing')
              .map(([id, d]) => ({ id, ref: refOf(id), data: () => structuredClone(d) })),
          }),
        }),
      }),
    }),
  })
  db.runTransaction = async (fn: (tx: any) => Promise<any>) => fn({
    get: async (ref: { id: string }) => ({ data: () => structuredClone(docs[ref.id]) }),
    update: (ref: { id: string }, patch: Record<string, any>) => { writes.push({ id: ref.id, patch }); apply(docs[ref.id]!, patch) },
  })
  return { db, docs, writes }
}

const baseNc = (over: Record<string, any> = {}) => ({
  phase: 'audience',
  waitAudienceGroupIds: [111],
  uploadAudienceGroupId: 111,
  recipientJson: JSON.stringify({ type: 'audience', audienceGroupId: 111 }),
  messagesJson: JSON.stringify([{ type: 'text', text: '開賣了' }]),
  preparedAt: Date.now() - MIN,
  ...over,
})

const bc = (over: Record<string, any> = {}) => ({
  workspaceId: 'w1',
  name: '小滑手_開賣',
  status: 'processing',
  sendMode: 'narrowcast',
  retryCount: 0,
  audienceSource: { type: 'tags', tagIds: ['t1'] },
  audienceSnapshot: { resolvedUserIds: ['w1_U1', 'w1_U2'], estimatedCount: 2 },
  narrowcast: baseNc(),
  ...over,
})

const http = (status: number) => new HTTPFetchError('boom', { status, statusText: 'x', headers: new Headers(), body: 'nope' })

beforeEach(() => {
  vi.mocked(audienceReadiness).mockReset().mockResolvedValue({ readiness: 'ready', detail: 'READY' })
  vi.mocked(sendNarrowcast).mockReset().mockResolvedValue('req-1')
  vi.mocked(narrowcastProgress).mockReset()
  vi.mocked(multicastMessage).mockReset().mockResolvedValue({ successCount: 2, failedIds: [], lineAggregationApplied: true })
  vi.mocked(uploadAudience).mockReset()
  vi.mocked(createRetargetAudience).mockReset()
})

describe('advanceNarrowcastBroadcasts', () => {
  it('名單還沒好 → 什麼都不做（下一輪再看）', async () => {
    vi.mocked(audienceReadiness).mockResolvedValue({ readiness: 'pending', detail: 'IN_PROGRESS' })
    const { db, docs } = makeDb({ b1: bc() })
    const s = await advanceNarrowcastBroadcasts(db)
    expect(s).toMatchObject({ checked: 1, called: 0 })
    expect(sendNarrowcast).not.toHaveBeenCalled()
    expect(docs.b1!.narrowcast.phase).toBe('audience')
  })

  it('名單好了 → 先記 calling 再叫 LINE（固定的重送編號），收下後記 sending＋LINE 編號', async () => {
    const { db, docs, writes } = makeDb({ b1: bc() })
    const s = await advanceNarrowcastBroadcasts(db)
    expect(s.called).toBe(1)
    expect(sendNarrowcast).toHaveBeenCalledWith('w1', [{ type: 'text', text: '開賣了' }], { type: 'audience', audienceGroupId: 111 }, narrowcastRetryKey('b1', 0))
    const callingIdx = writes.findIndex(w => w.patch['narrowcast.phase'] === 'calling')
    const sendingIdx = writes.findIndex(w => w.patch['narrowcast.phase'] === 'sending')
    expect(callingIdx).toBeGreaterThanOrEqual(0)
    expect(sendingIdx).toBeGreaterThan(callingIdx)
    expect(docs.b1).toMatchObject({ status: 'processing', lineRequestId: 'req-1', narrowcast: { phase: 'sending' } })
  })

  it('重送編號：同一則同一輪永遠一樣，重設再發（下一輪）才換', () => {
    expect(narrowcastRetryKey('b1', 0)).toBe(narrowcastRetryKey('b1', 0))
    expect(narrowcastRetryKey('b1', 1)).not.toBe(narrowcastRetryKey('b1', 0))
  })

  it('叫 LINE 時斷線（不確定收了沒）→ 留在 calling，下一輪用同一個編號再叫；⛔ 不改用群發', async () => {
    vi.mocked(sendNarrowcast).mockRejectedValueOnce(http(500)).mockResolvedValueOnce('req-1')
    const { db, docs } = makeDb({ b1: bc() })
    await advanceNarrowcastBroadcasts(db)
    expect(docs.b1!.narrowcast.phase).toBe('calling')
    expect(multicastMessage).not.toHaveBeenCalled()

    await advanceNarrowcastBroadcasts(db)
    expect(vi.mocked(sendNarrowcast).mock.calls[1]![3]).toBe(vi.mocked(sendNarrowcast).mock.calls[0]![3])
    expect(docs.b1).toMatchObject({ lineRequestId: 'req-1', narrowcast: { phase: 'sending' } })
  })

  it('一直不確定（calling 超過 30 分鐘）→ 標失敗講「不確定」，⛔ 不自動重送', async () => {
    vi.mocked(sendNarrowcast).mockRejectedValue(http(503))
    const { db, docs } = makeDb({ b1: bc({ narrowcast: baseNc({ phase: 'calling', callingAt: Date.now() - 31 * MIN }) }) })
    await advanceNarrowcastBroadcasts(db)
    expect(docs.b1).toMatchObject({ status: 'failed', failureReason: BROADCAST_STUCK_UNVERIFIED })
    expect(multicastMessage).not.toHaveBeenCalled()
  })

  it('LINE 明確不收（400）＝什麼都沒送 → 改用群發送出去，記下原因', async () => {
    vi.mocked(sendNarrowcast).mockRejectedValue(http(400))
    const { db, docs } = makeDb({ b1: bc() })
    const s = await advanceNarrowcastBroadcasts(db)
    expect(s.fellBack).toBe(1)
    expect(multicastMessage).toHaveBeenCalledWith(['U1', 'U2'], [{ type: 'text', text: '開賣了' }], 'w1', expect.anything())
    expect(docs.b1).toMatchObject({ status: 'completed', sentCount: 2, sendMode: 'multicast' })
    expect(docs.b1!.narrowcastFallback).toContain('LINE 不收這一則')
  })

  it('名單建失敗、或 30 分鐘還沒好 → 改用群發', async () => {
    vi.mocked(audienceReadiness).mockResolvedValue({ readiness: 'pending', detail: 'IN_PROGRESS' })
    const { db, docs } = makeDb({ b1: bc({ narrowcast: baseNc({ preparedAt: Date.now() - 31 * MIN }) }) })
    await advanceNarrowcastBroadcasts(db)
    expect(docs.b1).toMatchObject({ status: 'completed', sendMode: 'multicast', narrowcastFallback: 'LINE 名單 30 分鐘都沒準備好' })
  })

  it('補發等 LINE 圈名單：30 分鐘還沒好照樣等（上限一整天），⛔ 不要太早放棄——補發放棄＝失敗', async () => {
    vi.mocked(audienceReadiness).mockResolvedValue({ readiness: 'pending', detail: 'IN_PROGRESS' })
    const fu = { audienceSource: { type: 'followUp' }, audienceSnapshot: { resolvedUserIds: [] } }
    const { db, docs } = makeDb({
      waiting: bc({ ...fu, narrowcast: baseNc({ preparedAt: Date.now() - 2 * 60 * MIN }) }),
      tooLong: bc({ ...fu, narrowcast: baseNc({ preparedAt: Date.now() - 25 * 60 * MIN }) }),
    })
    await advanceNarrowcastBroadcasts(db)
    expect(docs.waiting!.status).toBe('processing')
    expect(docs.tooLong!.status).toBe('failed')
    expect(docs.tooLong!.failureReason).toContain('LINE 名單一整天都沒準備好')
  })

  it('LINE 回報送完 → 寫結果（人數用 LINE 的）、排上問打開數，打開數改拿 LINE 編號問', async () => {
    vi.mocked(narrowcastProgress).mockResolvedValue({ phase: 'succeeded', successCount: 48, failureCount: 2, targetCount: 50, errorCode: null, failedDescription: null })
    const { db, docs } = makeDb({ b1: bc({ lineRequestId: 'req-1', narrowcast: baseNc({ phase: 'sending', acceptedAt: Date.now() }) }) })
    const s = await advanceNarrowcastBroadcasts(db)
    expect(s.finished).toBe(1)
    expect(docs.b1).toMatchObject({
      status: 'completed', sentCount: 48, failedCount: 2, totalCount: 50,
      lineAggregationUnit: null, lineInsightAggregationApplied: true, narrowcast: { phase: 'done' },
    })
    expect(typeof docs.b1!.lineStatsNextAt).toBe('number')
  })

  it('LINE 還在送 → 不動', async () => {
    vi.mocked(narrowcastProgress).mockResolvedValue({ phase: 'sending', successCount: null, failureCount: null, targetCount: null, errorCode: null, failedDescription: null })
    const { db, docs } = makeDb({ b1: bc({ lineRequestId: 'req-1', narrowcast: baseNc({ phase: 'sending', acceptedAt: Date.now() }) }) })
    await advanceNarrowcastBroadcasts(db)
    expect(docs.b1!.status).toBe('processing')
  })

  it('LINE 回報一位都沒送到（例：人太少）＝什麼都沒送出去 → 改用群發', async () => {
    vi.mocked(narrowcastProgress).mockResolvedValue({ phase: 'failed', successCount: 0, failureCount: 0, targetCount: 0, errorCode: 2, failedDescription: 'x' })
    const { db, docs } = makeDb({ b1: bc({ lineRequestId: 'req-1', narrowcast: baseNc({ phase: 'sending', acceptedAt: Date.now() }) }) })
    await advanceNarrowcastBroadcasts(db)
    expect(multicastMessage).toHaveBeenCalledTimes(1)
    expect(docs.b1).toMatchObject({ status: 'completed', sendMode: 'multicast', narrowcastFallback: '人數不夠，LINE 沒有送出' })
  })

  it('補發還沒送就失敗 → ⛔ 沒有群發的退路（不知道是誰），標失敗講「可以重設再發」', async () => {
    vi.mocked(audienceReadiness).mockResolvedValue({ readiness: 'failed', detail: 'FAILED/AUDIENCE_GROUP_AUDIENCE_INSUFFICIENT count=12' })
    const { db, docs } = makeDb({ b1: bc({ audienceSource: { type: 'followUp' }, audienceSnapshot: { resolvedUserIds: [] } }) })
    await advanceNarrowcastBroadcasts(db)
    expect(multicastMessage).not.toHaveBeenCalled()
    expect(docs.b1!.status).toBe('failed')
    expect(docs.b1!.failureReason).toContain('可以按「重設為草稿」再發一次')
  })

  it('快照寫了、名單沒記下來就斷了（10 分鐘沒動靜）→ 一定沒送：標失敗、可以放心重發', async () => {
    const old = new Date(Date.now() - 11 * MIN)
    const { db, docs } = makeDb({ b1: bc({ narrowcast: undefined, startedAt: old, updatedAt: old }) })
    await advanceNarrowcastBroadcasts(db)
    expect(docs.b1).toMatchObject({ status: 'failed', failureReason: BROADCAST_STUCK_SAFE_TO_RESEND })
  })

  it('不是 narrowcast 的「發送中」不碰（那是看門狗的事）；只推指定帳號的', async () => {
    const { db } = makeDb({ m1: bc({ sendMode: 'multicast' }), other: bc({ workspaceId: 'w2' }) })
    const s = await advanceNarrowcastBroadcasts(db, 'w1')
    expect(s.checked).toBe(0)
    expect(sendNarrowcast).not.toHaveBeenCalled()
  })
})

describe('startNarrowcast／startFollowUpNarrowcast', () => {
  it('一般推播：上傳名單、記下「等名單」，送給那份名單', async () => {
    vi.mocked(uploadAudience).mockResolvedValue(777)
    const { db, docs } = makeDb({ b1: bc({ narrowcast: undefined }) })
    const r = await startNarrowcast({ ref: db.collection().doc('b1'), workspaceId: 'w1', name: 'x', lineUserIds: ['U1'], messages: [{ type: 'text', text: 'hi' }] })
    expect(r).toEqual({ ok: true, estimate: 1 })
    expect(docs.b1!.narrowcast).toMatchObject({ phase: 'audience', uploadAudienceGroupId: 777, waitAudienceGroupIds: [777] })
    expect(JSON.parse(docs.b1!.narrowcast.recipientJson)).toEqual({ type: 'audience', audienceGroupId: 777 })
  })

  it('一般推播：上傳失敗 → 回原因（呼叫端改用群發）', async () => {
    vi.mocked(uploadAudience).mockRejectedValue(new Error('No valid audience id'))
    const { db } = makeDb({ b1: bc({ narrowcast: undefined }) })
    const r = await startNarrowcast({ ref: db.collection().doc('b1'), workspaceId: 'w1', name: 'x', lineUserIds: ['U1'], messages: [] })
    expect(r).toEqual({ ok: false, reason: 'LINE 名單建不起來：No valid audience id' })
  })

  it('補發「沒打開的人」：請 LINE 圈看過的人，送給「原本名單扣掉看過的」', async () => {
    vi.mocked(createRetargetAudience).mockResolvedValue(888)
    const src = bc({ status: 'completed', sendMode: 'narrowcast', lineRequestId: 'req-src', narrowcast: baseNc({ phase: 'done' }), completedAt: new Date(Date.now() - 2 * 86_400_000) })
    const fu = bc({ audienceSource: { type: 'followUp', sourceBroadcastId: 'src', followUpTarget: 'unopened' }, narrowcast: undefined })
    const { db, docs } = makeDb({ src, fu })
    const r = await startFollowUpNarrowcast({ db, ref: db.collection().doc('fu'), workspaceId: 'w1', data: fu as any, messages: [] })
    expect(r.ok).toBe(true)
    expect(createRetargetAudience).toHaveBeenCalledWith('w1', 'impression', 'req-src', expect.any(String))
    expect(JSON.parse(docs.fu!.narrowcast.recipientJson)).toEqual({
      type: 'operator',
      and: [{ type: 'audience', audienceGroupId: 111 }, { type: 'operator', not: { type: 'audience', audienceGroupId: 888 } }],
    })
    expect(docs.fu!.narrowcast.waitAudienceGroupIds).toEqual([888, 111])
  })

  it('補發：原本那則超過 60 天／不是 narrowcast 送的 → 不請 LINE 圈名單，回原因', async () => {
    const old = bc({ status: 'completed', lineRequestId: 'req-src', narrowcast: baseNc({ phase: 'done' }), completedAt: new Date(Date.now() - 61 * 86_400_000) })
    const fu = bc({ audienceSource: { type: 'followUp', sourceBroadcastId: 'src', followUpTarget: 'unopened' } })
    const { db } = makeDb({ src: old, fu })
    const r = await startFollowUpNarrowcast({ db, ref: db.collection().doc('fu'), workspaceId: 'w1', data: fu as any, messages: [] })
    expect(r).toEqual({ ok: false, reason: '原本那則發完超過 60 天，LINE 不再提供名單' })
    expect(createRetargetAudience).not.toHaveBeenCalled()
  })
})
