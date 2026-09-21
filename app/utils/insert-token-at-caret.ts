/**
 * 把 `{{displayName}}` 這種變數插到「游標停的地方」，不是一律接在最後面。
 *
 * 為什麼要改：文案十之八九長成「{{displayName}}您好，」——變數要放開頭。舊版一律
 * `current + token`，所以按了插入鈕之後還得自己滑到最後、把那串剪下來、貼回開頭。
 * 插入鈕愈方便，反而愈容易被當成「按了沒用」。
 *
 * ⛔ 抽成純函式是為了測得到邊界，尤其這兩個：
 *   1. **沒有游標**（使用者根本沒點進輸入框就按插入）要退回舊行為接在最後面。
 *      這裡不能用「selectionStart 是 0 就插最前面」——沒被點過的 textarea 它也是 0。
 *   2. **記下來的位置會過期**：下拉選單開著的時候文字被改短，start/end 就越界了，
 *      要夾回去，否則 slice 會把字吃掉。
 */

export interface CaretRange {
  /** 選取起點；沒有選取時＝游標位置 */
  start: number
  /** 選取終點；沒有選取時＝start */
  end: number
}

export interface TokenInsertResult {
  /** 插完的完整文字 */
  text: string
  /** 插完游標該停的位置（插進去那串的後面） */
  caret: number
}

/**
 * @param current 輸入框現在的文字（不是字串就當空字串，舊版本來就有這道防護）
 * @param token   要插進去的字串，例如 `{{displayName}}`
 * @param range   插入位置；`null`／`undefined`／壞掉的值一律當「沒有游標」→ 接在最後面
 */
export function insertTokenAtCaret(
  current: unknown,
  token: string,
  range?: CaretRange | null,
): TokenInsertResult {
  const text = typeof current === 'string' ? current : ''

  const rawStart = range?.start
  const rawEnd = range?.end
  // ⛔ 不可以寫成 `Number(range?.start)`：DOM 在不支援選取的欄位上回 `null`，
  //   而 `Number(null)` 是 0——那會變成「插到最前面」，比舊行為還糟。
  const hasCaret
    = typeof rawStart === 'number' && Number.isFinite(rawStart)
      && typeof rawEnd === 'number' && Number.isFinite(rawEnd)

  if (!hasCaret) {
    return { text: `${text}${token}`, caret: text.length + token.length }
  }

  const clamp = (n: number) => Math.min(Math.max(Math.trunc(n), 0), text.length)
  // 由右往左拖選時 start > end，先擺正再夾範圍
  const start = clamp(Math.min(rawStart, rawEnd))
  const end = clamp(Math.max(rawStart, rawEnd))

  // 有選取一段就直接取代掉——跟任何一個編輯器的貼上行為一致
  return {
    text: `${text.slice(0, start)}${token}${text.slice(end)}`,
    caret: start + token.length,
  }
}
