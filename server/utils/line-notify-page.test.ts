/**
 * 「設定 → LINE 通知」那一頁的資料（`C-270`）：每位成員一列，綁了沒、收不收、送到了沒。
 */
import { describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({
  store: {
    ai: null as any,
    members: [] as Record<string, any>[],
    delivery: null as any,
    token: 'tok',
  },
}))

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({}), delete: () => '__del__' } }))
vi.mock('./firebase', () => ({
  getDb: () => ({
    collection: (col: string) => {
      if (col === 'workspaceMembers') {
        return {
          where: () => ({ get: async () => ({ docs: store.members.map(m => ({ data: () => m })) }) }),
          doc: (id: string) => ({ get: async () => {
            const m = store.members.find(x => `${x.uid}_W` === id)
            return { exists: Boolean(m), data: () => m }
          } }),
        }
      }
      if (col === 'lineNotifyDelivery')
        return { doc: () => ({ get: async () => ({ exists: store.delivery != null, data: () => ({ recipients: store.delivery }) }) }) }
      return { doc: () => ({ get: async () => ({ exists: store.ai != null, data: () => store.ai }) }) }
    },
  }),
  getFirebaseAuth: () => ({
    getUsers: async (ids: { uid: string }[]) => ({ users: ids.map(i => ({ uid: i.uid, email: `${i.uid}@x.tw` })) }),
  }),
}))
vi.mock('./line-workspace-credentials', () => ({
  getLineWorkspaceCredentials: vi.fn(async () => ({ channelAccessToken: store.token })),
}))
vi.mock('./line', () => ({ getUserProfile: vi.fn(), replyMessage: vi.fn(), pushMessage: vi.fn() }))
vi.mock('./line-oa-basic-id', () => ({ resolveLineOaBasicId: vi.fn() }))

import { buildLineNotifyPageData, buildLineNotifySelfStatus } from './line-notify-page'

function setup() {
  store.ai = { handoffNotify: { enabled: true, lineUserIds: ['Uowner', 'Ustranger'], displayNames: { Ustranger: '不知道是誰' }, mode: 'missed_only', slaRemindMinutes: 60, digestHour: 10 } }
  store.members = [
    { uid: 'agent1', role: 'agent', invitedEmail: 'a@x.tw' },
    { uid: 'owner1', role: 'owner', lineUserId: 'Uowner', lineDisplayName: '小明' },
    { uid: 'viewer1', role: 'viewer', invitedEmail: 'v@x.tw' },
    { uid: 'agent2', role: 'agent', invitedEmail: 'b@x.tw', lineUserId: 'Uagent2', lineBindCode: 'X', lineBindCodeExpiresAt: Date.now() + 60_000 },
  ]
  store.delivery = { Uowner: { okAt: 100, okKind: 'notify' } }
  store.token = 'tok'
}

describe('buildLineNotifyPageData', () => {
  it('每位成員一列：自己排第一；綁了且在名單＝收；綁了不在名單＝通知關著', async () => {
    setup()
    const d = await buildLineNotifyPageData({ workspaceId: 'W', uid: 'agent1', canManage: false })
    expect(d.rows.map(r => r.uid)).toEqual(['agent1', 'owner1', 'agent2'])
    const owner = d.rows.find(r => r.uid === 'owner1')!
    expect(owner.receiving).toBe(true)
    expect(owner.delivery).toEqual({ state: 'ok', at: 100, kind: 'notify' })
    // 自助開帳的擁有者文件上沒有 Email，要從 Auth 補
    expect(owner.email).toBe('owner1@x.tw')
    const a2 = d.rows.find(r => r.uid === 'agent2')!
    expect(a2.receiving).toBe(false)
    expect(a2.delivery).toBeNull()
    // 綁好的人不算「在等對方點連結」
    expect(a2.pendingCodeExpiresAt).toBeNull()
  })

  it('對方在首頁按過「先不用」要帶出來（名單上不可以再說「登入時會被問」）', async () => {
    setup()
    store.members[0] = { ...store.members[0], lineNotifyInviteDismissedAt: 123 }
    const d = await buildLineNotifyPageData({ workspaceId: 'W', uid: 'owner1', canManage: true })
    expect(d.rows.find(r => r.uid === 'agent1')!.inviteDismissed).toBe(true)
    expect(d.rows.find(r => r.uid === 'owner1')!.inviteDismissed).toBe(false)
  })

  it('觀察者沒綁就不列（他不處理客人、也不能自己加）', async () => {
    setup()
    const d = await buildLineNotifyPageData({ workspaceId: 'W', uid: 'agent1', canManage: false })
    expect(d.rows.some(r => r.uid === 'viewer1')).toBe(false)
  })

  it('🔴 名單上對不上任何成員的 LINE 帳號要列出來（⛔ 不可以靜靜藏起來——它一直在收客人的訊息）', async () => {
    setup()
    const d = await buildLineNotifyPageData({ workspaceId: 'W', uid: 'agent1', canManage: true })
    expect(d.others).toEqual([{ lineUserId: 'Ustranger', displayName: '不知道是誰', delivery: { state: 'never' } }])
  })

  it('舊資料「名單有人但總開關關著」＝沒有人在收（⛔ 不顯示成有人收）', async () => {
    setup()
    store.ai.handoffNotify.enabled = false
    const d = await buildLineNotifyPageData({ workspaceId: 'W', uid: 'agent1', canManage: true })
    expect(d.rows.every(r => !r.receiving)).toBe(true)
    expect(d.others).toEqual([])
  })

  it('送達紀錄讀不到 → deliveryKnown=false（畫面要講，⛔ 不當成都送到了）', async () => {
    setup()
    store.delivery = null
    const d = await buildLineNotifyPageData({ workspaceId: 'W', uid: 'agent1', canManage: false })
    expect(d.deliveryKnown).toBe(true) // 文件不存在＝還沒傳過，不是讀不到
    expect(d.rows.find(r => r.uid === 'owner1')!.delivery).toEqual({ state: 'never' })
  })

  it('selfIsMember：組織管理員／超管沒有成員文件，不能「把我的手機加進來」', async () => {
    setup()
    const d = await buildLineNotifyPageData({ workspaceId: 'W', uid: 'org-admin', canManage: true })
    expect(d.selfIsMember).toBe(false)
  })
})

describe('buildLineNotifySelfStatus', () => {
  it('首頁那張卡要的四件事：是成員、綁了沒、有沒有接上 LINE、按過「先不用」沒', async () => {
    setup()
    store.members[0]!.lineNotifyInviteDismissedAt = 123
    const s = await buildLineNotifySelfStatus('W', 'agent1')
    expect(s).toMatchObject({ isMember: true, bound: false, lineConnected: true, inviteDismissed: true, receiving: false })
    const o = await buildLineNotifySelfStatus('W', 'owner1')
    expect(o).toMatchObject({ bound: true, receiving: true, lineDisplayName: '小明' })
  })
})
