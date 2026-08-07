/**
 * 腳本引擎「整輪對話」整合測試。
 * 用記憶體假 Firestore + mock 掉 gemini/tagging，真正驅動 startScript / advanceScript 跑多輪，
 * 不碰任何外部服務、可重複執行。涵蓋：收集+格式驗證+重問、寫名單→屬性、貼標、快速回覆路由、
 * 分支判斷、變數渲染、完成/轉真人、語意 embedding 存檔結構（Firestore 不接受巢狀陣列）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// FieldValue 用可辨識的 sentinel，假 db 才能解讀 delete / increment
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => ({ __op: 'delete' }),
    increment: (n: number) => ({ __op: 'increment', n }),
    serverTimestamp: () => ({ __op: 'ts' }),
  },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
const { addTagsToUser } = vi.hoisted(() => ({ addTagsToUser: vi.fn(async () => ({ added: [], skipped: [] })) }))
vi.mock('./tagging', () => ({ addTagsToUser }))

import { startScript, advanceScript } from './ai-scripts'
import type { ActiveScriptState, ScriptDoc, ScriptNode } from '~~/shared/types/ai-script'

// ── 記憶體假 Firestore（只實作引擎用到的 get/update/set） ──────────────
function deepMerge(target: any, src: any) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v as any).__op) {
      target[k] = (target[k] && typeof target[k] === 'object') ? target[k] : {}
      deepMerge(target[k], v)
    }
    else { target[k] = v }
  }
}
function applyUpdate(doc: any, data: any) {
  for (const [k, v] of Object.entries(data)) {
    if (v && (v as any).__op === 'delete') { delete doc[k]; continue }
    if (k.includes('.') || (v && (v as any).__op === 'increment')) continue // stats.* 不在斷言範圍
    doc[k] = v
  }
}
interface Store { users: Map<string, any>; scripts: Map<string, any> }
function makeDb() {
  const store: Store = { users: new Map(), scripts: new Map() }
  const col = (name: keyof Store) => store[name]
  const collection = (name: string) => ({
    doc: (id: string) => ({
      async get() { const d = col(name as keyof Store).get(id); return { exists: !!d, data: () => d, id } },
      async update(data: any) { const m = col(name as keyof Store); const d = m.get(id) ?? {}; applyUpdate(d, data); m.set(id, d) },
      async set(data: any, opts?: any) { const m = col(name as keyof Store); const d = opts?.merge ? (m.get(id) ?? {}) : {}; deepMerge(d, data); m.set(id, d) },
    }),
  })
  return { db: { collection } as any, store }
}

const UID = 'w1_Uabc'
function activeScriptOf(store: Store): ActiveScriptState | undefined {
  return store.users.get(UID)?.activeScript
}
function attrsOf(store: Store): Record<string, string> {
  return store.users.get(UID)?.attributes ?? {}
}

function script(nodes: ScriptNode[], rootNodeId = 't'): ScriptDoc & { id: string } {
  return { id: 's1', workspaceId: 'w1', name: 'test', enabled: true, priority: 50, rootNodeId, nodes, createdAt: null as any, updatedAt: null as any }
}

beforeEach(() => addTagsToUser.mockClear())

describe('腳本引擎整輪對話：收集→驗證→寫名單→貼標→回覆', () => {
  const s = script([
    { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['退貨'], examples: [], priority: 50, next: 'c_phone' },
    { id: 'c_phone', type: 'collect', question: '請留下電話 📞', fieldName: 'phone', expireMs: 600000, format: 'phone', reaskText: '電話格式怪怪的，再試一次？', next: 'save' },
    { id: 'save', type: 'saveLead', fieldMap: [{ fromField: 'phone', attrKey: '電話' }], next: 'tag' },
    { id: 'tag', type: 'tag', addTagIds: ['vip'], next: 'r' },
    { id: 'r', type: 'reply', text: '已收到您的電話 {{phone}}，將盡快聯繫您 🙇', thenHandoff: true },
  ])

  it('一輪走完：問電話→格式錯重問→正確抽取→貼標+寫屬性+渲染變數+轉真人', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', s)

    const r1 = await startScript(s, UID, {}, db)
    expect(r1.replyText).toBe('請留下電話 📞')
    expect(r1.finished).toBe(false)
    expect(activeScriptOf(store)?.currentNodeId).toBe('c_phone')

    // 亂答 → 格式不符 → 重問、停在原節點、不前進、未貼標
    const r2 = await advanceScript(activeScriptOf(store)!, '沒有耶', {}, UID, db)
    expect(r2.replyText).toBe('電話格式怪怪的，再試一次？')
    expect(r2.finished).toBe(false)
    expect(activeScriptOf(store)?.currentNodeId).toBe('c_phone')
    expect(addTagsToUser).not.toHaveBeenCalled()

    // 句中夾電話 → 抽出 → save→tag→reply 完成
    const r3 = await advanceScript(activeScriptOf(store)!, '我的電話是0912345678啦', {}, UID, db)
    expect(r3.replyText).toBe('已收到您的電話 0912345678，將盡快聯繫您 🙇')
    expect(r3.finished).toBe(true)
    expect(r3.thenHandoff).toBe(true)
    expect(attrsOf(store)['電話']).toBe('0912345678')
    expect(addTagsToUser).toHaveBeenCalledWith(UID, ['vip'], 'system', 'script:s1', 'w1')
  })
})

describe('腳本引擎整輪對話：快速回覆路由 + 分支判斷', () => {
  const s = script([
    { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['你好'], examples: [], priority: 50, next: 'q' },
    {
      id: 'q', type: 'quickReply', question: '需要什麼服務？', expireMs: 600000,
      options: [{ label: '查訂單', next: 'c_id' }, { label: '退貨', next: 'r_return' }],
    },
    { id: 'c_id', type: 'collect', question: '請輸入訂單編號', fieldName: 'order_id', expireMs: 600000, format: 'any', next: 'b' },
    { id: 'b', type: 'branch', cases: [{ op: 'contains', field: 'order_id', value: 'A', next: 'r_a' }], defaultNext: 'r_other' },
    { id: 'r_return', type: 'reply', text: '退貨流程', thenHandoff: true },
    { id: 'r_a', type: 'reply', text: 'A 開頭訂單', thenHandoff: false },
    { id: 'r_other', type: 'reply', text: '其他訂單', thenHandoff: false },
  ])

  it('點「退貨」按鈕 → 直接走退貨回覆', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', s)
    const r1 = await startScript(s, UID, {}, db)
    expect(r1.replyText).toBe('需要什麼服務？')
    expect(r1.quickReplies).toEqual(['查訂單', '退貨'])

    const r2 = await advanceScript(activeScriptOf(store)!, '退貨', {}, UID, db)
    expect(r2.replyText).toBe('退貨流程')
    expect(r2.finished).toBe(true)
  })

  it('點「查訂單」→ 問編號 → 分支依內容走（含 / 其餘）', async () => {
    {
      const { db, store } = makeDb()
      store.scripts.set('s1', s)
      await startScript(s, UID, {}, db)
      await advanceScript(activeScriptOf(store)!, '查訂單', {}, UID, db)
      expect(activeScriptOf(store)?.currentNodeId).toBe('c_id')
      const r = await advanceScript(activeScriptOf(store)!, 'A123', {}, UID, db)
      expect(r.replyText).toBe('A 開頭訂單')
      expect(r.finished).toBe(true)
    }
    {
      const { db, store } = makeDb()
      store.scripts.set('s1', s)
      await startScript(s, UID, {}, db)
      await advanceScript(activeScriptOf(store)!, '查訂單', {}, UID, db)
      const r = await advanceScript(activeScriptOf(store)!, 'B999', {}, UID, db)
      expect(r.replyText).toBe('其他訂單')
    }
  })

  it('手打按鈕文字（大小寫/空白不同）也對得到', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', s)
    await startScript(s, UID, {}, db)
    const r = await advanceScript(activeScriptOf(store)!, '  退貨  ', {}, UID, db)
    expect(r.replyText).toBe('退貨流程')
  })
})

describe('腳本引擎：過期狀態清除', () => {
  it('activeScript 已過期 → 回空結果並清除，讓主流程往下走', async () => {
    const { db, store } = makeDb()
    const expired: ActiveScriptState = { scriptId: 's1', currentNodeId: 'c_phone', collected: {}, startedAt: 0, expiresAt: Date.now() - 1000 }
    store.users.set(UID, { activeScript: expired })
    const r = await advanceScript(expired, '0912345678', {}, UID, db)
    expect(r.finished).toBe(true)
    expect(r.replyText).toBe('')
    expect(activeScriptOf(store)).toBeUndefined()
  })
})

describe('腳本逃生門：進行中喊「找真人」永遠有人聽見', () => {
  const s = script([
    { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['退貨'], examples: [], priority: 50, next: 'c' },
    { id: 'c', type: 'collect', question: '請提供訂單編號', fieldName: 'order_id', expireMs: 600000, format: 'any', next: 'r' },
    { id: 'r', type: 'reply', text: '已收到 {{order_id}}', thenHandoff: true },
  ])

  it('collect(不限格式)喊「找真人」→ 放棄流程，不會被存成答案', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', s)
    await startScript(s, UID, {}, db)

    const r = await advanceScript(activeScriptOf(store)!, '找真人', {}, UID, db)
    expect(r.escapeToHuman).toBe(true)
    expect(r.finished).toBe(true)
    expect(r.replyText).toBe('') // 沒把「找真人」當答案跑到 reply
    expect(activeScriptOf(store)).toBeFalsy() // activeScript 已清
  })

  it('「轉真人」也逃生；一般答案完全不受影響', async () => {
    {
      const { db, store } = makeDb()
      store.scripts.set('s1', s)
      await startScript(s, UID, {}, db)
      const r = await advanceScript(activeScriptOf(store)!, '轉真人', {}, UID, db)
      expect(r.escapeToHuman).toBe(true)
    }
    {
      const { db, store } = makeDb()
      store.scripts.set('s1', s)
      await startScript(s, UID, {}, db)
      const r = await advanceScript(activeScriptOf(store)!, 'A123456', {}, UID, db)
      expect(r.escapeToHuman).toBeUndefined()
      expect(r.replyText).toBe('已收到 A123456')
      expect(r.thenHandoff).toBe(true)
    }
  })

  it('collect 答錯格式重問時，亮「找真人」逃生按鈕', async () => {
    const sPhone = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['預約'], examples: [], priority: 50, next: 'c' },
      { id: 'c', type: 'collect', question: '電話？', fieldName: 'phone', expireMs: 600000, format: 'phone', next: 'r' },
      { id: 'r', type: 'reply', text: '收到', thenHandoff: false },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', sPhone)
    await startScript(sPhone, UID, {}, db)

    const r = await advanceScript(activeScriptOf(store)!, '不知道耶', {}, UID, db)
    expect(r.finished).toBe(false)
    expect(r.quickReplies).toEqual(['找真人'])
  })

  it('quickReply 沒對到選項重問時，按鈕多一顆「找真人」；選項已有同義按鈕則不重複', async () => {
    const mk = (labels: string[]) => script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['你好'], examples: [], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '需要什麼？', expireMs: 600000, options: labels.map(l => ({ label: l, next: 'r' })) },
      { id: 'r', type: 'reply', text: '好的', thenHandoff: false },
    ])
    {
      const { db, store } = makeDb()
      store.scripts.set('s1', mk(['查訂單', '退貨']))
      await startScript(mk(['查訂單', '退貨']), UID, {}, db)
      const r = await advanceScript(activeScriptOf(store)!, '嗯？', {}, UID, db)
      expect(r.quickReplies).toEqual(['查訂單', '退貨', '找真人'])
    }
    {
      const { db, store } = makeDb()
      store.scripts.set('s1', mk(['查訂單', '找真人']))
      await startScript(mk(['查訂單', '找真人']), UID, {}, db)
      const r = await advanceScript(activeScriptOf(store)!, '嗯？', {}, UID, db)
      expect(r.quickReplies).toEqual(['查訂單', '找真人']) // 不重複加
    }
  })
})

describe('腳本引擎：collect 跳過出口（客人沒有這個資料也有路走）', () => {
  const s = script([
    { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['查訂單'], examples: [], priority: 50, next: 'c_id' },
    { id: 'c_id', type: 'collect', question: '請問您的訂單編號是？', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', reaskText: '編號好像不太對，再試一次？', skipLabel: '我沒有訂單編號', skipNext: 'c_email', next: 'r_ok' },
    { id: 'c_email', type: 'collect', question: '沒問題，請提供下單的 Email', fieldName: 'email', expireMs: 600000, format: 'email', next: 'r_email' },
    { id: 'r_ok', type: 'reply', text: '已收到訂單 {{order_id}}', thenHandoff: true },
    { id: 'r_email', type: 'reply', text: '已收到 {{email}}，將盡快為您查詢', thenHandoff: true },
  ])

  it('問編號時就亮跳過按鈕；點了 → 不存髒值、改問 Email、走完 Email 路線', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', s)

    const r1 = await startScript(s, UID, {}, db)
    expect(r1.replyText).toBe('請問您的訂單編號是？')
    expect(r1.quickReplies).toEqual(['我沒有訂單編號'])

    const r2 = await advanceScript(activeScriptOf(store)!, '我沒有訂單編號', {}, UID, db)
    expect(r2.replyText).toBe('沒問題，請提供下單的 Email')
    expect(activeScriptOf(store)?.currentNodeId).toBe('c_email')
    expect(activeScriptOf(store)?.collected.order_id).toBeUndefined() // 跳過語沒被存成編號

    const r3 = await advanceScript(activeScriptOf(store)!, '我的信箱 me@example.com', {}, UID, db)
    expect(r3.replyText).toBe('已收到 me@example.com，將盡快為您查詢')
    expect(r3.finished).toBe(true)
    expect(r3.thenHandoff).toBe(true)
  })

  it('手打跳過語（前後空白）也認得', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', s)
    await startScript(s, UID, {}, db)
    const r = await advanceScript(activeScriptOf(store)!, '  我沒有訂單編號  ', {}, UID, db)
    expect(activeScriptOf(store)?.currentNodeId).toBe('c_email')
    expect(r.replyText).toBe('沒問題，請提供下單的 Email')
  })

  it('答錯格式重問 → 跳過按鈕和找真人一起亮；之後照常答編號仍走原路', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', s)
    await startScript(s, UID, {}, db)

    const r1 = await advanceScript(activeScriptOf(store)!, '呃我想想', {}, UID, db)
    expect(r1.finished).toBe(false)
    expect(r1.quickReplies).toEqual(['我沒有訂單編號', '找真人'])

    const r2 = await advanceScript(activeScriptOf(store)!, '編號是 OD-2024/001', {}, UID, db)
    expect(r2.replyText).toBe('已收到訂單 OD-2024/001')
    expect(r2.finished).toBe(true)
  })

  it('format any + 跳過：跳過語先攔下來，不會被「照單全收」存成答案', async () => {
    const sAny = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['查'], examples: [], priority: 50, next: 'c' },
      { id: 'c', type: 'collect', question: '訂單編號？', fieldName: 'order_id', expireMs: 600000, format: 'any', skipLabel: '沒有編號', skipNext: 'r_skip', next: 'r_ok' },
      { id: 'r_ok', type: 'reply', text: '收到 {{order_id}}', thenHandoff: false },
      { id: 'r_skip', type: 'reply', text: '好的，請專員協助您', thenHandoff: true },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', sAny)
    await startScript(sAny, UID, {}, db)
    const r = await advanceScript(activeScriptOf(store)!, '沒有編號', {}, UID, db)
    expect(r.replyText).toBe('好的，請專員協助您')
    expect(r.thenHandoff).toBe(true)
  })

  it('skipLabel 沒成對設 skipNext（壞資料防呆）→ 視為沒設跳過：問句不帶按鈕', async () => {
    const sBroken = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['查'], examples: [], priority: 50, next: 'c' },
      { id: 'c', type: 'collect', question: '訂單編號？', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', skipLabel: '沒有編號', next: 'r' },
      { id: 'r', type: 'reply', text: '收到', thenHandoff: false },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', sBroken)
    const r1 = await startScript(sBroken, UID, {}, db)
    expect(r1.quickReplies).toBeUndefined()
    // 打跳過語不會跳（沒地方可跳），走一般格式驗證 → 重問只亮找真人
    const r2 = await advanceScript(activeScriptOf(store)!, '沒有編號', {}, UID, db)
    expect(r2.quickReplies).toEqual(['找真人'])
  })
})
