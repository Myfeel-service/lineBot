import { describe, expect, it } from 'vitest'
import { batchKindLabel, batchRejectReasons, MAX_FILE_BATCH } from './kb-file-batch'

const f = (name: string, size = 1000) => ({ name, size })

describe('batchRejectReasons（一次好幾份：每一份收不收、為什麼）', () => {
  it('收得了的回空字串；收不了的每一份都講得出原因（⛔ 不可以默默少一份）', () => {
    const reasons = batchRejectReasons([f('價目表.xlsx'), f('舊說明.doc'), f('空的.pdf', 0), f('太大.pdf', 11 * 1024 * 1024)])
    expect(reasons[0]).toBe('')
    expect(reasons[1]).toMatch(/docx/) // 舊版 Word 要講怎麼辦（另存成 .docx），不是只說不支援
    expect(reasons[2]).toContain('空的檔案')
    expect(reasons[3]).toContain('10MB')
  })

  it('同一個檔放兩次只收第一份；不同大小的同名檔是兩份不同的檔，兩份都收', () => {
    expect(batchRejectReasons([f('a.pdf'), f('a.pdf')])).toEqual(['', '同一個檔放了兩次，只收一份'])
    expect(batchRejectReasons([f('a.pdf', 10), f('a.pdf', 20)])).toEqual(['', ''])
  })

  it('超過一次的上限：只算收得了的那幾份，排在後面的請他下一批再放', () => {
    const files = [f('壞的.doc'), ...Array.from({ length: MAX_FILE_BATCH + 1 }, (_, i) => f(`${i}.pdf`))]
    const reasons = batchRejectReasons(files)
    expect(reasons.filter(r => r === '')).toHaveLength(MAX_FILE_BATCH)
    expect(reasons.at(-1)).toContain('下一批')
  })
})

describe('batchKindLabel（清單最左邊那一格）', () => {
  it('收得了的用種類名稱、拿掉「文件／表格」兩個字', () => {
    expect(batchKindLabel('a.docx', 'Word 文件')).toBe('Word')
  })

  it('收不了的標副檔名；沒有副檔名寫「檔案」（⛔ 以前「README」會被截成「READM」）', () => {
    expect(batchKindLabel('說明.pages', null)).toBe('PAGES')
    expect(batchKindLabel('README', null)).toBe('檔案')
    expect(batchKindLabel('.env', null)).toBe('檔案')
    expect(batchKindLabel('結尾點.', null)).toBe('檔案')
  })
})
