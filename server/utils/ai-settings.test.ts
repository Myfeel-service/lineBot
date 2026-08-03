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
