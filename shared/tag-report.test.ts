import { describe, expect, it } from 'vitest'
import {
  allowedSummaryNumbers,
  buildTagSummaryFacts,
  buildTagSummaryPrompt,
  canRegenerate,
  cooldownRemainingMs,
  cooldownText,
  isTooThinForSummary,
  rejectTagSummary,
  summarySkipText,
  TAG_REPORT_COOLDOWN_MS,
  TAG_SUMMARY_MAX,
  TAG_SUMMARY_BULLET_TARGET,
  TAG_SUMMARY_MIN_TAGGINGS,
  type TagInsightsPayload,
} from './tag-report'

function ref(id: string, name: string) {
  return { tagId: id, name, category: null, color: null }
}

/** 一份「資料夠厚」的報告；每條測試只改自己要動的那一塊 */
function payload(over: Partial<TagInsightsPayload> = {}): TagInsightsPayload {
  return {
    integrity: {
      failed: [],
      userTagsTruncated: false,
      suggestionLogsTruncated: false,
      pendingTruncated: false,
      scannedUserTags: 2433,
      suggestionLedgerSince: '2026-08-30',
    },
    pendingReview: { users: 45, byTag: [] },
    customerExpressed: [
      { ...ref('t1', '問卷 - 乾淨方MAX'), users: 850, isIntent: false },
      { ...ref('t2', '客服 - BOYA mini2'), users: 106, isIntent: false },
      { ...ref('t3', '在看咖啡機'), users: 12, isIntent: true },
    ],
    intersections: [{ a: ref('t1', '問卷 - 乾淨方MAX'), b: ref('t2', '客服 - BOYA mini2'), users: 10 }],
    eventVsIntent: { intent: { tags: 4, taggings: 63 }, event: { tags: 33, taggings: 2369 } },
    sourceMix: { counts: { ai: 63, rule: 0, system: 2369, manual: 1, import: 0 }, total: 2433, customerExpressed: 2432, ourOwn: 1 },
    coverage: { taggedUsers: 2235, untaggedUsers: 2776, totalUsers: 5011, pct: 44.6 },
    health: {
      zeroMember: [{ tagId: 'z1', name: '舊檔期' }],
      aiOnButNeverProduced: [{ tagId: 'a1', name: '在看紓壓按摩' }],
    },
    suggestions: {
      suggested: 77, autoApplied: 6, applied: 55, dismissed: 17, superseded: 0,
      decided: 72, agreed: 55, acceptanceRate: 76.4,
    },
    tagNotes: [{ tagId: 't3', name: '在看咖啡機', description: '對咖啡機有興趣的人', aiCriteria: '客人問到咖啡機、磨豆' }],
    ...over,
  }
}

describe('冷卻（鐵律①：產生－存檔－沿用，不是每次開頁重算）', () => {
  const now = 1_700_000_000_000

  it('從來沒產生過 → 可以產生', () => {
    expect(canRegenerate(null, now)).toBe(true)
    expect(canRegenerate(0, now)).toBe(true)
    expect(cooldownRemainingMs(null, now)).toBe(0)
  })

  it('⛔ 一小時內不可以再算一次（一份約三四千次讀取）', () => {
    expect(canRegenerate(now - 59 * 60_000, now)).toBe(false)
    expect(cooldownRemainingMs(now - 59 * 60_000, now)).toBe(60_000)
  })

  it('滿一小時就可以', () => {
    expect(canRegenerate(now - TAG_REPORT_COOLDOWN_MS, now)).toBe(true)
  })

  it('⛔ 時間戳在未來（機器時鐘歪掉）不可以把人鎖死', () => {
    expect(canRegenerate(now + 86_400_000, now)).toBe(true)
  })

  it('冷卻訊息要說得出還要多久，不是只講「請稍後再試」', () => {
    expect(cooldownText(cooldownRemainingMs(now - 59 * 60_000, now))).toContain('1 分鐘後')
    expect(cooldownText(0)).toBe('')
  })
})

