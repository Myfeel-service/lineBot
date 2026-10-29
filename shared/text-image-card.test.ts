import { describe, expect, it } from 'vitest'
import { textImageAspect, textImageButtonStyle, textImageError, textMessageImageUrl } from './text-image-card'

describe('`C-416` 文字加圖的共用規則', () => {
  it('比例照原圖約分；量不到用正方形；比 1:3 長的收在 1:3（LINE 只收到高是寬的 3 倍）', () => {
    expect(textImageAspect(1040, 1040)).toEqual({ lineAspectRatio: '1:1', css: '1 / 1' })
    expect(textImageAspect(1920, 1080)).toEqual({ lineAspectRatio: '16:9', css: '16 / 9' })
    expect(textImageAspect(800, 1000)).toEqual({ lineAspectRatio: '4:5', css: '4 / 5' })
    expect(textImageAspect(0, 0).lineAspectRatio).toBe('1:1')
    expect(textImageAspect(undefined, 500).lineAspectRatio).toBe('1:1')
    expect(textImageAspect(300, 900).lineAspectRatio).toBe('1:3')
    expect(textImageAspect(300, 901).lineAspectRatio).toBe('1:3')
  })

  it('按鈕：沒存樣式＝綠色（新的路，沒有舊按鈕要維持）；明講 link 才是文字連結', () => {
    expect(textImageButtonStyle({})).toBe('primary')
    expect(textImageButtonStyle({ style: 'primary' })).toBe('primary')
    expect(textImageButtonStyle({ style: 'link' })).toBe('link')
  })

  it('圖網址只有空白＝沒放圖；沒放圖時標題不檢查', () => {
    expect(textMessageImageUrl({ imageUrl: '  ' })).toBe('')
    expect(textImageError({ imageUrl: '', title: '題'.repeat(200) })).toBe('')
    expect(textImageError({ imageUrl: 'https://a/b.jpg', title: '題'.repeat(81) })).toMatch(/標題最多 80 字/)
  })
})
