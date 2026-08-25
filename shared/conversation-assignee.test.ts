import { describe, expect, it } from 'vitest'
import { assigneeInitial, NO_ASSIGNEE, readConversationAssignee } from './conversation-assignee'

describe('負責人員：從對話文件讀出來（G-27 功能缺口②）', () => {
  it('沒有 assigneeUid 欄位 → 沒有人負責', () => {
    expect(readConversationAssignee(undefined)).toEqual(NO_ASSIGNEE)
    expect(readConversationAssignee({})).toEqual(NO_ASSIGNEE)
  })

  it('uid 是空白字串也算沒有人負責（不要讓清單畫出一顆沒有字的圓章）', () => {
    expect(readConversationAssignee({ assigneeUid: '   ', assigneeName: '王小明' })).toEqual(NO_ASSIGNEE)
  })

  it('讀得出 uid、名字與指派時間', () => {
    const assignedAt = { toMillis: () => 1_724_500_000_000 }
    expect(readConversationAssignee({
      assigneeUid: 'uid-1',
      assigneeName: '王小明',
      assignedAt,
    })).toEqual({ uid: 'uid-1', name: '王小明', assignedAtMs: 1_724_500_000_000 })
  })

  it('Firestore 的 _seconds 形狀也讀得出來（跨序列化邊界的舊資料）', () => {
    expect(readConversationAssignee({
      assigneeUid: 'uid-2',
      assigneeName: '陳大文',
      assignedAt: { _seconds: 1_724_500_000 },
    }).assignedAtMs).toBe(1_724_500_000_000)
  })
})

describe('清單圓章要印哪個字', () => {
  it('中文名取最後一個字——姓氏重複率太高，一排「王」分不出人', () => {
    expect(assigneeInitial('王小明')).toBe('明')
    expect(assigneeInitial('陳大文')).toBe('文')
    // 同姓的兩個人要印出不一樣的字，這顆章才有意義
    expect(assigneeInitial('王小明')).not.toBe(assigneeInitial('王大同'))
  })

  it('英文名取第一個字母並轉大寫', () => {
    expect(assigneeInitial('kevin')).toBe('K')
    expect(assigneeInitial('Amy Chen')).toBe('A')
  })

  it('只有 email 時取帳號的第一個字母（名字查不到時的退路）', () => {
    expect(assigneeInitial('kevin.chiang@myfeel-tw.com')).toBe('K')
  })

  it('空的／全空白 → 回空字串，呼叫端就不要畫那顆章', () => {
    expect(assigneeInitial('')).toBe('')
    expect(assigneeInitial('   ')).toBe('')
  })
})
