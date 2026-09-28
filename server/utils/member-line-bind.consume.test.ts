/**
 * 綁定碼傳進來之後（`D-103`①②／`C-270`，2026-09-27）。
 *
 * 原本：綁好了卻**不會**加進通知名單，回覆還叫人「之後把這個帳號加進轉真人通知名單」——
 * 要管理員再去 AI 設定勾一次，兩頁各做一次；正式資料上 5 個接上 LINE 的帳號只有 1 個有人收得到。
 * 這裡守：綁好＝進名單、回覆講得出會收到什麼與第一則幾點、送到了就記下來、換手機時舊那支拿掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store, line, basic } = vi.hoisted(() => ({
  store: {
    members: [] as { id: string, data: Record<string, any> }[],
    ai: null as any,
    memberUpdates: [] as { id: string, patch: any }[],
    aiWrites: [] as any[],
    deliveryWrites: [] as any[],
    txFail: false,
  },
  line: { profile: null as any, replies: [] as string[] },
  basic: { id: '@demo' },
}))

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({}), delete: () => '__del__' } }))
vi.mock('./firebase', () => {
  const aiRef = {
    get: async () => ({ exists: store.ai != null, data: () => store.ai }),
    update: async (p: any) => { store.aiWrites.push(p) },
    set: async (p: any) => { store.aiWrites.push(p) },
  }
  return {
    getDb: () => ({
      collection: (col: string) => {
        if (col === 'workspaceMembers') {
          return {
            where: () => ({
              get: async () => ({
                docs: store.members.map(m => ({ id: m.id, ref: { id: m.id }, data: () => m.data })),
              }),
            }),
          }
        }
        if (col === 'lineNotifyDelivery')
          return { doc: () => ({ set: async (p: any) => { store.deliveryWrites.push(p) } }) }
        return { doc: () => aiRef }
      },
      runTransaction: async (fn: (tx: any) => unknown) => store.txFail ? Promise.reject(new Error('tx boom')) : fn({
        get: (r: any) => r.get(),
        update: (r: any, p: any) => r.update(p),
        set: (r: any, p: any) => r.set(p),
      }),
      batch: () => ({
        update: (ref: any, patch: any) => { store.memberUpdates.push({ id: ref.id, patch }) },
        commit: async () => {},
      }),
    }),
  }
})
vi.mock('./ai-settings', () => ({
  AI_SETTINGS_COLLECTION: 'aiSettings',
  invalidateAiSettingsCache: vi.fn(),
  getAiSettings: vi.fn(async () => ({
    handoffNotify: { mode: 'missed_only', slaRemindMinutes: 60, digestHour: 10, criticalAlertPush: true },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: false },
  })),
}))
vi.mock('./line', () => ({
  getUserProfile: vi.fn(async () => line.profile),
  replyMessage: vi.fn(async (_t: string, msgs: { text: string }[]) => { line.replies.push(msgs[0]!.text) }),
  pushMessage: vi.fn(),
}))
vi.mock('./line-oa-basic-id', () => ({ resolveLineOaBasicId: vi.fn(async () => basic.id) }))

import { tryConsumeMemberLineBindCode } from './member-line-bind'

const FUTURE = Date.now() + 5 * 60_000

beforeEach(() => {
  store.members = []
  store.ai = { handoffNotify: { enabled: true, lineUserIds: ['Uother'] } }
  store.memberUpdates = []
  store.aiWrites = []
  store.deliveryWrites = []
  store.txFail = false
  line.profile = { displayName: '阿豪', pictureUrl: '' }
  line.replies = []
})

const consume = () => tryConsumeMemberLineBindCode({ lineUserId: 'Unew', text: '綁定 A3F9K2', workspaceId: 'w', replyToken: 'rt' })

describe('綁定碼傳進來', () => {
  it('⭐ 綁好＝加進通知名單，回覆講得出會收到什麼、第一則幾點，並記成「送到了」', async () => {
    store.members = [{ id: 'u1_w', data: { lineBindCode: 'A3F9K2', lineBindCodeExpiresAt: FUTURE, invitedEmail: 'a@x.tw' } }]
    expect(await consume()).toBe(true)

    // 名單：原本的人留著、新的加在後面
    const added = store.aiWrites.find(w => w['handoffNotify.lineUserIds'])
    expect(added['handoffNotify.lineUserIds']).toEqual(['Uother', 'Unew'])
    // 回覆：跟後台預覽同一支函式（shared/line-notify-messages）
    expect(line.replies).toHaveLength(1)
    expect(line.replies[0]).toContain('好了 ✓ 這支手機之後會收到：')
    expect(line.replies[0]).toContain('等超過 60 分鐘沒人接手時')
    expect(line.replies[0]).toMatch(/(今天|明天|週.)早上 10:00 會收到第一則/)
    // ⛔ 舊的「之後把這個帳號加進轉真人通知名單」不可以再出現（那正是兩頁各做一次的來源）
    expect(line.replies[0]).not.toContain('轉真人通知')
    // 送達紀錄：確認那則算「送到了」（後台那一列才講得出「剛剛送達確認訊息」）
    expect(store.deliveryWrites).toHaveLength(1)
    expect(store.deliveryWrites[0].recipients.Unew).toMatchObject({ okKind: 'confirm' })
  })

  it('換手機：舊那支從名單拿掉（⛔ 不然它繼續收通知、卻已經不屬於任何成員）', async () => {
    store.ai = { handoffNotify: { enabled: true, lineUserIds: ['Uold', 'Uother'] } }
    store.members = [{ id: 'u1_w', data: { lineBindCode: 'A3F9K2', lineBindCodeExpiresAt: FUTURE, lineUserId: 'Uold' } }]
    await consume()
    const removed = store.aiWrites.find(w => Array.isArray(w['handoffNotify.lineUserIds']) && !w['handoffNotify.lineUserIds'].includes('Uold'))
    expect(removed).toBeTruthy()
  })

  it('讀不到他的 LINE 資料（可能還不是好友）→ 回覆附加好友連結', async () => {
    line.profile = null
    store.members = [{ id: 'u1_w', data: { lineBindCode: 'A3F9K2', lineBindCodeExpiresAt: FUTURE } }]
    await consume()
    expect(line.replies[0]).toContain('如果還沒加這個官方帳號好友')
    expect(line.replies[0]).toContain('https://line.me/R/ti/p/%40demo')
  })

  it('🔴 名單滿了 → 照實講沒加進去，⛔ 不記成「送到了」、不承諾會收到', async () => {
    store.ai = { handoffNotify: { enabled: true, lineUserIds: Array.from({ length: 10 }, (_, i) => `U${i}`) } }
    store.members = [{ id: 'u1_w', data: { lineBindCode: 'A3F9K2', lineBindCodeExpiresAt: FUTURE } }]
    await consume()
    expect(line.replies[0]).toContain('名單已經滿了')
    expect(line.replies[0]).not.toContain('之後會收到')
    expect(store.deliveryWrites).toHaveLength(0)
  })

  it('觀察者綁定碼 → 綁好 LINE 但 ⛔ 不加進名單，照實講（`C-271`⑬）', async () => {
    store.members = [{ id: 'u1_w', data: { lineBindCode: 'A3F9K2', lineBindCodeExpiresAt: FUTURE, role: 'viewer' } }]
    await consume()
    expect(store.memberUpdates.some(u => u.patch.lineUserId === 'Unew')).toBe(true)
    expect(store.aiWrites.some(w => w['handoffNotify.lineUserIds'])).toBe(false)
    expect(line.replies[0]).toContain('觀察者不收 LINE 通知')
  })

  it('🔴 換手機時舊那支拿不掉 → ⛔ 不綁新的、講「再傳一次」（`C-271`⑥：原本先綁再拿、失敗不吭聲）', async () => {
    store.ai = { handoffNotify: { enabled: true, lineUserIds: ['Uold'] } }
    store.members = [{ id: 'u1_w', data: { lineBindCode: 'A3F9K2', lineBindCodeExpiresAt: FUTURE, lineUserId: 'Uold' } }]
    store.txFail = true
    await consume()
    expect(store.memberUpdates).toHaveLength(0)
    expect(line.replies[0]).toContain('再傳一次')
  })

  it('碼過期 → 講去哪重產，⛔ 不綁、不加名單', async () => {
    store.members = [{ id: 'u1_w', data: { lineBindCode: 'A3F9K2', lineBindCodeExpiresAt: Date.now() - 1 } }]
    await consume()
    expect(line.replies[0]).toContain('過期')
    expect(store.aiWrites).toHaveLength(0)
    expect(store.memberUpdates).toHaveLength(0)
  })
})
