import { describe, expect, it } from 'vitest'
import { pickFolderForSource } from './knowledge-folder-match'

/**
 * 案例全部取自 MYFEEL 正式資料（2026-09-04 唯讀盤查）：
 * 十五個資料夾、十幾份說明書，只有 Kieslect 那三份落在未分類。
 */
const MYFEEL_FOLDERS = [
  { id: 'f_lili', name: '粒粒安' },
  { id: 'f_kies', name: 'Kieselect 小耳記 AI NotePods 10S' }, // 資料夾名字本身就打錯字（Kieselect）
  { id: 'f_boya', name: 'BOYA mini2' },
  { id: 'f_ibar', name: 'iBarista' },
  { id: 'f_lamp', name: '兩全奇美燈' },
  { id: 'f_pot', name: '零水鍋' },
  { id: 'f_all', name: '總覽' },
  { id: 'f_sharp', name: 'SHARP 自動調理零水鍋' },
  { id: 'f_grip', name: '猩猩仙人之握' },
  { id: 'f_mate', name: 'MATELASER' },
  { id: 'f_poke', name: 'Poketomo' },
  { id: 'f_cheer', name: 'Cheerble' },
  { id: 'f_dry', name: '上好ㄟ抽取式除濕機' },
  { id: 'f_cs', name: '客服' },
  { id: 'f_gplus', name: 'GPLUS 居不可濕' },
]

describe('pickFolderForSource', () => {
  it('資料夾名字打錯字也要認得出來（Kieselect vs Kieslect）', () => {
    // 這就是災情本身：店家去 Kieselect 資料夾找說明書，說明書卻在未分類
    const m = pickFolderForSource(MYFEEL_FOLDERS, {
      sourceName: 'KIESLECT 小耳記 說明書.pdf',
      productName: 'Kieslect AI NotePods 10S',
    })
    expect(m?.folderId).toBe('f_kies')
  })

  it('原始那兩份重複檔名也對得上同一個資料夾', () => {
    const m = pickFolderForSource(MYFEEL_FOLDERS, {
      sourceName: 'AI NotePods 10S小耳記 耳機說明書_20260723.pdf',
      productName: 'Kieslect 小耳記 AI NotePods 10S 耳機',
    })
    expect(m?.folderId).toBe('f_kies')
  })

  it('其他產品的說明書各自對到自己的資料夾', () => {
    expect(pickFolderForSource(MYFEEL_FOLDERS, { sourceName: 'BOYA mini 2 說明書.pdf' })?.folderId).toBe('f_boya')
    expect(pickFolderForSource(MYFEEL_FOLDERS, { sourceName: '猩猩仙人之握-說明書.pdf' })?.folderId).toBe('f_grip')
    expect(pickFolderForSource(MYFEEL_FOLDERS, { sourceName: '【GPLUS 居不可濕】_12L_除濕機_說明書.pdf' })?.folderId).toBe('f_gplus')
  })

  it('⛔猜不出來就回未分類，不要硬塞——放錯資料夾比留在未分類更難查', () => {
    expect(pickFolderForSource(MYFEEL_FOLDERS, { sourceName: '2026 春季活動辦法.pdf' })).toBeNull()
    expect(pickFolderForSource(MYFEEL_FOLDERS, { sourceName: '' })).toBeNull()
    expect(pickFolderForSource([], { sourceName: 'BOYA mini 2 說明書.pdf' })).toBeNull()
  })

  it('⛔兩個資料夾都像就不猜（「零水鍋」與「SHARP 自動調理零水鍋」）', () => {
    // 「零水鍋」整個名字都在檔名裡（1.0），「SHARP 自動調理零水鍋」只中了一部分——
    // 但如果檔名把 SHARP 也寫進去，兩邊都會滿分，這時猜哪一個都是賭
    const m = pickFolderForSource(MYFEEL_FOLDERS, { sourceName: 'SHARP 自動調理零水鍋 說明書.pdf' })
    expect(m).toBeNull()
  })

  it('⛔短詞湊出來的分數不算（資料夾叫「AI 助手」不該吸走所有含 AI 的檔案）', () => {
    const folders = [{ id: 'f_ai', name: 'AI 助手' }]
    expect(pickFolderForSource(folders, { sourceName: 'AI NotePods 10S 說明書.pdf' })).toBeNull()
  })

  it('全形括號、大小寫、空白差異不影響比對', () => {
    const folders = [{ id: 'f_x', name: 'ｉBarista　智慧咖啡機' }]
    const m = pickFolderForSource(folders, { sourceName: 'SHARP 頂級A咖｜iBarista 智慧咖啡機 HM-AD20VT使用說明書.pdf' })
    expect(m?.folderId).toBe('f_x')
  })
})
