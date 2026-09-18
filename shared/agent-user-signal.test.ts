/**
 * 「使用者這句話，夠不夠決定要動什麼」（`C-192`）。
 *
 * 這兩個判斷是從 2026-09-16 的實測長出來的：
 * ① 助理問完「想先關閉哪一個？」，使用者回一個「做」，模型就自己挑了清單第一條。
 * ② 使用者一個數字都沒講，模型直接提議一組勿擾時段。
 * 兩題在 prompt 裡都早就寫了「⛔不要自己補」，照樣中——所以改成機制。
 */
import { describe, expect, it } from 'vitest'
import { clockFieldsChangedBeyondUserWords, hasNumberSignal, isBareAssent } from './agent-user-signal'

describe('只有同意、沒講要動哪一個', () => {
  it('🔴 實測踩到的那一句：「做」', () => {
    expect(isBareAssent('做')).toBe(true)
  })

  it('包著虛字也算：那就做吧／好了啦／就這樣吧', () => {
    for (const s of ['那就做吧', '好了啦', '就這樣吧', '嗯嗯', '好的！'])
      expect(isBareAssent(s), s).toBe(true)
  })

  it('把決定權丟回來的也要問，⛔不可以替他挑', () => {
    for (const s of ['都可以', '隨便', '你決定', '你看著辦'])
      expect(isBareAssent(s), s).toBe(true)
  })

  it('只剩標點或空白＝什麼都沒講', () => {
    for (const s of ['.', '。', '？？', '   '])
      expect(isBareAssent(s), s).toBe(true)
  })

  it('英文的同意詞', () => {
    for (const s of ['ok', 'OK!', 'yes', 'sure', 'go ahead', 'do it'])
      expect(isBareAssent(s), s).toBe(true)
  })

  it('⛔ 講清楚了要動哪一個就不可以擋——即使開頭有「好」', () => {
    for (const s of ['好，把查詢訂單關掉', '第二條', '把第二條關掉', '關掉更改地址', '改成 30 分鐘'])
      expect(isBareAssent(s), s).toBe(false)
  })

  it('⛔ 整句比對不是關鍵字包含：「好不好用」不是同意', () => {
    expect(isBareAssent('好不好用')).toBe(false)
  })
})

describe('有沒有講到數值', () => {
  it('🔴 實測踩到的那一句：「幫我設一下」的「一」不是數值', () => {
    expect(hasNumberSignal(['晚上太晚有人敲我 受不了 幫我設一下'])).toBe(false)
  })

  it('沒給數字的抱怨一律算沒講', () => {
    for (const s of ['晚上不要吵我', '客人等太久那個提醒 我覺得太慢了', '調短一點'])
      expect(hasNumberSignal([s]), s).toBe(false)
  })

  it('阿拉伯數字、中文數字＋單位都算講了', () => {
    for (const s of ['11點到早上9點', '晚上十一點到早上九點', '客人等超過十分鐘就提醒我', '改成兩倍快', '一個小時', '半小時'])
      expect(hasNumberSignal([s]), s).toBe(true)
  })

  it('⛔「幾點」是他在問，不是他給了值', () => {
    expect(hasNumberSignal(['要改成幾點？'])).toBe(false)
  })

  it('先前輪次他自己講過也算', () => {
    expect(hasNumberSignal(['晚上不要吵我', '11點到9點'])).toBe(true)
  })
})

/**
 * 2026-09-18 回歸實測：上一張卡是「勿擾 23:00–09:00」，使用者只說「剛剛那個改成早上十點」，
 * 出來的卻是「勿擾 **22:00**–10:00」——晚上那端被一起改了，而他從頭到尾沒提過晚上。
 */
describe('接續修改時，動到的時間格比他講的多', () => {
  const before = { mode: 'dnd', start: '23:00', end: '09:00' }

  it('🔴 他只講一個時間，兩端卻都變了 → 回報多動的那幾格', () => {
    const extra = clockFieldsChangedBeyondUserWords('剛剛那個改成早上十點', before, { mode: 'dnd', start: '22:00', end: '10:00' })
    expect(extra).toEqual(['start', 'end'])
  })

  it('只改他講的那一格 → 沒有多動', () => {
    expect(clockFieldsChangedBeyondUserWords('剛剛那個改成早上十點', before, { mode: 'dnd', start: '23:00', end: '10:00' })).toEqual([])
  })

  it('他講了兩個時間，兩端都變是對的', () => {
    expect(clockFieldsChangedBeyondUserWords('改成晚上十點到早上八點', before, { mode: 'dnd', start: '22:00', end: '08:00' })).toEqual([])
    expect(clockFieldsChangedBeyondUserWords('改成 22:00 到 08:00', before, { mode: 'dnd', start: '22:00', end: '08:00' })).toEqual([])
  })

  it('沒有上一張卡（不是接續修改）→ 不判', () => {
    expect(clockFieldsChangedBeyondUserWords('改成早上十點', undefined, { start: '10:00' })).toEqual([])
  })

  it('動的不是時間格（例如週末休不休）→ 不判', () => {
    expect(clockFieldsChangedBeyondUserWords('週末也要休息', before, { ...before, weekendOff: true })).toEqual([])
  })
})
