import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('./audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('./broadcast-line-insight', () => ({ fetchBroadcastLineInsight: vi.fn() }))
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(o.statusMessage), o))

import { createFollowUpDraft } from './broadcast-follow-up-draft'
import { writeAuditLog } from './audit-log'
import { fetchBroadcastLineInsight } from './broadcast-line-insight'

const DAY = 86_400_000

function makeDb() {
  const sets: Array<{ id: string; doc: any }> = []
  const db: any = { collection: () => ({ doc: (id: string) => ({ set: async (doc: any) => { sets.push({ id, doc }) } }) }) }
  return { db, sets }
}

/** 用 narrowcast 送完、存了 LINE 數字的小滑手_開賣 */
const src = (over: Record<string, any> = {}) => ({
  workspaceId: 'w1',
  name: '小滑手_開賣',
  status: 'completed',
  sendMode: 'narrowcast',
  lineRequestId: 'req-1',
  narrowcast: { uploadAudienceGroupId: 111 },
  completedAt: new Date(Date.now() - 2 * DAY),
  sentCount: 2187,
  lineStats: { opened: 786, clicked: 443, round: 3, fetchedAt: 1 },
  messages: [{ type: 'text', text: '開賣了' }],
  audienceSource: { type: 'tags', tagIds: ['t1'] },
  completionTagIds: ['t-done'],
  ...over,
})

beforeEach(() => {
  vi.mocked(writeAuditLog).mockClear()
  vi.mocked(fetchBroadcastLineInsight).mockReset()
})

describe('createFollowUpDraft（成效報表「補發給沒打開的人」）', () => {
  it('建一則草稿：內容照原本那則、對象是「LINE 依那則挑的沒打開的人」、人數用估的，⛔ 不帶發完貼記號', async () => {
    const { db, sets } = makeDb()
    const { doc } = await createFollowUpDraft({ db, uid: 'u1', workspaceId: 'w1', sourceId: 'src', src: src() as any, target: 'unopened' })
    expect(sets).toHaveLength(1)
    expect(doc).toMatchObject({
      status: 'draft',
      name: '小滑手_開賣－補發給沒打開的人',
      messages: [{ type: 'text', text: '開賣了' }],
      audienceSource: { type: 'followUp', sourceBroadcastId: 'src', followUpTarget: 'unopened', sourceName: '小滑手_開賣' },
      completionTagIds: [],
    })
    expect(doc.audienceSnapshot.estimatedCount).toBe(2187 - 786)
    // 存下來的數字夠用就不問 LINE（省次數）
    expect(fetchBroadcastLineInsight).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0]).toMatchObject({ action: 'broadcast.followUp', note: '小滑手_開賣' })
  })

  it('不能補發（用了客人名字）→ 409、講報表上同一句原因，不建草稿', async () => {
    const { db, sets } = makeDb()
    await expect(createFollowUpDraft({ db, uid: 'u1', workspaceId: 'w1', sourceId: 'src', src: src({ sendMode: 'perRecipient' }) as any, target: 'unopened' }))
      .rejects.toMatchObject({ statusCode: 409, statusMessage: expect.stringContaining('是一人一則送的') })
    expect(sets).toHaveLength(0)
  })

  it('那一種不夠 50 人（點的只有 28 位）→ 那一種擋下，講原因', async () => {
    const { db } = makeDb()
    await expect(createFollowUpDraft({ db, uid: 'u1', workspaceId: 'w1', sourceId: 'src', src: src({ lineStats: { opened: 786, clicked: 28, round: 3 } }) as any, target: 'clicked' }))
      .rejects.toMatchObject({ statusCode: 409, statusMessage: expect.stringContaining('點連結的人不到 50 位') })
  })

  it('還沒存下 LINE 數字（發完不到一天）→ 現場問 LINE（拿那一則的編號問）', async () => {
    vi.mocked(fetchBroadcastLineInsight).mockResolvedValue({ lineUniqueImpression: 300, lineUniqueClick: 80 })
    const { db } = makeDb()
    const { doc } = await createFollowUpDraft({ db, uid: 'u1', workspaceId: 'w1', sourceId: 'src', src: src({ lineStats: null }) as any, target: 'clicked' })
    expect(vi.mocked(fetchBroadcastLineInsight).mock.calls[0]![5]).toBe('req-1')
    expect(doc.audienceSnapshot.estimatedCount).toBe(80)
  })
})
