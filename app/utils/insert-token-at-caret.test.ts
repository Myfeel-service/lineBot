/**
 * 變數插到游標位置（機器人模組的 `{{...}}` 鈕）。
 * 釘住三條會讓使用者覺得「按了更糟」的邊界：沒有游標要接在最後面（舊行為）、
 * `selectionStart` 回 null 不可以被讀成 0、記下來的位置過期了要夾回去別把字吃掉。
 */
import { describe, expect, it } from 'vitest'
import { insertTokenAtCaret } from './insert-token-at-caret'

const TOKEN = '{{displayName}}'

describe('insertTokenAtCaret', () => {
  it('游標在中間 → 插在中間，游標停在變數後面', () => {
    const r = insertTokenAtCaret('您好，請問要寄到哪', TOKEN, { start: 3, end: 3 })
    expect(r.text).toBe(`您好，${TOKEN}請問要寄到哪`)
    expect(r.caret).toBe(3 + TOKEN.length)
  })

  it('游標在最前面 → 插在最前面（這才是使用者真正要的：「{{名字}}您好」）', () => {
    const r = insertTokenAtCaret('您好', TOKEN, { start: 0, end: 0 })
    expect(r.text).toBe(`${TOKEN}您好`)
    expect(r.caret).toBe(TOKEN.length)
  })

  /**
   * 🔴 沒點進輸入框就直接按插入鈕：這時候沒有游標可言，要維持舊行為接在最後面。
   * ⛔ 這裡最容易寫錯成「插到第 0 個字」——沒被點過的 textarea `selectionStart` 也是 0，
   *   所以「有沒有游標」必須是呼叫端判斷後傳進來的事實，不能從數字反推。
   */
  it('🔴 沒有游標 → 接在最後面（舊行為）', () => {
    expect(insertTokenAtCaret('您好', TOKEN).text).toBe(`您好${TOKEN}`)
    expect(insertTokenAtCaret('您好', TOKEN, null).text).toBe(`您好${TOKEN}`)
    expect(insertTokenAtCaret('您好', TOKEN, undefined).caret).toBe(2 + TOKEN.length)
  })

  /** ⛔ DOM 在不支援選取的欄位上回 `null`；`Number(null)` 是 0，照插就會插到最前面 */
  it('🔴 selectionStart 是 null → 當成沒有游標，不可以讀成 0', () => {
    const range = { start: null, end: null } as unknown as { start: number, end: number }
    expect(insertTokenAtCaret('您好', TOKEN, range).text).toBe(`您好${TOKEN}`)
  })

  it('NaN／字串等壞掉的值 → 當成沒有游標', () => {
    expect(insertTokenAtCaret('您好', TOKEN, { start: Number.NaN, end: Number.NaN }).text)
      .toBe(`您好${TOKEN}`)
    expect(insertTokenAtCaret('您好', TOKEN, { start: '1', end: '1' } as unknown as { start: number, end: number }).text)
      .toBe(`您好${TOKEN}`)
  })

  it('有選取一段 → 取代掉那段（跟一般編輯器的貼上一致）', () => {
    const r = insertTokenAtCaret('您好王小明先生', TOKEN, { start: 2, end: 5 })
    expect(r.text).toBe(`您好${TOKEN}先生`)
    expect(r.caret).toBe(2 + TOKEN.length)
  })

  it('由右往左拖選（start > end）→ 擺正再取代', () => {
    const r = insertTokenAtCaret('您好王小明先生', TOKEN, { start: 5, end: 2 })
    expect(r.text).toBe(`您好${TOKEN}先生`)
    expect(r.caret).toBe(2 + TOKEN.length)
  })

  /** 下拉開著的時候文字被改短了：越界的位置要夾回結尾，不可以 slice 出多餘的東西 */
  it('🔴 記下來的位置已經超過文字長度 → 夾到結尾，不會吃掉字或冒出 undefined', () => {
    const r = insertTokenAtCaret('您好', TOKEN, { start: 99, end: 120 })
    expect(r.text).toBe(`您好${TOKEN}`)
    expect(r.caret).toBe(2 + TOKEN.length)
    expect(r.text).not.toContain('undefined')
  })

  it('負數位置 → 夾到 0', () => {
    expect(insertTokenAtCaret('您好', TOKEN, { start: -5, end: -1 }).text).toBe(`${TOKEN}您好`)
  })

  it('空字串 → 就是變數本身', () => {
    const r = insertTokenAtCaret('', TOKEN, { start: 0, end: 0 })
    expect(r.text).toBe(TOKEN)
    expect(r.caret).toBe(TOKEN.length)
  })

  it('原本的值不是字串（undefined／數字）→ 當空字串處理，別印出 "undefined"', () => {
    expect(insertTokenAtCaret(undefined, TOKEN, { start: 0, end: 0 }).text).toBe(TOKEN)
    expect(insertTokenAtCaret(null, TOKEN).text).toBe(TOKEN)
    expect(insertTokenAtCaret(123, TOKEN).text).toBe(TOKEN)
  })

  it('小數位置（不該發生，但別 slice 出半個字）', () => {
    const r = insertTokenAtCaret('您好嗎', TOKEN, { start: 1.7, end: 1.7 })
    expect(r.text).toBe(`您${TOKEN}好嗎`)
  })
})
