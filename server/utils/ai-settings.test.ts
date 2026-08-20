import { describe, expect, it } from 'vitest'
import { normalizeAiSettings } from './ai-settings'

const withNotify = (lineUserIds: unknown, displayNames?: Record<string, string>) =>
  normalizeAiSettings({
    handoffNotify: { enabled: true, lineUserIds, displayNames },
  }).handoffNotify

const U1 = 'U00208f7556f2fbe7d4e172988882383b'
const U2 = 'U0072e75339d1b1fb8505318527db10ce'
const WS = '212405d2-d782-443b-9670-adac3b3e1f99'

describe('normalizeAiSettings — 轉真人通知名單收斂成純 LINE userId', () => {
  it('誤存 Firestore doc id（workspaceId_Uxxx）會被剝成純 LINE userId', () => {
    // 整串丟給 LINE 會被判無效 userId、通知靜默失敗，所以要在收斂層自我修正
    expect(withNotify([`${WS}_${U1}`]).lineUserIds).toEqual([U1])
  })

  it('本來就是純 LINE userId 不會被動到', () => {
    expect(withNotify([U1, U2]).lineUserIds).toEqual([U1, U2])
  })

  it('同一人同時以 doc id 與純 id 出現只留一筆', () => {
    expect(withNotify([`${WS}_${U1}`, U1]).lineUserIds).toEqual([U1])
  })

  it('displayNames 以舊的 doc id 當 key 也查得到，改鍵成純 id', () => {
    const res = withNotify([`${WS}_${U1}`], { [`${WS}_${U1}`]: '客服小美' })
    expect(res.displayNames).toEqual({ [U1]: '客服小美' })
  })

  it('尾段不是 LINE userId 格式時保持原字串，不亂剪', () => {
    // 例如有人手打了自訂字串，剪掉反而會讓設定悄悄變成別的值
    expect(withNotify(['group_alpha']).lineUserIds).toEqual(['group_alpha'])
  })

  it('空值與非陣列都收成空名單', () => {
    expect(withNotify(['', '  ', null]).lineUserIds).toEqual([])
    expect(withNotify('nope').lineUserIds).toEqual([])
  })

  it('最多只留 10 位', () => {
    const many = Array.from({ length: 14 }, (_, i) => `U${String(i).padStart(32, '0')}`)
    expect(withNotify(many).lineUserIds).toHaveLength(10)
  })
})

/**
 * 「太久沒動靜自動結束對話」是**同一個數字欄位**的開關＋時數：0 ＝ 關閉（預設）、
 * >0 ＝ 幾小時後收。2026-08-21 拍板預設關（真人沒切就不要轉，等真人按下結束才結束）。
 */
describe('normalizeAiSettings — 自動結束對話（0 = 關閉）', () => {
  const hours = (raw?: unknown) =>
    normalizeAiSettings(raw === undefined ? {} : { humanSessionMaxIdleHours: raw })
      .humanSessionMaxIdleHours

  it('沒設定過的工作區＝關閉（預設不自動結束）', () => {
    expect(hours()).toBe(0)
  })

  /**
   * ⛔ 這條是最容易寫錯的地方：把 0 丟進「夾在 6~336」的收斂裡會變成 6 小時——
   * 「關閉」反而成了最積極的收尾，而且畫面上開關看起來是關的。
   */
  it('0 要原封不動留著，不可以被夾成下界 6 小時', () => {
    expect(hours(0)).toBe(0)
  })

  it('開啟時吃 6~336 小時的範圍（設 3 → 6、設 999 → 336）', () => {
    expect(hours(48)).toBe(48)
    expect(hours(3)).toBe(6)
    expect(hours(999)).toBe(336)
  })

  it('髒值（字串／null）當沒設定＝關閉', () => {
    expect(hours('abc')).toBe(0)
    expect(hours(null)).toBe(0)
  })
})
