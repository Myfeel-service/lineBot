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
  Timestamp: { fromMillis: (ms: number) => ({ ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
const { addTagsToUser } = vi.hoisted(() => ({ addTagsToUser: vi.fn(async () => ({ added: [], skipped: [] })) }))
vi.mock('./tagging', () => ({ addTagsToUser }))

import { startScript, advanceScript, deleteScriptRuns } from './ai-scripts'
import type { ActiveScriptState, ScriptDoc, ScriptNode } from '~~/shared/types/ai-script'
import { DEFAULT_REPLY_LINK_LABEL } from '~~/shared/types/ai-script'

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
    if (k.includes('.')) continue // stats.* 不在斷言範圍
    // 走進來的紀錄（runs）要斷言重問幾次、截圖幾張：頂層欄位的 increment 照加
    if (v && (v as any).__op === 'increment') { doc[k] = Number(doc[k] ?? 0) + (v as any).n; continue }
    doc[k] = v
  }
}
/** runs：`scripts/{id}/runs/{runId}` 子集合，鍵是「scriptId/runId」（`D-138`） */
interface Store { users: Map<string, any>; scripts: Map<string, any>; runs: Map<string, any> }
function makeDb() {
  const store: Store = { users: new Map(), scripts: new Map(), runs: new Map() }
  const docOf = (m: Map<string, any>, id: string, sub?: (name: string) => any) => ({
    async get() { const d = m.get(id); return { exists: !!d, data: () => d, id } },
    async update(data: any) { const d = m.get(id) ?? {}; applyUpdate(d, data); m.set(id, d) },
    async set(data: any, opts?: any) { const d = opts?.merge ? (m.get(id) ?? {}) : {}; deepMerge(d, data); m.set(id, d) },
    collection: sub,
  })
  const collection = (name: string) => ({
    doc: (id: string) => docOf(store[name as 'users' | 'scripts'], id, (subName: string) => ({
      doc: (subId: string) => docOf(subName === 'runs' ? store.runs : new Map(), `${id}/${subId}`),
    })),
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

  it('店家的按鈕剛好叫「找客服」（求助講法）→ 客人點了照按鈕的路走，不被當成找真人（`C-379`）', async () => {
    const sButtons = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['服務'], examples: [], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '需要什麼服務？', expireMs: 600000, options: [{ label: '查訂單', next: 'r' }, { label: '找客服', next: 'c_phone' }] },
      { id: 'c_phone', type: 'collect', question: '請留電話，客服會打給您', fieldName: 'phone', expireMs: 600000, format: 'phone', next: 'r' },
      { id: 'r', type: 'reply', text: '收到', thenHandoff: true },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', sButtons)
    await startScript(sButtons, UID, {}, db)
    const r = await advanceScript(activeScriptOf(store)!, '找客服', {}, UID, db)
    expect(r.escapeToHuman).toBeUndefined()
    expect(r.replyText).toBe('請留電話，客服會打給您')
    expect(activeScriptOf(store)?.currentNodeId).toBe('c_phone')

    // 不是按鈕的那一步，同一句照舊是找真人
    const r2 = await advanceScript(activeScriptOf(store)!, '找客服', {}, UID, db)
    expect(r2.escapeToHuman).toBe(true)
  })

  it('「客人說沒有」的按鈕叫「找專員」→ 點了走跳過那條，不轉真人（`C-379`）', async () => {
    const sSkip = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['訂單'], examples: [], priority: 50, next: 'c' },
      { id: 'c', type: 'collect', question: '訂單編號？', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', next: 'r', skipLabel: '找專員', skipNext: 'r_skip' },
      { id: 'r', type: 'reply', text: '已收到 {{order_id}}', thenHandoff: true },
      { id: 'r_skip', type: 'reply', text: '好的，專員會跟您聯繫', thenHandoff: true },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', sSkip)
    await startScript(sSkip, UID, {}, db)
    const r = await advanceScript(activeScriptOf(store)!, '找專員', {}, UID, db)
    expect(r.escapeToHuman).toBeUndefined()
    expect(r.replyText).toBe('好的，專員會跟您聯繫')
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

  it('quickReply 沒對到選項重問時，按鈕多一顆「找真人」；選項已經叫「找真人」則不重複', async () => {
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
    {
      // 🔴 選項叫「找客服」是店家的按鈕、點了照它的路走（`C-379`）＝不是逃生鈕：照樣補「找真人」，點了才真的轉真人
      const { db, store } = makeDb()
      store.scripts.set('s1', mk(['查訂單', '找客服']))
      await startScript(mk(['查訂單', '找客服']), UID, {}, db)
      const r = await advanceScript(activeScriptOf(store)!, '嗯？', {}, UID, db)
      expect(r.quickReplies).toEqual(['查訂單', '找客服', '找真人'])
      const r2 = await advanceScript(activeScriptOf(store)!, '找真人', {}, UID, db)
      expect(r2.escapeToHuman).toBe(true)
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

describe('腳本引擎：回覆附連結按鈕（＝自動回覆的「開啟網址」）', () => {
  it('網址吃變數，把剛收到的訂單編號帶進查詢頁；沒填標題時用預設', async () => {
    const s = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['查'], examples: [], priority: 50, next: 'c' },
      { id: 'c', type: 'collect', question: '訂單編號？', fieldName: 'order_id', expireMs: 600000, format: 'any', next: 'r' },
      { id: 'r', type: 'reply', text: '幫您查到了', linkUrl: 'https://shop.example.com/o/{{order_id}}', thenHandoff: false },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', s)

    await startScript(s, UID, {}, db)
    const r = await advanceScript(activeScriptOf(store)!, 'A123', {}, UID, db)
    expect(r.replyText).toBe('幫您查到了')
    // ⛔ 不寫死文字：這條要驗的是「沒填就用預設」，不是那句話現在長什麼樣
    // （`C-228` 換過一次措辭，寫死的話每換一次就紅一次，而且會誘人把測試改成新的死值）
    expect(r.link).toEqual({ url: 'https://shop.example.com/o/A123', label: DEFAULT_REPLY_LINK_LABEL })
  })

  it('沒設連結就不帶 link 欄位（呼叫端據此決定要不要多送一則）', async () => {
    const s = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['嗨'], examples: [], priority: 50, next: 'r' },
      { id: 'r', type: 'reply', text: '你好', thenHandoff: false },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', s)
    const r = await startScript(s, UID, {}, db)
    expect(r.link).toBeUndefined()
  })

  it('只有連結、沒有文字也送得出去（自動回覆「開啟網址」動作的形狀）', async () => {
    const s = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['菜單'], examples: [], priority: 50, next: 'r' },
      { id: 'r', type: 'reply', text: '', linkUrl: 'https://shop.example.com/menu', linkLabel: '看菜單', thenHandoff: false },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', s)
    const r = await startScript(s, UID, {}, db)
    expect(r.replyText).toBe('')
    expect(r.link).toEqual({ url: 'https://shop.example.com/menu', label: '看菜單' })
  })
})

describe('腳本引擎：機器人模組步驟（＝自動回覆的「觸發機器人模組」）', () => {
  it('走到 module 步驟 → 回傳 moduleId 並收工；訊息由 caller 送（要判斷真人客服模組）', async () => {
    const s = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['選單'], examples: [], priority: 50, next: 'm' },
      { id: 'm', type: 'module', moduleId: 'flow123' },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', s)

    const r = await startScript(s, UID, {}, db)
    expect(r.moduleId).toBe('flow123')
    expect(r.replyText).toBe('')
    expect(r.finished).toBe(true)
    expect(r.completed).toBe(true)
    // 終點步驟：activeScript 要清掉，不能把客人卡在流程裡
    expect(activeScriptOf(store)).toBeUndefined()
  })

  it('收集完再送模組：模組前的貼標／寫屬性照常生效', async () => {
    const s = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['報名'], examples: [], priority: 50, next: 'c' },
      { id: 'c', type: 'collect', question: '姓名？', fieldName: 'name', expireMs: 600000, format: 'any', next: 'save' },
      { id: 'save', type: 'saveLead', fieldMap: [{ fromField: 'name', attrKey: '姓名' }], next: 'm' },
      { id: 'm', type: 'module', moduleId: 'flow_welcome' },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', s)

    await startScript(s, UID, {}, db)
    const r = await advanceScript(activeScriptOf(store)!, '王小明', {}, UID, db)
    expect(r.moduleId).toBe('flow_welcome')
    expect(attrsOf(store)['姓名']).toBe('王小明')
  })

  it('把這一輪收集到的答案一起帶出去——不然模組內容裡的 {{變數}} 會原樣印給客人', async () => {
    const s = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['查'], examples: [], priority: 50, next: 'c' },
      { id: 'c', type: 'collect', question: '訂單編號？', fieldName: 'order_id', expireMs: 600000, format: 'any', next: 'm' },
      { id: 'm', type: 'module', moduleId: 'flow_order' },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', s)

    await startScript(s, UID, {}, db)
    const r = await advanceScript(activeScriptOf(store)!, 'A123', {}, UID, db)
    expect(r.moduleId).toBe('flow_order')
    // 這一份是 caller 疊到客人資料上、拿去渲染模組訊息用的
    expect(r.collected).toEqual({ order_id: 'A123' })
  })
})

/**
 * 先撿（`C-343`）：2026-10-09 正式站兩位客人觸發「查詢訂單」那句就寫了訂單編號，
 * 流程照樣問「請問您的訂單編號是？」，客人只好再貼一次。這組驗「講過的就不再問」。
 */
describe('腳本引擎：客人前面講過的資料不再問', () => {
  // 跟正式站「查詢訂單」同形：問編號（可跳過）→ 寫名單 → 回覆＋轉真人
  const orderLookup = script([
    { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['訂單'], examples: [], priority: 50, next: 'c1' },
    { id: 'c1', type: 'collect', question: '您好,請問您的訂單編號是？', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', skipLabel: '我沒有訂單編號', skipNext: 'c4', next: 's1' },
    { id: 'c4', type: 'collect', question: '再麻煩您提供方便聯絡的電話號碼 📞', fieldName: 'phone', expireMs: 600000, format: 'phone', next: 's1' },
    { id: 's1', type: 'saveLead', fieldMap: [{ fromField: 'order_id', attrKey: '訂單編號' }, { fromField: 'phone', attrKey: '電話' }], next: 'r1' },
    { id: 'r1', type: 'reply', text: '已收到您的資訊（{{order_id}}），我們將盡快為您查詢並處理', thenHandoff: true },
  ])
  // 跟正式站「更改地址」同形：編號 → 姓名 → 電話 → 地址
  const changeAddress = script([
    { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['改地址'], examples: [], priority: 60, next: 'c_order' },
    { id: 'c_order', type: 'collect', question: '請先提供您的訂單編號', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', next: 'c_name' },
    { id: 'c_name', type: 'collect', question: '請問訂購人的大名？', fieldName: 'name', expireMs: 600000, format: 'any', next: 'c_phone' },
    { id: 'c_phone', type: 'collect', question: '再麻煩您提供方便聯絡的電話號碼 📞', fieldName: 'phone', expireMs: 600000, format: 'phone', next: 'c_addr' },
    { id: 'c_addr', type: 'collect', question: '最後，請提供完整的新地址', fieldName: 'address', expireMs: 600000, format: 'any', next: 'r1' },
    { id: 'r1', type: 'reply', text: '已收到', thenHandoff: true },
  ])

  it('觸發那句就有訂單編號 → 不問編號，直接寫名單、回覆、轉真人（10-09 釋戒乘那一場）', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', orderLookup)
    const r = await startScript(orderLookup, UID, {}, db, '訂單編號：M20261006142003LDEW，奇美電淨艙雙入組，請問何時才能出貨？')
    expect(r.replyText).toBe('已收到您的資訊（M20261006142003LDEW），我們將盡快為您查詢並處理')
    expect(r.finished).toBe(true)
    expect(r.thenHandoff).toBe(true)
    expect(attrsOf(store)['訂單編號']).toBe('M20261006142003LDEW')
    expect(activeScriptOf(store)).toBeUndefined()
  })

  it('沒帶觸發句（舊呼叫端／加好友）→ 照舊從第一題問起，狀態裡也不留空的 prefilled', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', orderLookup)
    const r = await startScript(orderLookup, UID, {}, db)
    expect(r.replyText).toBe('您好,請問您的訂單編號是？')
    expect('prefilled' in activeScriptOf(store)!).toBe(false)
  })

  it('觸發句只有沒問到的東西（型號）→ 照常問編號，型號不會被當成編號', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', orderLookup)
    const r = await startScript(orderLookup, UID, {}, db, '我訂的 AP-08SPFG 想查訂單')
    expect(r.replyText).toBe('您好,請問您的訂單編號是？')
  })

  it('撿到的跳過、中間沒講的照問：編號＋電話都先給了 → 只問姓名和地址', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', changeAddress)
    const r1 = await startScript(changeAddress, UID, {}, db, '我要改地址，訂單 M20261007002452KOYK，電話0982085948')
    expect(r1.replyText).toBe('請問訂購人的大名？')
    expect(activeScriptOf(store)?.prefilled).toEqual(['phone'])

    const r2 = await advanceScript(activeScriptOf(store)!, '白坤永', {}, UID, db)
    expect(r2.replyText).toBe('最後，請提供完整的新地址')
    expect(activeScriptOf(store)?.collected).toMatchObject({ order_id: 'M20261007002452KOYK', name: '白坤永', phone: '0982085948' })
    expect('prefilled' in activeScriptOf(store)!).toBe(false)
  })

  it('回答這一題時順便帶了後面的資料 → 後面那題也不問（10-09 白坤永那一則的貼法）', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', changeAddress)
    await startScript(changeAddress, UID, {}, db, '我要改地址')
    const r1 = await advanceScript(activeScriptOf(store)!, 'M20261007002452KOYK訂單編號\n名字白坤永\n電話0982085948', {}, UID, db)
    // 姓名是「不限格式」，從一整段裡撿不準 → 照問；電話撿到了 → 之後不問
    expect(r1.replyText).toBe('請問訂購人的大名？')
    const r2 = await advanceScript(activeScriptOf(store)!, '白坤永', {}, UID, db)
    expect(r2.replyText).toBe('最後，請提供完整的新地址')
  })

  it('流程刻意繞回同一題（電話對嗎？不對 → 重填）→ 第二次照問，不會永遠跳過', async () => {
    const confirmLoop = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['預約'], examples: [], priority: 50, next: 'c_phone' },
      { id: 'c_phone', type: 'collect', question: '請留電話', fieldName: 'phone', expireMs: 600000, format: 'phone', next: 'q' },
      { id: 'q', type: 'quickReply', question: '電話是 {{phone}} 對嗎？', expireMs: 600000, options: [{ label: '對', next: 'r' }, { label: '不對', next: 'c_phone' }] },
      { id: 'r', type: 'reply', text: '好的', thenHandoff: false },
    ])
    const { db, store } = makeDb()
    store.scripts.set('s1', confirmLoop)
    const r1 = await startScript(confirmLoop, UID, {}, db, '我要預約，電話0912345678')
    expect(r1.replyText).toBe('電話是 0912345678 對嗎？')
    const r2 = await advanceScript(activeScriptOf(store)!, '不對', {}, UID, db)
    expect(r2.replyText).toBe('請留電話')
  })
})

