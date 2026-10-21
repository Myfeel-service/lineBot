import { describe, expect, it } from 'vitest'
import { diffPageLines, normalizePageLink, pageChangeIsLarge, splitPageLines } from './page-line-diff'

// MYFEEL 首頁真實的行格式（2026-10-21 抓的，`extractUrlText` 把連結寫成「文字（網址）」）
const SHARP_LINE = ' SHARP 2026 最新機種 ✨ SHARP「乾淨方MAX」 雙氣流智慧變頻美學清淨除濕機 (DW-UX22FT) 人數達標解鎖更多獎勵！ NT$ 0 9,895,800 / 每月 9,896 % 10 天 即將上市 0 432 人支持 / 每月 10 天（https://www.myfeel-tw.com/projects/DW-UX22FT） '

describe('normalizePageLink', () => {
  it('host 小寫、去尾斜線、去 query', () => {
    expect(normalizePageLink('https://WWW.myfeel-tw.com/projects/DW-UX22FT/?ref=home#x')).toBe('www.myfeel-tw.com/projects/DW-UX22FT')
  })
  it('不是網址回 null', () => {
    expect(normalizePageLink('mailto:a@b.c')).toBeNull()
    expect(normalizePageLink('不是網址')).toBeNull()
  })
})

describe('splitPageLines', () => {
  it('抓出這一行的連結、給人看的那行拿掉網址', () => {
    const [l] = splitPageLines(SHARP_LINE, { ignoreNumbers: true })
    expect(l!.links).toEqual(['www.myfeel-tw.com/projects/DW-UX22FT'])
    expect(l!.display).not.toContain('https://')
    expect(l!.display.startsWith('SHARP 2026 最新機種')).toBe(true)
  })
  it('數字會跳的網址：數字抹掉再比', () => {
    const a = splitPageLines('NT$ 9,895,800 / 432 人支持', { ignoreNumbers: true })
    const b = splitPageLines('NT$ 9,912,300 / 440 人支持', { ignoreNumbers: true })
    expect(a[0]!.key).toBe(b[0]!.key)
  })
  it('數字不會跳的網址：數字照比（改價就是那一行變了）', () => {
    const a = splitPageLines('售價 1,000 元', { ignoreNumbers: false })
    const b = splitPageLines('售價 1,200 元', { ignoreNumbers: false })
    expect(a[0]!.key).not.toBe(b[0]!.key)
  })
  it('一兩個字的行與重複的行不算', () => {
    expect(splitPageLines('Q\n \n運費說明\n運費說明', { ignoreNumbers: false }).map(l => l.key)).toEqual(['運費說明'])
  })
})

describe('diffPageLines', () => {
  it('順序換了不算改（首頁商品換位置不是改版）', () => {
    const d = diffPageLines('甲商品\n乙商品\n丙商品', '丙商品\n甲商品\n乙商品', { ignoreNumbers: false })
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
  })
  it('空白多寡不算改', () => {
    const d = diffPageLines('滿 1000 元  免運', '  滿 1000 元 免運 ', { ignoreNumbers: false })
    expect(d.added.length + d.removed.length).toBe(0)
  })
  it('多了、少了的行各自列出', () => {
    const d = diffPageLines('甲商品\n乙商品', '甲商品\n丁商品', { ignoreNumbers: false })
    expect(d.added.map(l => l.key)).toEqual(['丁商品'])
    expect(d.removed.map(l => l.key)).toEqual(['乙商品'])
  })
  it('只有數字在跳的集資頁＝一行都沒改', () => {
    const d = diffPageLines(SHARP_LINE, SHARP_LINE.replace('9,895,800', '9,990,100').replace('432 人', '441 人'), { ignoreNumbers: true })
    expect(d.added.length + d.removed.length).toBe(0)
  })
})

describe('pageChangeIsLarge', () => {
  const lines = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}第${i}行內容`).join('\n')
  it('改了超過一半而且至少 10 行＝大改', () => {
    expect(pageChangeIsLarge(diffPageLines(lines(20, '舊'), lines(20, '新'), { ignoreNumbers: false }))).toBe(true)
  })
  it('小頁面全改了也不算（不到 10 行）', () => {
    expect(pageChangeIsLarge(diffPageLines(lines(4, '舊'), lines(4, '新'), { ignoreNumbers: false }))).toBe(false)
  })
  it('首頁換了 15 個商品、共 50 行＝不算大改', () => {
    const base = lines(50, '舊')
    const cur = [...base.split('\n').slice(0, 35), ...lines(15, '新').split('\n')].join('\n')
    expect(pageChangeIsLarge(diffPageLines(base, cur, { ignoreNumbers: false }))).toBe(false)
  })
})