describe('薄資料（鐵律③：整段不出現，不硬擠）', () => {
  it('資料夠厚就寫', () => {
    expect(isTooThinForSummary(payload())).toBe(false)
  })

  it('⛔ 貼標筆數太少不寫', () => {
    const thin = payload({ eventVsIntent: { intent: { tags: 1, taggings: 2 }, event: { tags: 2, taggings: 5 } } })
    expect(isTooThinForSummary(thin)).toBe(true)
  })

  it('⛔ 客人自己表現的標籤排不出三名就不寫（只有名冊，總結沒東西可講）', () => {
    expect(isTooThinForSummary(payload({ customerExpressed: [{ ...ref('t1', 'x'), users: 900, isIntent: false }] }))).toBe(true)
  })

  it('三種「沒有摘要」講三句不同的話，⛔ 不可以靜靜消失', () => {
    const thin = summarySkipText('too_thin')
    const failed = summarySkipText('llm_failed')
    const rejected = summarySkipText('rejected')
    expect(new Set([thin, failed, rejected]).size).toBe(3)
    expect(thin).toContain(String(TAG_SUMMARY_MIN_TAGGINGS))
    // 三句都要講「下面的數字還是準的」，否則人會連數字一起不信
    for (const t of [thin, failed, rejected]) expect(t).toMatch(/準的|不受影響/)
  })
})

describe('事實表：只放算好的數字', () => {
  const facts = buildTagSummaryFacts(payload())

  it('六張卡的數字都在裡面', () => {
    expect(facts).toContain('2369 筆') // 事件型
    expect(facts).toContain('850 位') // 排行第一
    expect(facts).toContain('44.6%') // 覆蓋率
    expect(facts).toContain('76.4%') // 同意率
    expect(facts).toContain('45 位') // 待審
  })

  it('標籤的說明與判斷條件有帶進去（`D-28`⑤：說明欄是 AI 理解商業意義的來源）', () => {
    expect(facts).toContain('對咖啡機有興趣的人')
    expect(facts).toContain('客人問到咖啡機、磨豆')
  })

  it('⛔ 算不出覆蓋率時要明講「不要提」，不是留空給它自由發揮', () => {
    const f = buildTagSummaryFacts(payload({
      coverage: { taggedUsers: 100, untaggedUsers: null, totalUsers: null, pct: null },
    }))
    expect(f).toContain('不要在總結裡提覆蓋率')
  })

  it('⛔ 還沒有人做過決定時同意率寫「算不出來」，不是 0%（0% 會被讀成 AI 全錯）', () => {
    const f = buildTagSummaryFacts(payload({
      suggestions: { suggested: 5, autoApplied: 0, applied: 0, dismissed: 0, superseded: 0, decided: 0, agreed: 0, acceptanceRate: null },
    }))
    expect(f).toContain('算不出來')
    expect(f).not.toContain('同意率 0%')
  })

  it('prompt 有把兩條紅線寫進去（分開講事件與意圖、不准自己算）', () => {
    const prompt = buildTagSummaryPrompt(payload())
    expect(prompt).toContain('不准自己算任何數字')
    expect(prompt).toContain('不可以說成「客人對 X 有興趣')
    // ⚠️ 限制要訂在「每一點」不是「總共」：實測跟它要總字數五輪全部超過
    expect(prompt).toContain(`${TAG_SUMMARY_BULLET_TARGET} 字以內`)
    expect(prompt).toContain('只寫三到四點')
    expect(prompt).not.toContain(`總共 ${TAG_SUMMARY_MAX}`)
  })
})