// ── `D-138`：走進來的紀錄、截圖當答案、停用即停、下班時間合成一則 ─────────────
describe('D-138 自動回應：客人那一端', () => {
  const order = script([
    { id: 't', type: 'trigger', matchMode: 'semantic', keywords: ['訂單'], examples: ['我想查訂單'], priority: 50, next: 'c_id' },
    { id: 'c_id', type: 'collect', question: '請問您的訂單編號是？', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', next: 'c_phone' },
    { id: 'c_phone', type: 'collect', question: '請留電話', fieldName: 'phone', expireMs: 600000, format: 'phone', next: 'save' },
    { id: 'save', type: 'saveLead', fieldMap: [{ fromField: 'order_id', attrKey: '訂單編號' }, { fromField: 'phone', attrKey: '電話' }], next: 'r' },
    { id: 'r', type: 'reply', text: '已收到您的訂單 {{order_id}}，謝謝您！', thenHandoff: true },
  ])
  const runsOf = (store: Store) => [...store.runs.values()]
  const OFF = { notice: '目前非客服服務時間，我們會在服務時間盡快回覆您 🙏', nextLine: '專員 10/22（四）10:00 起回覆您 🙏' }

  it('走進來記一筆：停在哪一題、重問幾次；走完標完成', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', order)
    await startScript(order, UID, { displayName: '王小明' }, db)
    expect(runsOf(store)).toHaveLength(1)
    expect(runsOf(store)[0]).toMatchObject({ userDocId: UID, displayName: '王小明', nodeId: 'c_id', status: 'active', reasks: 0 })
    // 帶客人名字的紀錄不能永遠留著：寫入就帶半年後的 expireAt，給 TTL policy 清（`C-379`）
    const keepDays = (runsOf(store)[0]!.expireAt.ms - runsOf(store)[0]!.startedAtMs) / 86_400_000
    expect(keepDays).toBe(180)
    expect(activeScriptOf(store)?.runId).toBeTruthy()

    await advanceScript(activeScriptOf(store)!, '找不到耶', {}, UID, db) // 格式不對 → 重問
    expect(runsOf(store)[0]).toMatchObject({ nodeId: 'c_id', reasks: 1, status: 'active' })
    await advanceScript(activeScriptOf(store)!, 'M20261004145559BRUE', {}, UID, db)
    expect(runsOf(store)[0]).toMatchObject({ nodeId: 'c_phone', status: 'active' })
    await advanceScript(activeScriptOf(store)!, '0912345678', {}, UID, db)
    expect(runsOf(store)[0]).toMatchObject({ status: 'completed' })
  })

  it('一步就回完的（打特定的字就回一句）不記紀錄', async () => {
    const { db, store } = makeDb()
    const oneLiner = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywordMatch: 'exact', keywords: ['抽獎'], examples: [], priority: 50, next: 'r' },
      { id: 'r', type: 'reply', text: '活動說明在這裡', thenHandoff: false },
    ])
    const r = await startScript(oneLiner, UID, {}, db)
    expect(r.completed).toBe(true)
    expect(runsOf(store)).toHaveLength(0)
  })

  it('喊找真人 → 紀錄標「按了找真人」；過期後下一則進來 → 標過期', async () => {
    {
      const { db, store } = makeDb()
      store.scripts.set('s1', order)
      await startScript(order, UID, {}, db)
      const r = await advanceScript(activeScriptOf(store)!, '轉接專員', {}, UID, db)
      expect(r.escapeToHuman).toBe(true) // `D-138`：10/13 客人打的就是這句
      expect(runsOf(store)[0]!.status).toBe('escaped')
    }
    {
      const { db, store } = makeDb()
      store.scripts.set('s1', order)
      await startScript(order, UID, {}, db)
      const stale = { ...activeScriptOf(store)!, expiresAt: Date.now() - 1 }
      await advanceScript(stale, 'M123456', {}, UID, db)
      expect(runsOf(store)[0]!.status).toBe('expired')
    }
  })

  it('停用之後，走到一半的客人下一句不再被流程接（交回主流程）', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', order)
    await startScript(order, UID, {}, db)
    store.scripts.set('s1', { ...order, enabled: false })
    const r = await advanceScript(activeScriptOf(store)!, 'M20261004145559BRUE', {}, UID, db)
    expect(r.finished).toBe(true)
    expect(r.replyText).toBe('')
    expect(activeScriptOf(store)).toBeUndefined()
    expect(runsOf(store)[0]!.status).toBe('stopped')
  })

  it('用截圖回答訂單編號 → 收下、往下一題；回覆帶「（圖片）」但不寫進客人資料', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', order)
    await startScript(order, UID, {}, db)
    const r1 = await advanceScript(activeScriptOf(store)!, '', {}, UID, db, { image: true })
    expect(r1.replyText).toBe('請留電話')
    expect(runsOf(store)[0]).toMatchObject({ nodeId: 'c_phone', imageAnswers: 1 })
    const r2 = await advanceScript(activeScriptOf(store)!, '0912345678', {}, UID, db)
    expect(r2.replyText).toBe('已收到您的訂單 （圖片），謝謝您！')
    expect(attrsOf(store)['電話']).toBe('0912345678')
    expect(attrsOf(store)['訂單編號']).toBeUndefined()
  })

  it('停在「給按鈕選」時傳圖不算回答（不前進、不清狀態）', async () => {
    const { db, store } = makeDb()
    const menu = script([
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['選單'], examples: [], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '需要什麼服務？', expireMs: 600000, options: [{ label: '查訂單', next: 'r' }] },
      { id: 'r', type: 'reply', text: '好的', thenHandoff: false },
    ])
    store.scripts.set('s1', menu)
    await startScript(menu, UID, {}, db)
    const r = await advanceScript(activeScriptOf(store)!, '', {}, UID, db, { image: true })
    expect(r.finished).toBe(false)
    expect(activeScriptOf(store)?.currentNodeId).toBe('q')
  })

  it('下班時間：第一題前面併「非客服服務時間」，最後那則保留自己的回覆、只補幾點起回覆', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', order)
    const r1 = await startScript(order, UID, {}, db, '', { offHours: OFF })
    expect(r1.replyText).toBe(`${OFF.notice}\n\n請問您的訂單編號是？`)
    expect(activeScriptOf(store)?.offHoursNoticed).toBe(true)
    const r2 = await advanceScript(activeScriptOf(store)!, 'M20261004145559BRUE', {}, UID, db, { offHours: OFF })
    expect(r2.replyText).toBe('請留電話') // 講過了，第二題不再講
    const r3 = await advanceScript(activeScriptOf(store)!, '0912345678', {}, UID, db, { offHours: OFF })
    expect(r3.replyText).toBe(`已收到您的訂單 M20261004145559BRUE，謝謝您！\n${OFF.nextLine}`)
    expect(r3.thenHandoff).toBe(true)
  })

  it('下班時間：上班時開始、走到最後才下班 → 最後那則補整句', async () => {
    const { db, store } = makeDb()
    store.scripts.set('s1', order)
    await startScript(order, UID, {}, db) // 上班時間
    await advanceScript(activeScriptOf(store)!, 'M20261004145559BRUE', {}, UID, db)
    const r = await advanceScript(activeScriptOf(store)!, '0912345678', {}, UID, db, { offHours: OFF })
    expect(r.replyText).toBe(`已收到您的訂單 M20261004145559BRUE，謝謝您！\n\n${OFF.notice}`)
  })

  it('下班時間：不會交給真人的流程（預約報名）不加那句——沒有人要等', async () => {
    const { db, store } = makeDb()
    const booking = script([
      { id: 't', type: 'trigger', matchMode: 'semantic', keywords: ['預約'], examples: [], priority: 50, next: 'c' },
      { id: 'c', type: 'collect', question: '請問您的大名？', fieldName: 'name', expireMs: 600000, format: 'any', next: 'r' },
      { id: 'r', type: 'reply', text: '已收到 {{name}}', thenHandoff: false },
    ])
    const r = await startScript(booking, UID, {}, db, '', { offHours: OFF })
    expect(r.replyText).toBe('請問您的大名？')
  })
})

