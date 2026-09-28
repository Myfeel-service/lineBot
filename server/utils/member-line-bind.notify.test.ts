/**
 * 加進通知名單（`C-250`③：開帳按了「是我」的那支手機；`C-270`：綁定碼與「LINE 通知」頁也走這支）。
 *
 * ⭐ 為什麼要有：綁定手機原本不會加進名單——「客人要找你本人、早上的摘要會傳到這支手機」
 *    就只是一句沒人兌現的話。這裡守：加得進去、不擠掉別人、名單滿了照實講；
 *    寫入走交易（同時按不會掉人）；換手機綁定時舊那支從名單拿掉。
 *    （2026-09-26 的「關著要說關著」`off` 隨總開關拿掉而退場，見下面那兩條的說明）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({
  store: {
    doc: null as any,
    writes: [] as any[],
    txUsed: false,
    /** 讓交易丟例外（演「寫不進去」） */
    txFail: false,
    members: {} as Record<string, any>,
  },
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({}), delete: () => '__del__' } }))
vi.mock('./firebase', () => {
  const aiRef = {
    get: async () => ({ exists: store.doc != null, data: () => store.doc }),
    update: async (p: any) => { store.writes.push({ kind: 'update', p }) },
    set: async (p: any) => { store.writes.push({ kind: 'set', p }) },
  }
  const memberRef = (id: string) => ({
    id,
    get: async () => ({ exists: store.members[id] != null, data: () => store.members[id] }),
  })
  return {
    getDb: () => ({
      collection: (col: string) => col === 'workspaceMembers'
        ? {
            doc: (id: string) => memberRef(id),
            where: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }),
          }
        : { doc: () => aiRef },
      runTransaction: async (fn: (tx: any) => unknown) => {
        if (store.txFail) throw new Error('tx boom')
        store.txUsed = true
        return fn({
          get: (r: any) => r.get(),
          update: (r: any, p: any) => r.update(p),
          set: (r: any, p: any) => r.set(p),
        })
      },
      batch: () => ({ update: () => {}, commit: async () => {} }),
    }),
  }
})
vi.mock('./ai-settings', () => ({ AI_SETTINGS_COLLECTION: 'aiSettings', invalidateAiSettingsCache: vi.fn() }))
vi.mock('./line', () => ({ getUserProfile: vi.fn(), replyMessage: vi.fn() }))
vi.mock('./line-oa-basic-id', () => ({ resolveLineOaBasicId: vi.fn() }))

import { addToHandoffNotify, bindMemberLineUser, HANDOFF_NOTIFY_MAX, removeFromHandoffNotify, setMemberNotifyReceiving } from './member-line-bind'

beforeEach(() => {
  store.doc = null
  store.writes = []
  store.txUsed = false
  store.txFail = false
  store.members = {}
})

describe('removeFromHandoffNotify 要照實回報（`C-271`⑥）', () => {
  it('拿掉了＝removed；本來就不在＝absent（什麼都沒寫）', async () => {
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['U9', 'U8'] } }
    expect(await removeFromHandoffNotify('w', 'U9')).toBe('removed')
    expect(store.writes[0].p['handoffNotify.lineUserIds']).toEqual(['U8'])
    store.writes = []
    expect(await removeFromHandoffNotify('w', 'U7')).toBe('absent')
    expect(store.writes).toHaveLength(0)
  })
  it('🔴 寫不進去＝failed（⛔ 原本吞掉錯誤回 void，端點照樣說「拿掉了」、寫操作紀錄）', async () => {
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['U9'] } }
    store.txFail = true
    expect(await removeFromHandoffNotify('w', 'U9')).toBe('failed')
  })
})

describe('setMemberNotifyReceiving：觀察者不收（`C-271`⑬）', () => {
  it('⛔ 觀察者打不開；已經在收的照樣可以關', async () => {
    store.members['u1_w'] = { lineUserId: 'U9', role: 'viewer', lineDisplayName: '觀' }
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['U9'] } }
    expect(await setMemberNotifyReceiving('w', 'u1', true)).toEqual({ ok: false, reason: 'viewer' })
    expect(store.writes).toHaveLength(0)
    expect(await setMemberNotifyReceiving('w', 'u1', false)).toEqual({ ok: true, result: 'removed' })
  })
  it('客服打開 → added；再按一次 → already（端點據此不寫假變更）', async () => {
    store.members['u1_w'] = { lineUserId: 'U9', role: 'agent' }
    store.doc = { handoffNotify: { enabled: true, lineUserIds: [] } }
    expect(await setMemberNotifyReceiving('w', 'u1', true)).toEqual({ ok: true, result: 'added' })
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['U9'] } }
    expect(await setMemberNotifyReceiving('w', 'u1', true)).toEqual({ ok: true, result: 'already' })
  })
})

