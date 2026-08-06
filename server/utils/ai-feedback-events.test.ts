import { describe, expect, it } from 'vitest'
import {
  aggregateWrongAnswerMarks,
  aiFeedbackDocId,
  isChunkUnfixedSinceMark,
} from './ai-feedback-events'

const BASE = { workspaceId: 'ws1', userId: 'ws1__U123', type: 'wrong_answer' as const }

/**
 * doc id 是「這一次標過了嗎 / 把它取消掉」唯一的依據——算不出同一個 id 就等於那筆標記消失。
 * 所以兩件事必須守住：新舊兩種識別各自穩定，且**互不影響**。
 */
describe('aiFeedbackDocId', () => {
  it('同一回合算出來的 id 一樣（重複標記覆寫同一筆，不會把缺口計數灌大）', () => {
    const a = aiFeedbackDocId({ ...BASE, turnId: 'turnAAA' })
    const b = aiFeedbackDocId({ ...BASE, turnId: 'turnAAA' })
    expect(a).toBe(b)
  })

  it('不同回合是不同筆', () => {
    expect(aiFeedbackDocId({ ...BASE, turnId: 'turnAAA' }))
      .not.toBe(aiFeedbackDocId({ ...BASE, turnId: 'turnBBB' }))
  })

  it('有 turnId 就不看 interactionAtMs——回合是穩定的，時間戳不該再影響結果', () => {
    // 這正是治本的重點：客人之後又問幾題（aiMeta 被覆寫）都不會改變這筆的 id
    expect(aiFeedbackDocId({ ...BASE, turnId: 'turnAAA', interactionAtMs: 111 }))
      .toBe(aiFeedbackDocId({ ...BASE, turnId: 'turnAAA', interactionAtMs: 999 }))
  })

  it('沒有 turnId 時退回舊的時間戳規則，且格式與舊資料完全一致', () => {
    // 換規則卻不相容 = 上線前標記過的那些人，取消鈕全部失效
    expect(aiFeedbackDocId({ ...BASE, interactionAtMs: 1700000000000 }))
      .toBe('wrong_answer_ws1_ws1__U123_1700000000000')
  })

  it('turnId 與時間戳算出來的是不同筆（新舊識別不會互相蓋掉）', () => {
    expect(aiFeedbackDocId({ ...BASE, turnId: 'turnAAA' }))
      .not.toBe(aiFeedbackDocId({ ...BASE, interactionAtMs: 1700000000000 }))
  })

  it('type 不同就是不同筆（答錯與採用草稿是兩種訊號）', () => {
    expect(aiFeedbackDocId({ ...BASE, type: 'draft_applied', turnId: 'turnAAA' }))
      .not.toBe(aiFeedbackDocId({ ...BASE, turnId: 'turnAAA' }))
  })

  it('id 不含 Firestore 不允許的字元（userId / turnId 都要洗過）', () => {
    const id = aiFeedbackDocId({
      workspaceId: 'ws1',
      userId: 'ws1/U123',
      type: 'wrong_answer',
      turnId: 'turn/with/slash',
    })
    expect(id).not.toContain('/')
  })
})

const W = (over: Partial<{ type: string; chunkIds: string[]; createdAtMs: number }> = {}) => ({
  type: 'wrong_answer',
  chunkIds: ['chunk-a'],
  createdAtMs: 1_000,
  ...over,
})

/**
 * 工作台「被標記 AI 答錯了」那一列的口徑。知識庫工作台與右下角小幫手共用這兩支，
 * 兩邊算出不同的數字＝小幫手說沒事、工作台卻紅著，是最傷信任的那種矛盾。
 */
describe('aggregateWrongAnswerMarks', () => {
  it('按卡聚合：同一張被標三次是一列、次數 3', () => {
    const m = aggregateWrongAnswerMarks(
      [W({ createdAtMs: 1_000 }), W({ createdAtMs: 2_000 }), W({ createdAtMs: 3_000 })],
      0,
    )
    expect(m.size).toBe(1)
    expect(m.get('chunk-a')).toEqual({ count: 3, lastMarkedAtMs: 3_000 })
  })

  it('一次標記命中多張卡 → 每一張都算一次（每張都可能是答錯的來源）', () => {
    const m = aggregateWrongAnswerMarks([W({ chunkIds: ['chunk-a', 'chunk-b'] })], 0)
    expect(m.get('chunk-a')!.count).toBe(1)
    expect(m.get('chunk-b')!.count).toBe(1)
  })

  it('窗口外的舊標記不算（與建議收件匣同樣看近 30 天）', () => {
    const m = aggregateWrongAnswerMarks([W({ createdAtMs: 500 })], 1_000)
    expect(m.size).toBe(0)
  })

  it('採用草稿（draft_applied）不是答錯訊號', () => {
    expect(aggregateWrongAnswerMarks([W({ type: 'draft_applied' })], 0).size).toBe(0)
  })

  it('沒有命中知識卡的答錯不列：沒有卡可修，列了就是一條死路', () => {
    expect(aggregateWrongAnswerMarks([W({ chunkIds: [] })], 0).size).toBe(0)
  })
})

describe('isChunkUnfixedSinceMark', () => {
  const mark = { count: 2, lastMarkedAtMs: 5_000 }

  it('標記之後沒人動過 → 還要處理', () => {
    expect(isChunkUnfixedSinceMark(4_000, mark)).toBe(true)
  })

  it('標記之後有人改過 → 自動離開清單（不必另外按「已處理」）', () => {
    expect(isChunkUnfixedSinceMark(6_000, mark)).toBe(false)
  })

  it('卡沒有 updatedAt（讀不到時間）→ 當成沒改過，寧可多列一筆也不要漏掉答錯的卡', () => {
    expect(isChunkUnfixedSinceMark(0, mark)).toBe(true)
  })
})
