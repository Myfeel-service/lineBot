/**
 * 每日客服摘要的文案與排版（2026-09-17，`D-81` 拍板改版）。
 *
 * 這一組守的是「讀的人看到什麼」，不是查詢對不對：
 *  - 昨天那三個數字**加起來一定等於總場數**（子集不可以並排，後台那張卡踩過）
 *  - 順利的一天是**一行**，而且仍然要發（原本沒事就不發＝「很順」與「壞了」長得一樣）
 *  - 三項以上用「、」串、最後用「與」（原本 `.join('與')` 三項會變「A 與 B 與 C」）
 *  - 全形標點（原本本文半形、週報全形，同一顆泡泡兩套）
 *  - 查不到不可以當成 0
 */
import { describe, it, expect } from 'vitest'
import { buildDigestLines, joinZh, taipeiDateLabel, waitPhrase } from './daily-digest-message'
import type { DigestInput } from './daily-digest-message'

const base: DigestInput = {
  dateLabel: '9/17（三）',
  yesterday: {
    total: 23,
    selfServed: 19,
    humanServed: 4,
    unhandled: 0,
    unhandledNames: [],
    newFriends: 5,
  },
  waiting: { count: 0, offHoursCount: 0, samples: [], truncated: false, staleHumanCount: 0 },
  todo: {
    outdatedSources: 0,
    failedSources: 0,
    expiredCards: 0,
    suggestions: 0,
    tagSuggestUsers: 0,
    warnings: 0,
    topWarningLabel: '',
  },
  festivalText: '',
  weeklyLines: [],
  unknownNotes: [],
}

const text = (input: Partial<DigestInput> = {}) =>
  (buildDigestLines({ ...base, ...input }) ?? []).join('\n')

describe('小工具', () => {
  it('中文串接：一項照原樣、兩項用「與」、三項以上「A、B 與 C」', () => {
    expect(joinZh(['「對話」'])).toBe('「對話」')
    expect(joinZh(['「對話」', '「好友」'])).toBe('「對話」與「好友」')
    // ⛔ 原本是 .join('與')：三項會變成「A 與 B 與 C」
    expect(joinZh(['「對話」', '「AI 知識庫」', '「好友」'])).toBe('「對話」、「AI 知識庫」與「好友」')
  })

  it('等待時間：未滿一小時講分鐘，滿了講小時，不會出現「等 0 分鐘」', () => {
    expect(waitPhrase(40)).toBe('等 40 分鐘')
    expect(waitPhrase(0.2)).toBe('等 1 分鐘')
    expect(waitPhrase(185)).toBe('等 3 小時')
  })

  it('日期標題帶星期（台北日曆日，不吃本機時區）', () => {
    expect(taipeiDateLabel('2026-09-17')).toBe('9/17（四）')
    expect(taipeiDateLabel('2026-09-14')).toBe('9/14（一）')
  })
})

describe('順利的一天（拍板選項 B：照發，一行）', () => {
  it('沒有人在等、也沒有待辦 → 只有一行，而且**有發**', () => {
    const lines = buildDigestLines(base)!
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('☀️ 9/17（三） 昨天 23 場對話，AI 自己搞定 19 場、你出手 4 場，沒有人在等。新朋友 +5 位。')
  })

  it('AI 全部自己搞定 → 換一句專屬說法（這是最值得講的好消息）', () => {
    const out = text({
      yesterday: { total: 18, selfServed: 18, humanServed: 0, unhandled: 0, unhandledNames: [], newFriends: 3 },
    })
    expect(out).toBe('☀️ 9/17（三） 昨天 18 場對話，AI 全部自己搞定，沒有人在等。新朋友 +3 位。')
  })

  it('昨天沒有客人對話 → 照實講，不假裝有數字', () => {
    expect(text({
      yesterday: { total: 0, selfServed: 0, humanServed: 0, unhandled: 0, unhandledNames: [], newFriends: null },
    })).toBe('☀️ 9/17（三） 昨天沒有客人對話，沒有人在等。')
  })

  it('新朋友查不到（null）→ 整句不提，⛔不可以寫成 +0 位', () => {
    const out = text({
      yesterday: { ...base.yesterday!, newFriends: null },
    })
    expect(out).not.toContain('新朋友')
    expect(out).not.toContain('+0')
  })
})