describe('addToHandoffNotify', () => {
  it('新帳號（名單空的）：加進去、順手把通知打開（走交易）', async () => {
    store.doc = { handoffNotify: { enabled: false, lineUserIds: [] } }
    expect(await addToHandoffNotify('w', 'U1', '王小明')).toBe('added')
    const p = store.writes[0].p
    expect(p['handoffNotify.lineUserIds']).toEqual(['U1'])
    expect(p['handoffNotify.enabled']).toBe(true)
    expect(p['handoffNotify.displayNames']).toEqual({ U1: '王小明' })
    expect(store.txUsed).toBe(true)
  })

  it('名單有人、通知開著：加進去＝added', async () => {
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['U9'] } }
    expect(await addToHandoffNotify('w', 'U1', '')).toBe('added')
  })

  /*
   * 2026-09-27 `D-103` 拍板拿掉「總開關」（名單有人＝開），這兩條從「回 off、不替他打開」改成下面的規則。
   * 舊資料「名單有人但 enabled=false」＝那些人其實一則都沒收到（讀通知的每一處都先看 enabled），
   * 所以以**真的在收的人**為底：加進來的人成為名單上唯一一位、通知打開。
   * ⛔ 不可以把那幾位關著的人一起默默打開——他們從沒同意收，現在才開始收會嚇到人。
   */
  it('🔴 舊資料「名單有人但關著」：只加進自己、打開；⛔ 關著的那幾位不跟著被打開', async () => {
    store.doc = { handoffNotify: { enabled: false, lineUserIds: ['U9'], displayNames: { U9: '舊的' } } }
    expect(await addToHandoffNotify('w', 'U1', '小明')).toBe('added')
    expect(store.writes[0].p['handoffNotify.lineUserIds']).toEqual(['U1'])
    expect(store.writes[0].p['handoffNotify.enabled']).toBe(true)
    expect(store.writes[0].p['handoffNotify.displayNames']).toEqual({ U1: '小明' })
  })

  it('已經在名單上（含舊資料的 `workspace_U…` 形式）→ 不重複加', async () => {
    // 要用長得像真的 LINE 帳號的 id：舊資料 `w_U…` 的收斂只認 U＋32 位十六進位（`shared/line-notify-list`）
    const real = `U${'1'.repeat(32)}`
    store.doc = { handoffNotify: { enabled: true, lineUserIds: [`w_${real}`] } }
    expect(await addToHandoffNotify('w', real, '')).toBe('already')
    expect(store.writes).toHaveLength(0)
  })

  it('名單上的人的顯示名稱留著，拿掉的人的名字不殘留', async () => {
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['U9'], displayNames: { U9: '阿華', Ugone: '走了的人' } } }
    expect(await addToHandoffNotify('w', 'U1', '小明')).toBe('added')
    expect(store.writes[0].p['handoffNotify.displayNames']).toEqual({ U9: '阿華', U1: '小明' })
  })

  it(`⛔ 滿了（${HANDOFF_NOTIFY_MAX} 位）→ 回 full、不擠掉別人`, async () => {
    store.doc = { handoffNotify: { enabled: true, lineUserIds: Array.from({ length: HANDOFF_NOTIFY_MAX }, (_, i) => `U${i + 10}`) } }
    expect(await addToHandoffNotify('w', 'U1', '')).toBe('full')
    expect(store.writes).toHaveLength(0)
  })

  it('還沒有 AI 設定文件：只寫名單這一格（⛔ 不寫一整份設定覆蓋預設值）', async () => {
    store.doc = null
    expect(await addToHandoffNotify('w', 'U1', '王')).toBe('added')
    expect(store.writes[0]).toMatchObject({ kind: 'set', p: { handoffNotify: { enabled: true, lineUserIds: ['U1'] } } })
  })
})

describe('bindMemberLineUser：換一支手機綁定', () => {
  it('舊那支從通知名單拿掉（⛔ 不然它繼續收通知、卻已經不屬於任何成員）', async () => {
    store.members['u1_w'] = { lineUserId: 'Uold' }
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['Uold', 'Uother'], displayNames: { Uold: '舊手機' } } }
    // memberDocId 的格式由實作決定：兩種都放，找得到哪個算哪個
    store.members['w_u1'] = store.members['u1_w']
    expect(await bindMemberLineUser('w', 'u1', { lineUserId: 'Unew', displayName: '新手機', pictureUrl: '' })).toBe(true)
    const removed = store.writes.find(w => w.kind === 'update' && w.p['handoffNotify.lineUserIds'])
    expect(removed?.p['handoffNotify.lineUserIds']).toEqual(['Uother'])
    expect(removed?.p['handoffNotify.displayNames']).toEqual({})
  })

  it('綁回同一支：名單不動', async () => {
    store.members['u1_w'] = { lineUserId: 'Usame' }
    store.members['w_u1'] = store.members['u1_w']
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['Usame'] } }
    await bindMemberLineUser('w', 'u1', { lineUserId: 'Usame', displayName: '', pictureUrl: '' })
    expect(store.writes).toHaveLength(0)
  })
})
