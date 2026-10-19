import { describe, expect, it } from 'vitest'
import { HUMAN_FOLLOW_WINDOW_MS, humanFollowedAiTurns, humanReplyAfter, type ReplyLookupItem, type WrongPromptItem } from './ai-wrong-prompt'

const MIN = 60_000
/** 2026-09-29 09:12（台北）——時間是 0 會被當成「讀不到」，測試一律從真的時間點起算 */
const T = Date.UTC(2026, 8, 29, 1, 12)
let seq = 0
const msg = (over: Partial<WrongPromptItem> & { at: number }): WrongPromptItem => {
  const { at, ...rest } = over
  return { id: `m${++seq}`, type: 'message', direction: 'outgoing', atMs: T + at, ...rest }
}
const customer = (at: number) => msg({ direction: 'incoming', at })
const ai = (turnId: string, at: number) => msg({ sender: 'ai', aiTurnId: turnId, at })
const human = (at: number) => msg({ sender: 'human', at })

describe('humanFollowedAiTurns：「你接著回了客人——AI 這題答錯了嗎？」掛在哪', () => {
  it('AI 答完、真人接著回 → 掛在那則 AI 下面（09-29 NotePods：AI 說 9 月底、同事 3 小時後回 10 月中下旬）', () => {
    const a = ai('t1', 0)
    expect(humanFollowedAiTurns([customer(-MIN), a, human(192 * MIN)])).toEqual(new Map([['t1', a.id]]))
  })

  it('中間客人追問、事件列都跳過——真人回的仍是在接 AI 那一題', () => {
    const a = ai('t1', 0)
    const items = [a, customer(MIN), { id: 'e1', type: 'event', atMs: T + 2 * MIN }, human(3 * MIN)]
    expect(humanFollowedAiTurns(items).get('t1')).toBe(a.id)
  })

  it('🔴 AI 轉真人：下一則是機器人送的「已為您安排專員」→ 不掛（真人接手本來就該發生，不是更正）', () => {
    const items = [ai('t1', 0), msg({ sender: 'bot', at: 1000 }), human(5 * MIN)]
    expect(humanFollowedAiTurns(items).size).toBe(0)
  })

  it('AI 接著又回了一次（下一則是 AI）→ 前一則不掛；後一則後面接真人才掛', () => {
    const a2 = ai('t2', 2 * MIN)
    const out = humanFollowedAiTurns([ai('t1', 0), customer(MIN), a2, human(3 * MIN)])
    expect([...out.entries()]).toEqual([['t2', a2.id]])
  })

  it('同一回合送了兩則（文字＋圖）→ 只掛在最後一則下面、只掛一次', () => {
    const last = ai('t1', 1000)
    const out = humanFollowedAiTurns([ai('t1', 0), last, human(MIN)])
    expect([...out.entries()]).toEqual([['t1', last.id]])
  })

  it('超過 6 小時才回 → 不掛（多半在講別的事了）；剛好 6 小時算', () => {
    expect(humanFollowedAiTurns([ai('t1', 0), human(HUMAN_FOLLOW_WINDOW_MS + 1)]).size).toBe(0)
    expect(humanFollowedAiTurns([ai('t1', 0), human(HUMAN_FOLLOW_WINDOW_MS)]).size).toBe(1)
  })

  it('沒有 aiTurnId 的舊 AI 訊息、時間讀不到的 → 不掛（不猜）', () => {
    expect(humanFollowedAiTurns([msg({ sender: 'ai', at: 0 }), human(MIN)]).size).toBe(0)
    expect(humanFollowedAiTurns([{ ...ai('t1', 0), atMs: 0 }, human(MIN)]).size).toBe(0)
  })
})

describe('humanReplyAfter：帶進「補一條」／編輯視窗的那句（跟掛提示同一套規則）', () => {
  const said = (text: string, at: number, over: Partial<ReplyLookupItem> = {}): ReplyLookupItem =>
    ({ ...human(at), text, messageType: 'text', ...over })

  it('那一回合之後真人回的第一句', () => {
    const items = [ai('t1', 0), customer(MIN), said('廠商說 10 月中下旬出貨', 3 * MIN)]
    expect(humanReplyAfter(items, { turnId: 't1' })).toBe('廠商說 10 月中下旬出貨')
  })

  it('🔴 中間 AI 又答了下一題 → 不拿真人回下一題的話（/code-review：以前往後看 10 列不停，答案會張冠李戴）', () => {
    const items = [ai('t1', 0), customer(MIN), ai('t2', 2 * MIN), said('這是回 t2 那題的', 3 * MIN)]
    expect(humanReplyAfter(items, { turnId: 't1' })).toBe('')
    expect(humanReplyAfter(items, { turnId: 't2' })).toBe('這是回 t2 那題的')
  })

  it('真人先傳貼圖再打字 → 取那句字；超過 6 小時 → 不拿', () => {
    expect(humanReplyAfter([ai('t1', 0), said('', MIN, { messageType: 'sticker' }), said('好的我查一下', 2 * MIN)], { turnId: 't1' }))
      .toBe('好的我查一下')
    expect(humanReplyAfter([ai('t1', 0), said('隔天才回', HUMAN_FOLLOW_WINDOW_MS + 1)], { turnId: 't1' })).toBe('')
  })

  it('🔴 頂部卡片沒有回合（草稿模式 AI 沒送訊息）→ 從那次 AI 判斷的時間起算，⛔不退回好幾天前的 AI 訊息', () => {
    const oldAuto = ai('old', -3 * 86400_000)
    const items = [oldAuto, said('三天前回別的事', -3 * 86400_000 + MIN), customer(-MIN), said('這題的正確答案', 2 * MIN)]
    expect(humanReplyAfter(items, { turnId: '', sinceMs: T })).toBe('這題的正確答案')
    // 那個時間點之後真人還沒回 → 空的，不撿三天前那句
    expect(humanReplyAfter(items.slice(0, 3), { turnId: '', sinceMs: T })).toBe('')
    // 沒有時間也沒有回合 → 不猜
    expect(humanReplyAfter(items, { turnId: '' })).toBe('')
  })
})
