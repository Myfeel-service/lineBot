/**
 * 模型多吐一截殘句時，要撿得回第一份完整的 JSON；被截斷時必須維持失敗。
 *
 * 背景（2026-09-10）：客人傳商品截圖進來，AI 其實看懂了、該填的兩格也填對了，
 * 但 flash-lite 在合法 JSON 後面又多寫了半句沒頭沒尾的話。舊做法整份 JSON.parse
 * 失敗 → 問句連坐丟掉 → 客人收到「我目前只能閱讀文字」。拿正式站那張原圖用相同參數
 * 重跑五次，兩次是這個樣子；正式資料回頭掃，171 張讀過的圖有 45 張中鏢。
 *
 * ⛔ 這支測試的另一半同樣重要：**截斷仍然要失敗**。切知識卡那條路靠「parse 失敗」
 *    判斷輸出被截斷、據以縮小輸入重試（isChunkTruncationError），撿半份回去會讓那條
 *    重試邏輯把缺一半的卡片當成功。
 */
import { describe, expect, it } from 'vitest'

;(globalThis as any).useRuntimeConfig ??= () => ({ geminiApiKey: 'test-key' })
;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

import { parseFirstJsonValue } from './gemini'

describe('parseFirstJsonValue：撿第一份完整的 JSON', () => {
  it('乾淨的輸出照舊（絕大多數情況，行為不能變）', () => {
    expect(parseFirstJsonValue('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' })
    expect(parseFirstJsonValue('  \n [1,2,3] \n ')).toEqual([1, 2, 3])
  })

  it('正式站實測那串：完整 JSON 後面多一截殘句 → 取前面那份，殘句丟掉', () => {
    const raw = `{"description":"飛利浦鍋具特價NT$6,990","question":"這款電子鍋有什麼優惠？"}\n現省多少錢？"}`
    expect(parseFirstJsonValue(raw)).toEqual({
      description: '飛利浦鍋具特價NT$6,990',
      question: '這款電子鍋有什麼優惠？',
    })
  })

  it('殘句不只一截也一樣（實測有一次連吐兩截）', () => {
    const raw = `{"q":"這台電子鍋有什麼優惠？"}\n現鍋有什麼優惠？"}\n現省3000的電子鍋有貨嗎？"}`
    expect(parseFirstJsonValue(raw)).toEqual({ q: '這台電子鍋有什麼優惠？' })
  })

  it('⛔ 被截斷的 JSON 仍然要失敗：切卡的縮小重試靠這個訊號', () => {
    expect(parseFirstJsonValue('{"description":"這句話還沒寫完')).toBeNull()
    expect(parseFirstJsonValue('[{"a":1},{"b":2}')).toBeNull()
  })

  it('字串裡的括號與跳脫引號不會被當成收尾', () => {
    expect(parseFirstJsonValue('{"a":"結尾有個 } 符號","b":"引號 \\" 也是"}'))
      .toEqual({ a: '結尾有個 } 符號', b: '引號 " 也是' })
  })

  it('巢狀結構要算到最外層才收', () => {
    expect(parseFirstJsonValue('{"a":{"b":[1,{"c":2}]}}後面亂寫'))
      .toEqual({ a: { b: [1, { c: 2 }] } })
  })

  it('前面被加了 ``` 圍欄也撿得到（指定 JSON 格式時很少見，但不必為此失敗）', () => {
    expect(parseFirstJsonValue('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('空的、或整段都不是 JSON → null（不能硬掰一個空物件出來）', () => {
    expect(parseFirstJsonValue('')).toBeNull()
    expect(parseFirstJsonValue('   ')).toBeNull()
    expect(parseFirstJsonValue('這不是 JSON，是模型隨口講的一句話')).toBeNull()
  })
})
