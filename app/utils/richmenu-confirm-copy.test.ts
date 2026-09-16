/**
 * 建立圖文選單的確認文案（`C-193`）。
 *
 * 這句話以前不分情況都說「所有好友的圖文選單會即時更新」——而沒設為預設的話，
 * 一個好友的畫面都不會變。講錯的代價是店家以為自己剛剛動到了所有客人的畫面。
 */
import { describe, expect, it } from 'vitest'
import { richMenuCreateConfirmCopy } from './richmenu-confirm-copy'

describe('建立前的確認文案', () => {
  it('🔴 沒有要設為預設：⛔不可以說會影響所有好友，要講「客人還看不到」', () => {
    const c = richMenuCreateConfirmCopy(false)
    expect(c.message).toContain('客人還看不到')
    expect(c.message).not.toContain('所有好友')
    expect(c.confirmButtonText).toBe('建立（先不上線）')
    expect(c.type).toBe('info')
  })

  it('要設為預設：就要照實說所有好友會立刻換', () => {
    const c = richMenuCreateConfirmCopy(true)
    expect(c.message).toContain('所有好友')
    expect(c.message).toContain('立刻')
    expect(c.confirmButtonText).toBe('建立並上線')
    expect(c.type).toBe('warning')
  })

  it('⛔ 兩種情況的按鈕字樣要分得開——把後果寫在按鈕上，不要都叫「確定」', () => {
    expect(richMenuCreateConfirmCopy(true).confirmButtonText)
      .not.toBe(richMenuCreateConfirmCopy(false).confirmButtonText)
    expect(richMenuCreateConfirmCopy(true).title).not.toBe(richMenuCreateConfirmCopy(false).title)
  })

  it('取消鈕兩邊一樣，且不是「取消」這種沒資訊的字', () => {
    for (const goesLive of [true, false])
      expect(richMenuCreateConfirmCopy(goesLive).cancelButtonText).toBe('再檢查一下')
  })
})
