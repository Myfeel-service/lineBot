import { describe, expect, it, vi } from 'vitest'
import {
  aggregateWrongAnswerMarks,
  aiFeedbackDocId,
  chunkContentFingerprint,
  chunkSnippet,
  isChunkUnfixedSinceMark,
  markFeedbackHandled,
  NOT_MARKED,
  pendingMarks,
  toPendingMarkEvent,
  wrongMarkOf,
  type PendingMarkEvent,
  type WrongAnswerMarkEvent,
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

const W = (over: Partial<WrongAnswerMarkEvent> = {}): WrongAnswerMarkEvent => ({
  type: 'wrong_answer',
  reason: 'wrong_data',
  pickedChunks: [{ chunkId: 'chunk-a', contentHash: 'h1' }],
  createdAtMs: 1_000,
  ...over,
})

/**
 * 工作台「被同事標記寫錯了」那一列的口徑。知識庫工作台與右下角小幫手共用這兩支，
 * 兩邊算出不同的數字＝小幫手說沒事、工作台卻紅著，是最傷信任的那種矛盾。
 */
describe('aggregateWrongAnswerMarks', () => {
  it('按卡聚合：同一條被標三次是一列、次數 3，指紋留最後一次的', () => {
    const m = aggregateWrongAnswerMarks(
      [
        W({ createdAtMs: 3_000, pickedChunks: [{ chunkId: 'chunk-a', contentHash: 'h3' }] }),
        W({ createdAtMs: 1_000, pickedChunks: [{ chunkId: 'chunk-a', contentHash: 'h1' }] }),
        W({ createdAtMs: 2_000, pickedChunks: [{ chunkId: 'chunk-a', contentHash: 'h2' }] }),
      ],
      0,
    )
    expect(m.size).toBe(1)
    expect(m.get('chunk-a')).toEqual({ count: 3, lastMarkedAtMs: 3_000, contentHash: 'h3' })
  })

  it('🔴 只算客服選出來的那一條：當時撈到的其他條不列（`D-135`：以前一按就把撈到的全部標紅）', () => {
    // chunkIds 是舊欄位、記的是撈到的全部；聚合只看 pickedChunks
    const m = aggregateWrongAnswerMarks([{ ...W(), chunkIds: ['chunk-a', 'chunk-b', 'chunk-c'] } as WrongAnswerMarkEvent], 0)
    expect([...m.keys()]).toEqual(['chunk-a'])
  })

  it('🔴 錯在別的地方（資料沒錯是 AI 弄錯了／知識庫沒寫／該交給真人）不列進知識庫待辦', () => {
    for (const reason of ['ai_mistake', 'missing', 'should_handoff']) {
      expect(aggregateWrongAnswerMarks([W({ reason })], 0).size).toBe(0)
    }
  })

  it('🔴 舊標記（沒有 reason）不算：那時候不問錯在哪，算進來就回到「全部標紅」', () => {
    expect(aggregateWrongAnswerMarks([W({ reason: undefined })], 0).size).toBe(0)
  })

  it('選了「資料寫錯」但還沒選是哪一條 → 不列（沒有條可修，列了是死路）', () => {
    expect(aggregateWrongAnswerMarks([W({ pickedChunks: undefined })], 0).size).toBe(0)
    expect(aggregateWrongAnswerMarks([W({ pickedChunks: [{ chunkId: ' ' }] })], 0).size).toBe(0)
  })

  it('窗口外的舊標記不算（與建議收件匣同樣看近 30 天）', () => {
    const m = aggregateWrongAnswerMarks([W({ createdAtMs: 500 })], 1_000)
    expect(m.size).toBe(0)
  })

  it('採用草稿（draft_applied）不是答錯訊號', () => {
    expect(aggregateWrongAnswerMarks([W({ type: 'draft_applied' })], 0).size).toBe(0)
  })
})

describe('isChunkUnfixedSinceMark（看內容指紋，不看更新時間）', () => {
  const content = '小滑手咖啡機第二批 11/20 出貨。'
  const mark = { count: 2, lastMarkedAtMs: 5_000, contentHash: chunkContentFingerprint(content) }

  it('🔴 內容沒變 → 還要處理，就算只改了標題、重新學習過（10/13 改了標題紅色就全消失）', () => {
    // 那幾種只會動 updatedAt；這支根本不看時間，內容一字未改就不算修好
    expect(isChunkUnfixedSinceMark({ content, updatedAt: 99_999 } as never, mark)).toBe(true)
  })

  it('只多了空白、換行 → 不算改（多按一次 Enter 不等於修好）', () => {
    expect(isChunkUnfixedSinceMark({ content: `  ${content.replace('第二批', '第二批\n\n')}  ` }, mark)).toBe(true)
  })

  it('內容真的改了 → 自動離開清單（不必另外按「已處理」）', () => {
    expect(isChunkUnfixedSinceMark({ content: '小滑手咖啡機第二批 12/05 出貨。' }, mark)).toBe(false)
  })

  it('標記時沒拿到指紋（讀不到那條）→ 當成還沒改，寧可多掛著也不要假裝修好', () => {
    expect(isChunkUnfixedSinceMark({ content: '任何內容' }, { ...mark, contentHash: '' })).toBe(true)
  })

  it('🔴 進了回收桶（刪掉、換新版換掉）→ 不算還沒改，就算內容一字未動（/code-review：以前小幫手一直紅、工作台卻是空的）', () => {
    expect(isChunkUnfixedSinceMark({ content, isDeleted: true, deletedAt: { seconds: 1 } }, mark)).toBe(false)
    // 舊資料只有 deletedAt
    expect(isChunkUnfixedSinceMark({ content, deletedAt: { seconds: 1 } }, mark)).toBe(false)
    // 沒拿到指紋的也一樣：AI 已經不用它了
    expect(isChunkUnfixedSinceMark({ content, deletedAt: { seconds: 1 } }, { ...mark, contentHash: '' })).toBe(false)
  })
})

/**
 * 兩種「記下來了」的標記要有人看（`D-136`）：AI 弄錯了→超管清單、交給真人→敏感詞卡。
 * 以前畫面說「記下來了」卻沒有任何地方會再出現。
 */
describe('pendingMarks：還沒處理的那幾筆', () => {
  const E = (over: Partial<PendingMarkEvent>): PendingMarkEvent => ({
    id: 'e1', workspaceId: 'ws1', userId: 'ws1_U1', type: 'wrong_answer', reason: 'should_handoff',
    query: '請問有進行退款了嗎？', createdAtMs: 5_000, handled: false, ...over,
  })

  it('只列那一種原因、還沒處理的，新的在前', () => {
    const out = pendingMarks([
      E({ id: 'old', createdAtMs: 1_000 }),
      E({ id: 'new', createdAtMs: 9_000 }),
      E({ id: 'done', handled: true }),
      E({ id: 'other', reason: 'ai_mistake' }),
      E({ id: 'draft', type: 'draft_applied' }),
      E({ id: 'legacy', reason: undefined }),
    ], 'should_handoff')
    expect(out.map(m => m.id)).toEqual(['new', 'old'])
    expect(out[0]).toEqual({ id: 'new', workspaceId: 'ws1', userId: 'ws1_U1', query: '請問有進行退款了嗎？', createdAtMs: 9_000 })
  })

  it('窗口外的不列', () => {
    expect(pendingMarks([E({ createdAtMs: 500 })], 'should_handoff', 1_000)).toEqual([])
  })

  it('從 Firestore 文件讀：handledAt 有值＝處理好了', () => {
    const doc = (data: Record<string, unknown>) => ({ id: 'x', data: () => data })
    expect(toPendingMarkEvent(doc({ type: 'wrong_answer', reason: 'ai_mistake', createdAt: { seconds: 3 } })))
      .toMatchObject({ id: 'x', reason: 'ai_mistake', createdAtMs: 3_000, handled: false })
    expect(toPendingMarkEvent(doc({ handledAt: { seconds: 9 } })).handled).toBe(true)
  })
})

describe('markFeedbackHandled', () => {
  function fakeDb(data: Record<string, unknown> | null) {
    const update = vi.fn(async () => {})
    const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: !!data, data: () => data }), update }) }) }
    return { db: db as unknown as Parameters<typeof markFeedbackHandled>[0], update }
  }

  it('原因對、工作區對 → 蓋 handledAt＋誰處理的', async () => {
    const { db, update } = fakeDb({ type: 'wrong_answer', reason: 'should_handoff', workspaceId: 'ws1' })
    expect(await markFeedbackHandled(db, 'e1', { reason: 'should_handoff', workspaceId: 'ws1', uid: 'admin-1' })).toBe(true)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ handledBy: 'admin-1', handledAt: expect.anything() }))
  })

  it('🔴 原因對不上 → 不蓋（不能借「交給真人」那支把「資料寫錯」的待辦收掉）', async () => {
    const { db, update } = fakeDb({ type: 'wrong_answer', reason: 'wrong_data', workspaceId: 'ws1' })
    expect(await markFeedbackHandled(db, 'e1', { reason: 'should_handoff', workspaceId: 'ws1', uid: 'a' })).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('🔴 別家的 → 不蓋；不存在、id 有斜線 → false', async () => {
    const other = fakeDb({ type: 'wrong_answer', reason: 'should_handoff', workspaceId: 'ws2' })
    expect(await markFeedbackHandled(other.db, 'e1', { reason: 'should_handoff', workspaceId: 'ws1', uid: 'a' })).toBe(false)
    expect(other.update).not.toHaveBeenCalled()
    expect(await markFeedbackHandled(fakeDb(null).db, 'e1', { reason: 'should_handoff', uid: 'a' })).toBe(false)
    expect(await markFeedbackHandled(fakeDb({}).db, 'a/b', { reason: 'should_handoff', uid: 'a' })).toBe(false)
  })

  it('超管那支不給工作區（跨帳號）也蓋得到', async () => {
    const { db, update } = fakeDb({ type: 'wrong_answer', reason: 'ai_mistake', workspaceId: 'ws9' })
    expect(await markFeedbackHandled(db, 'e1', { reason: 'ai_mistake', uid: 'super' })).toBe(true)
    expect(update).toHaveBeenCalled()
  })
})

describe('wrongMarkOf / chunkSnippet', () => {
  it('沒標＝NOT_MARKED；有標但沒原因（舊標記）＝reason null；原因亂寫也當 null', () => {
    expect(wrongMarkOf({ exists: false, data: () => undefined })).toBe(NOT_MARKED)
    expect(wrongMarkOf({ exists: true, data: () => ({}) })).toEqual({ marked: true, reason: null })
    expect(wrongMarkOf({ exists: true, data: () => ({ reason: 'oops' }) })).toEqual({ marked: true, reason: null })
    expect(wrongMarkOf({ exists: true, data: () => ({ reason: 'missing' }) })).toEqual({ marked: true, reason: 'missing' })
  })

  it('內容壓成一行、超過 40 字截斷加「…」；沒有內容＝空字串', () => {
    expect(chunkSnippet('第一行\n\n第二行')).toBe('第一行 第二行')
    expect(chunkSnippet('字'.repeat(41))).toBe(`${'字'.repeat(40)}…`)
    expect(chunkSnippet('字'.repeat(40))).toBe('字'.repeat(40))
    expect(chunkSnippet(undefined)).toBe('')
  })
})