describe('三段結構（有事的一天）', () => {
  const busy: Partial<DigestInput> = {
    yesterday: {
      total: 25, selfServed: 19, humanServed: 4, unhandled: 2,
      unhandledNames: ['王小明', '陳玉婷'], newFriends: 5,
    },
    waiting: {
      count: 2,
      offHoursCount: 1,
      samples: [{ name: '王小明', waitedMinutes: 185 }, { name: '陳玉婷', waitedMinutes: 40 }],
      truncated: false,
      staleHumanCount: 1,
    },
    todo: {
      outdatedSources: 3, failedSources: 1, expiredCards: 2, suggestions: 4,
      tagSuggestUsers: 5, warnings: 2, topWarningLabel: '有推播沒有送出去',
    },
  }

  it('順序＝昨天 → 現在有人在等 → 今天可以處理，段落之間用空行隔開', () => {
    const lines = buildDigestLines({ ...base, ...busy })!
    const at = (needle: string) => lines.findIndex(l => l.includes(needle))
    expect(lines[0]).toBe('☀️ 9/17（三）早安')
    expect(at('昨天 25 場對話')).toBeLessThan(at('現在有 2 位客人在等真人'))
    expect(at('現在有 2 位客人在等真人')).toBeLessThan(at('今天可以處理'))
    expect(lines.filter(l => l === '')).not.toHaveLength(0)
  })

  it('昨天那三個數字加起來等於總場數（⛔子集不可以並排）', () => {
    const out = text(busy)
    expect(out).toContain('昨天 25 場對話，AI 自己搞定 19 場、你出手 4 場、2 場一整天沒人回。')
    // 19 + 4 + 2 = 25
    expect(out).toContain('沒人回的是王小明與陳玉婷。')
    // 「轉真人」是子集，不可以混進那一句
    expect(out).not.toContain('轉真人')
  })

  it('有人在等＝唯一的紅點，下班時段進來的分開講', () => {
    const out = text(busy)
    expect(out).toContain('🔴 現在有 2 位客人在等真人')
    expect(out).toContain('王小明（等 3 小時）、陳玉婷（等 40 分鐘）')
    expect(out).toContain('其中 1 位是下班時段進來的。')
  })

  it('全部都是下班時段進來的 → 拿掉紅點（天天紅字＝狼來了）', () => {
    const out = text({
      ...busy,
      waiting: { ...busy.waiting!, count: 2, offHoursCount: 2 },
    })
    expect(out).not.toContain('🔴')
    expect(out).toContain('現在有 2 位客人在等真人，都是下班時段進來的。')
  })

  it('撈到上限 → 說法退成「至少」，⛔不可以靜靜地少講', () => {
    const out = text({ ...busy, waiting: { ...busy.waiting!, truncated: true } })
    expect(out).toContain('至少 2 位客人在等真人')
  })

  it('待辦收成「幾件＋一句話」，數字放句首，操作步驟不進 LINE', () => {
    const out = text(busy)
    expect(out).toContain('📌 今天可以處理（6 項）')
    expect(out).toContain('3 個知識來源內容變了，等你確認要不要更新')
    expect(out).toContain('4 個常被問、AI 卻答不好的主題，草稿已擬好')
    expect(out).toContain('另有 2 件建議處理的事，最重要的是「有推播沒有送出去」')
    // 操作步驟留在後台（原本這行有 40 個字在教人按哪顆鈕）
    expect(out).not.toContain('交回機器人')
    expect(out).not.toContain('勾「只看有 AI 建議的」')
  })

  it('指路只列真的有事的地方，三項以上用「、」與「與」', () => {
    expect(text(busy)).toContain('→ 後台「對話」、「AI 知識庫」、「好友」與右下角的小幫手')
    // 只有知識庫有事 → 只講知識庫
    expect(text({
      todo: { ...base.todo, failedSources: 1 },
    })).toContain('→ 後台「AI 知識庫」')
  })

  it('全篇只有一套標點：不出現半形逗號與半形括號', () => {
    const out = text({ ...busy, festivalText: '再過 3 天就是中秋節。', weeklyLines: ['📈 上週顧客觀察（9/8–9/14）', '・這週被貼最多的標籤：「運費」+12 位'] })
    expect(out).not.toMatch(/[一-鿿],/) // 中文字後面接半形逗號
    expect(out).not.toMatch(/\([^)]*[一-鿿]/) // 半形括號裡包中文
  })

  it('節慶與週報各自空行隔開、接在最後（先講營運再講行銷）', () => {
    const lines = buildDigestLines({
      ...base,
      ...busy,
      festivalText: '再過 3 天就是中秋節。',
      weeklyLines: ['📈 上週顧客觀察（9/8–9/14）', '・運費 +12 位'],
    })!
    const f = lines.findIndex(l => l.startsWith('🎉'))
    const w = lines.findIndex(l => l.startsWith('📈'))
    expect(lines[f - 1]).toBe('')
    expect(lines[w - 1]).toBe('')
    expect(f).toBeLessThan(w)
    expect(lines.findIndex(l => l.includes('今天可以處理'))).toBeLessThan(f)
  })
})

describe('查不到就要講（⛔不可以當成 0）', () => {
  it('昨天的數字查不到 → 照實講，其他段落照常', () => {
    const out = text({
      yesterday: null,
      todo: { ...base.todo, failedSources: 1 },
      unknownNotes: ['昨天的數字'],
    })
    expect(out).toContain('昨天的數字這次查不到。')
    expect(out).toContain('（昨天的數字這次查不到，明天會再看一次。）')
    expect(out).toContain('1 個知識來源同步失敗')
  })

  it('兩類都查不到 → 併成一句講', () => {
    expect(text({ unknownNotes: ['昨天的數字', '知識庫與標籤的部分'] }))
      .toContain('（昨天的數字與知識庫與標籤的部分這次查不到，明天會再看一次。）')
  })

  it('連昨天都查不到、也沒有任何事可講 → 回 null（不發一則空話）', () => {
    expect(buildDigestLines({ ...base, yesterday: null })).toBeNull()
  })

  it('昨天查不到但有節慶要講 → 照發（節慶那段本來就跟昨天無關）', () => {
    expect(buildDigestLines({ ...base, yesterday: null, festivalText: '明天就是中秋節！' })).not.toBeNull()
  })
})