describe('刪掉自動回應時，每次走進來的紀錄（帶客人名字）一起刪（`C-379`）', () => {
  /** 只認 scripts/{id}/runs 的 limit().get() 與 batch().delete()：一批最多刪幾筆照實記下 */
  function runsDb(ids: string[]) {
    const runs = new Map(ids.map(id => [id, { displayName: '王小明' }]))
    const batchSizes: number[] = []
    const db = {
      collection: (name: string) => ({
        doc: (scriptId: string) => ({
          collection: (sub: string) => ({
            limit: (n: number) => ({
              get: async () => {
                const docs = name === 'scripts' && scriptId === 's1' && sub === 'runs'
                  ? [...runs.keys()].slice(0, n).map(id => ({ ref: { id } }))
                  : []
                return { empty: docs.length === 0, docs }
              },
            }),
          }),
        }),
      }),
      batch: () => {
        const pending: string[] = []
        return {
          delete: (ref: { id: string }) => { pending.push(ref.id) },
          commit: async () => { batchSizes.push(pending.length); for (const id of pending) runs.delete(id) },
        }
      },
    }
    return { db: db as any, runs, batchSizes }
  }

  it('超過一批（900 筆）分三批刪完、一筆不留', async () => {
    const { db, runs, batchSizes } = runsDb(Array.from({ length: 900 }, (_, i) => `r${i}`))
    expect(await deleteScriptRuns(db, 's1')).toBe(900)
    expect(runs.size).toBe(0)
    expect(batchSizes).toEqual([400, 400, 100])
  })

  it('沒有紀錄 → 不送任何一批', async () => {
    const { db, batchSizes } = runsDb([])
    expect(await deleteScriptRuns(db, 's1')).toBe(0)
    expect(batchSizes).toEqual([])
  })
})