describe('rejectTagSummary（鐵律②：AI 只讀數字寫人話、不算數字）', () => {
  const p = payload()

  it('照抄我們給的數字 → 放行', () => {
    const ok = [
      '- 意圖型標籤只有 4 顆、貼出 63 筆，AI 判出來的東西還很少',
      '- 「問卷 - 乾淨方MAX」有 850 位，但那是填過問卷的名冊，不代表他們想買',
      '- 有 45 位客人的建議還沒決定，建議先去審完',
    ].join('\n')
    expect(rejectTagSummary(ok, p)).toBeNull()
  })

  it('⛔ 出現我們沒給的數字 → 整段退掉', () => {
    expect(rejectTagSummary('- 意圖型標籤有 4 顆，預估下個月會成長到 120 位', p)).toMatch(/沒給它的數字/)
  })

  it('⛔ 自己把兩個數字加起來 → 退掉（63 + 2369 = 2432 我們沒給）', () => {
    expect(rejectTagSummary('- 總共貼了 2432 筆標籤', p)).toMatch(/沒給它的數字/)
  })

  it('⛔ 自己換算成「幾成」→ 退掉', () => {
    expect(rejectTagSummary('- 覆蓋率不到五成，還有很多人沒被貼到', p)).toMatch(/自己換算了比例/)
    expect(rejectTagSummary('- 意圖型標籤的量翻倍了', p)).toMatch(/自己換算了比例/)
    expect(rejectTagSummary('- 大多數客人身上都有標籤', p)).toMatch(/自己換算了比例/)
  })

  it('整數四捨五入算引用不算捏造（76.4% → 76%）', () => {
    expect(rejectTagSummary('- AI 建議的同意率約 76%，算準的', p)).toBeNull()
  })

  it('條列編號「1. 」不會被當成假數字', () => {
    expect(rejectTagSummary('1. 意圖型標籤只有 4 顆\n2. 事件型 33 顆', p)).toBeNull()
  })

  it('標籤名字裡的數字天然放行（事實表裡有）', () => {
    expect(rejectTagSummary('- 「客服 - BOYA mini2」有 106 位', p)).toBeNull()
  })

  it('空的、太長都要退', () => {
    expect(rejectTagSummary('', p)).toBe('空的')
    expect(rejectTagSummary('啊'.repeat(TAG_SUMMARY_MAX + 1), p)).toMatch(/太長/)
  })

  it('⭐ 白名單真的跟著報告走：換一份報告，原本合法的數字就該被退', () => {
    const other = payload({ customerExpressed: [
      { ...ref('x', 'A'), users: 11, isIntent: false },
      { ...ref('y', 'B'), users: 12, isIntent: false },
      { ...ref('z', 'C'), users: 13, isIntent: false },
    ] })
    expect(rejectTagSummary('- 「問卷 - 乾淨方MAX」有 850 位', p)).toBeNull()
    expect(rejectTagSummary('- 有 850 位', other)).toMatch(/沒給它的數字/)
  })

  // ⚠️ 這一組是 2026-09-23 真的打 Gemini 三輪之後補的：prompt 已經明寫不准，
  //    三輪裡兩輪照樣寫「客戶對『問卷_珈樂堤_小滑手』的興趣最高」。
  describe('鐵律④：事件紀錄不可以被說成興趣', () => {
    it('⛔ 事件型標籤＋興趣詞在同一句 → 整段退掉', () => {
      expect(rejectTagSummary('- 客戶對「問卷 - 乾淨方MAX」的興趣最高，有 850 位', p)).toMatch(/說成興趣/)
      expect(rejectTagSummary('- 有 106 位客人想買「客服 - BOYA mini2」', p)).toMatch(/說成興趣/)
    })

    it('意圖型標籤講興趣是對的 → 放行', () => {
      expect(rejectTagSummary('- 有 12 位客人對「在看咖啡機」表現出興趣', p)).toBeNull()
    })

    it('事件型標籤只講「做過什麼」→ 放行', () => {
      expect(rejectTagSummary('- 有 850 位客人填過「問卷 - 乾淨方MAX」那份問卷', p)).toBeNull()
    })

    it('⭐ 逐句判斷，不是整段：別句講興趣不該誤殺提到事件標籤的那句', () => {
      const ok = '- 「問卷 - 乾淨方MAX」有 850 位填過。\n- 意圖型標籤只有 4 顆，看得出興趣的人還很少'
      expect(rejectTagSummary(ok, p)).toBeNull()
    })

    it('⭐ 否定句要放行——「不代表他們想買」正是我們希望它寫的那種句子', () => {
      expect(rejectTagSummary('- 「問卷 - 乾淨方MAX」有 850 位，但那是名冊，不代表他們想買', p)).toBeNull()
      expect(rejectTagSummary('- 「客服 - BOYA mini2」的 106 位不等於對它有興趣', p)).toBeNull()
    })

    it('事實表逐列標出是哪一種（只在表頭講一次，模型讀到第五列就忘了）', () => {
      const f = buildTagSummaryFacts(p)
      expect(f).toContain('「問卷 - 乾淨方MAX」：850 位（事件紀錄')
      expect(f).toContain('「在看咖啡機」：12 位（意圖）')
    })

    it('交集那幾列也要標——實測就是從沒標的那一段溜出去的', () => {
      const f = buildTagSummaryFacts(p)
      expect(f).toContain('事件紀錄＋事件紀錄')
      expect(f).toContain('不代表他想要')
    })

    it('標籤名字在事實表裡要框起來（有一顆標籤就叫「60 天沒互動」）', () => {
      const f = buildTagSummaryFacts(payload({
        health: { zeroMember: [{ tagId: 'z', name: '60 天沒互動' }], aiOnButNeverProduced: [] },
      }))
      expect(f).toContain('「60 天沒互動」')
    })
  })

  it('白名單是從事實表抽的（同源，不另外維護一份清單）', () => {
    const allowed = allowedSummaryNumbers(p)
    expect(allowed.has(850)).toBe(true)
    expect(allowed.has(44.6)).toBe(true)
    expect(allowed.has(2432)).toBe(false) // 63+2369，我們沒餵過
  })
})
