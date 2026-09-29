/**
 * 建立圖文選單的確認文案（`C-193`）。
 *
 * 這句話以前不分情況都說「所有好友的圖文選單會即時更新」——而沒設為預設的話，
 * 一個好友的畫面都不會變。講錯的代價是店家以為自己剛剛動到了所有客人的畫面。
 */
import { describe, expect, it } from 'vitest'
import { richMenuCreateConfirmCopy, richMenuSetDefaultConfirmCopy } from './richmenu-confirm-copy'

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

  it('🔴 先不上線那句要指向**真的存在**的按鈕（`D-109`：以前叫人去清單上設，清單沒有那顆）', () => {
    const c = richMenuCreateConfirmCopy(false)
    expect(c.message).not.toContain('清單上')
    expect(c.message).toContain('設為預設（上線）')
  })
})

describe('「設為預設（上線）」前的確認文案（`D-109`）', () => {
  it('講清楚所有好友會立刻換，後果寫在按鈕上', () => {
    const c = richMenuSetDefaultConfirmCopy({ name: '中秋選單', hasUnsavedChanges: false })
    expect(c.message).toContain('「中秋選單」')
    expect(c.message).toContain('所有好友')
    expect(c.confirmButtonText).toBe('設為預設並上線')
    expect(c.type).toBe('warning')
    expect(c.message).not.toContain('還沒存')
  })

  it('⛔ 有沒存的改動要講：上線的是存好的那一版，不是畫面上這一版', () => {
    const c = richMenuSetDefaultConfirmCopy({ name: '中秋選單', hasUnsavedChanges: true })
    expect(c.message).toContain('還沒存')
    expect(c.message).toContain('存好的那一版')
  })
})
