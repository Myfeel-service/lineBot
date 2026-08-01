import { describe, it, expect } from 'vitest'
import {
  truncateAtSentence,
  dedupeBySource,
  dedupeNearIdentical,
  shouldDisambiguate,
  effectiveConfidenceThreshold,
  matchCandidateTitle,
  buildContextualQuery,
  isReplyingToBotQuestion,
  isContextDependentFollowup,
  socialCannedReply,
  preferProductCards,
  preferSpecCards,
  dedupeByTitleContainment,
  collapseSameProduct,
  productNamedInQuery,
  buildNamedGuessConfirm,
  cleanProductLabel,
  taiwanTodayLabel,
  isUnresolvedFeedback,
} from './ai-answer'
import type { SimilarChunk } from './ai-knowledge-chunks'
import { detectSensitiveTopic } from '~~/shared/types/ai-knowledge'
import { normalizeProductName } from './ai-product-alias'

function chunk(partial: Partial<SimilarChunk> & { id: string }): SimilarChunk {
  return {
    title: partial.id,
    content: '',
    tags: [],
    similarity: 0,
    sourceId: null,
    isOverview: false,
    ...partial,
  }
}

describe('truncateAtSentence', () => {
  it('未超長時原樣回傳', () => {
    expect(truncateAtSentence('好的。', 50)).toBe('好的。')
  })

  it('超長時切在 maxLen 內最後一個句末符號', () => {
    const text = '第一句。第二句。第三句還沒結束'
    const out = truncateAtSentence(text, 10)
    expect(out).toBe('第一句。第二句。')
    expect(out.length).toBeLessThanOrEqual(10)
  })

  it('支援 ！？與換行作為句末', () => {
    expect(truncateAtSentence('有貨嗎！我想要這個顏色的', 8)).toBe('有貨嗎！')
    expect(truncateAtSentence('第一行\n第二行超出限制了', 5)).toBe('第一行')
  })

  it('整段沒有句末符號時硬切並補 …', () => {
    const text = '一二三四五六七八九十'
    const out = truncateAtSentence(text, 5)
    expect(out).toBe('一二三四…')
    expect(out.length).toBeLessThanOrEqual(5)
  })

  it('永不輸出超過 maxLen 的內容', () => {
    const samples = ['句子一。句子二。句子三。', '完全沒有標點的長文字串拉拉拉拉拉', 'A。B！C？D\nE']
    for (const s of samples) {
      for (const maxLen of [3, 5, 8, 12]) {
        expect(truncateAtSentence(s, maxLen).length).toBeLessThanOrEqual(maxLen)
      }
    }
  })
})

describe('dedupeBySource', () => {
  it('同 sourceId 只留第一張（分數最高），保持順序', () => {
    const input = [
      chunk({ id: 'a', sourceId: 's1', similarity: 0.9 }),
      chunk({ id: 'b', sourceId: 's2', similarity: 0.8 }),
      chunk({ id: 'c', sourceId: 's1', similarity: 0.7 }),
    ]
    expect(dedupeBySource(input).map(c => c.id)).toEqual(['a', 'b'])
  })

  it('無 sourceId 的卡各自獨立、全部保留', () => {
    const input = [
      chunk({ id: 'a', sourceId: null }),
      chunk({ id: 'b', sourceId: null }),
    ]
    expect(dedupeBySource(input)).toHaveLength(2)
  })

  it('豁免來源（型錄）的同源卡全部保留（不同產品不可併）', () => {
    const input = [
      chunk({ id: 'a', sourceId: 'catalog', similarity: 0.9 }),
      chunk({ id: 'b', sourceId: 'catalog', similarity: 0.8 }),
      chunk({ id: 'c', sourceId: 's2', similarity: 0.7 }),
      chunk({ id: 'd', sourceId: 's2', similarity: 0.6 }),
    ]
    // catalog 豁免 → a、b 都留；s2 非豁免 → 只留 c
    expect(dedupeBySource(input, new Set(['catalog'])).map(x => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('豁免卡片（一句多問錨點）保留，且不佔用該來源的名額', () => {
    // 情境：價格卡（第一問）與保固卡（第二問錨點）同來源——沒有豁免時保固卡被刪 → 第二問漏答
    const input = [
      chunk({ id: 'price', sourceId: 's1', similarity: 0.9 }),
      chunk({ id: 'other', sourceId: 's2', similarity: 0.8 }),
      chunk({ id: 'warranty', sourceId: 's1', similarity: 0.7 }),
    ]
    expect(dedupeBySource(input, undefined, new Set(['warranty'])).map(c => c.id))
      .toEqual(['price', 'other', 'warranty'])
    // 錨點排在前面時，同來源分數最高的非錨點卡也照常保留
    const input2 = [
      chunk({ id: 'warranty', sourceId: 's1', similarity: 0.9 }),
      chunk({ id: 'price', sourceId: 's1', similarity: 0.8 }),
    ]
    expect(dedupeBySource(input2, undefined, new Set(['warranty'])).map(c => c.id))
      .toEqual(['warranty', 'price'])
  })
})

describe('dedupeNearIdentical', () => {
  it('跨來源同標題（忽略空白大小寫）只留排前面那張', () => {
    const input = [
      chunk({ id: 'a', title: '退換貨政策', content: '七天鑑賞期。', sourceId: 's1', similarity: 0.8 }),
      chunk({ id: 'b', title: '退換貨 政策', content: '7 天鑑賞期內可退。', sourceId: 's2', similarity: 0.79 }),
    ]
    expect(dedupeNearIdentical(input).map(c => c.id)).toEqual(['a'])
  })

  it('同內容不同標題也視為重複', () => {
    const input = [
      chunk({ id: 'a', title: '運費', content: '滿千免運。', sourceId: 's1' }),
      chunk({ id: 'b', title: '運費說明', content: '滿千免運。', sourceId: 's2' }),
    ]
    expect(dedupeNearIdentical(input).map(c => c.id)).toEqual(['a'])
  })

  it('標題與內容都不同的卡全部保留', () => {
    const input = [
      chunk({ id: 'a', title: '運費', content: '滿千免運。' }),
      chunk({ id: 'b', title: '退換貨', content: '七天鑑賞期。' }),
    ]
    expect(dedupeNearIdentical(input)).toHaveLength(2)
  })
})

describe('shouldDisambiguate', () => {
  const settings = {
    disambiguation: {
      enabled: true,
      top1Min: 0.5,
      top1Max: 0.75,
      maxSpread: 0.06,
      maxOptions: 3,
      cooldownMinutes: 10,
    },
  }
  const pair = (top1: number, top2: number) => [
    chunk({ id: 'a', similarity: top1 }),
    chunk({ id: 'b', similarity: top2 }),
  ]

  it('top-1 在擦邊區且與 top-2 差距小 → true', () => {
    expect(shouldDisambiguate(pair(0.6, 0.58), settings)).toBe(true)
  })

  it('disabled → false', () => {
    expect(shouldDisambiguate(pair(0.6, 0.58), {
      disambiguation: { ...settings.disambiguation, enabled: false },
    })).toBe(false)
  })

  it('不足兩張卡 → false', () => {
    expect(shouldDisambiguate([chunk({ id: 'a', similarity: 0.6 })], settings)).toBe(false)
    expect(shouldDisambiguate([], settings)).toBe(false)
  })

  it('top-1 低於 top1Min 或不低於 top1Max → false', () => {
    expect(shouldDisambiguate(pair(0.4, 0.39), settings)).toBe(false)
    expect(shouldDisambiguate(pair(0.75, 0.74), settings)).toBe(false)
    expect(shouldDisambiguate(pair(0.9, 0.88), settings)).toBe(false)
  })

  it('top-1 / top-2 差距達 maxSpread → false', () => {
    expect(shouldDisambiguate(pair(0.7, 0.6), settings)).toBe(false)
    expect(shouldDisambiguate(pair(0.7, 0.63), settings)).toBe(false)
  })

  it('top-1 是總覽卡 → false（列舉型問題直接用總覽卡答，不反問）', () => {
    const withOverview = [
      chunk({ id: 'a', similarity: 0.6, isOverview: true }),
      chunk({ id: 'b', similarity: 0.58 }),
    ]
    expect(shouldDisambiguate(withOverview, settings)).toBe(false)
  })
})

describe('effectiveConfidenceThreshold', () => {
  const settings = { confidenceThreshold: 0.75, groundingThreshold: 0.7 }

  it('一般卡 → 用 confidenceThreshold', () => {
    expect(effectiveConfidenceThreshold(chunk({ id: 'a' }), settings)).toBe(0.75)
  })

  it('top-1 是總覽卡 → 降回 grounding 門檻（被品項清單稀釋、分數結構性偏低）', () => {
    expect(effectiveConfidenceThreshold(chunk({ id: 'a', isOverview: true }), settings)).toBe(0.7)
  })

  it('沒有 top-1（空結果）→ 用 confidenceThreshold', () => {
    expect(effectiveConfidenceThreshold(undefined, settings)).toBe(0.75)
  })

  it('總覽卡的 0.738 在新門檻下會過、舊門檻下不過', () => {
    const overview = chunk({ id: 'a', isOverview: true, similarity: 0.738 })
    expect(0.738 >= effectiveConfidenceThreshold(overview, settings)).toBe(true)
    expect(0.738 >= settings.confidenceThreshold).toBe(false)
  })
})

describe('matchCandidateTitle', () => {
  const candidates = [
    chunk({ id: '1', title: '巴拿馬 藝伎 水洗 (品號:21070909)' }),
    chunk({ id: '2', title: '衣索比亞 耶加雪菲' }),
    chunk({ id: '3', title: '運費與配送說明' }),
  ]

  it('完全相等優先', () => {
    expect(matchCandidateTitle('衣索比亞 耶加雪菲', candidates)?.id).toBe('2')
  })

  it('LLM 簡化標題（去掉品號）可用 prefix 對回原卡', () => {
    expect(matchCandidateTitle('巴拿馬 藝伎 水洗', candidates)?.id).toBe('1')
  })

  it('contains 為最後手段（雙向）', () => {
    expect(matchCandidateTitle('配送', candidates)?.id).toBe('3')
  })

  it('無法對應 → null；空字串 → null', () => {
    expect(matchCandidateTitle('完全無關的標題', candidates)).toBeNull()
    expect(matchCandidateTitle('  ', candidates)).toBeNull()
  })

  it('忽略空白與大小寫差異', () => {
    expect(matchCandidateTitle('衣索比亞耶加雪菲', candidates)?.id).toBe('2')
  })
})

describe('buildContextualQuery', () => {
  it('併上一輪客人訊息與本次提問', () => {
    const history = [
      { role: 'user' as const, text: '藝伎咖啡豆怎麼賣？' },
      { role: 'bot' as const, text: '半磅 800 元。' },
    ]
    expect(buildContextualQuery(history, '那運費呢？')).toBe('藝伎咖啡豆怎麼賣？\n那運費呢？')
  })

  it('取「最近的一輪」客人訊息', () => {
    const history = [
      { role: 'user' as const, text: '舊話題' },
      { role: 'bot' as const, text: '...' },
      { role: 'user' as const, text: '新話題' },
      { role: 'bot' as const, text: '...' },
    ]
    expect(buildContextualQuery(history, '多少錢？')).toBe('新話題\n多少錢？')
  })

  it('無 history 或上一輪與本次相同 → null', () => {
    expect(buildContextualQuery(undefined, '運費？')).toBeNull()
    expect(buildContextualQuery([], '運費？')).toBeNull()
    expect(buildContextualQuery([{ role: 'user', text: '運費？' }], '運費？')).toBeNull()
    expect(buildContextualQuery([{ role: 'bot', text: '您好' }], '運費？')).toBeNull()
  })

  it('多輪斷鏈修正：往回找自帶主題的錨點，串起整條（D-2）', () => {
    const history = [
      { role: 'user' as const, text: '奇美的燈' },
      { role: 'bot' as const, text: '...' },
      { role: 'user' as const, text: '保固多久' }, // 追問句（含「保固/多久」）
      { role: 'bot' as const, text: '...' },
    ]
    // 「怎麼申請」往回跳過「保固多久」、錨到「奇美的燈」，整條串起來
    expect(buildContextualQuery(history, '怎麼申請')).toBe('奇美的燈\n保固多久\n怎麼申請')
  })
})

describe('isReplyingToBotQuestion', () => {
  it('bot 反問澄清後，客人回一個短主題詞 → 視為回答反問', () => {
    const history = [
      { role: 'user' as const, text: '買很久了為什麼都還沒到貨' },
      { role: 'bot' as const, text: '請問您想了解的是哪項商品的到貨時間呢？' },
    ]
    expect(isReplyingToBotQuestion(history, '枕頭')).toBe(true)
  })

  it('上一則不是 bot、或 bot 不是在發問 → false', () => {
    expect(isReplyingToBotQuestion([{ role: 'user' as const, text: '哪個好呢？' }], '枕頭')).toBe(false)
    expect(isReplyingToBotQuestion([{ role: 'bot' as const, text: '好的，已為您處理。' }], '枕頭')).toBe(false)
  })

  it('客人自己又是一句完整提問、或太長 → 不算回答反問', () => {
    const h = [{ role: 'bot' as const, text: '是哪一台呢？' }]
    expect(isReplyingToBotQuestion(h, '那除濕機多少錢？')).toBe(false)
    expect(isReplyingToBotQuestion(h, '我想問一下你們那台除濕機的詳細規格')).toBe(false)
  })

  it('無 history → false', () => {
    expect(isReplyingToBotQuestion(undefined, '枕頭')).toBe(false)
    expect(isReplyingToBotQuestion([], '枕頭')).toBe(false)
  })
})

describe('dedupeByTitleContainment', () => {
  const c = (id: string, title: string): SimilarChunk => chunk({ id, title })
  it('同產品變體卡（標題互為包含）只留前面那張（D-3）', () => {
    const input = [
      c('1', 'NWT 威技 16L高效抽取型除濕機'),
      c('2', 'NWT威技16L高效抽取型除濕機專案資訊'), // 含 1 的標題 → 視為同產品
      c('3', 'NWT 威技 一級能效16L超威AI智能除濕機'), // 不同型號 → 保留
    ]
    expect(dedupeByTitleContainment(input).map(x => x.id)).toEqual(['1', '3'])
  })
  it('短標題（<4字）不互吃，避免誤併不同產品', () => {
    const input = [c('1', '燈'), c('2', '檯燈')]
    expect(dedupeByTitleContainment(input).map(x => x.id)).toEqual(['1', '2'])
  })
})

describe('isContextDependentFollowup', () => {
  it('只問屬性 / 指代詞的追問 → true', () => {
    for (const q of ['買多少錢呢', '價格多少', '有貨嗎', '什麼時候出貨', '怎麼用', '這個呢', '那台多少錢', '保固多久']) {
      expect(isContextDependentFollowup(q)).toBe(true)
    }
  })

  it('帶產品主題的獨立問題 → false（不該被併上下文拉歪）', () => {
    for (const q of ['空氣清淨機有什麼', '你們有賣什麼產品', 'LG 小蘑菇是什麼', '除濕機推薦']) {
      expect(isContextDependentFollowup(q)).toBe(false)
    }
  })
})

describe('socialCannedReply', () => {
  it('招呼 → 招呼罐頭', () => {
    for (const q of ['你好', '您好', '哈囉', '嗨', 'hi', 'Hello', '在嗎', '有人嗎', '早安', '你好！']) {
      expect(socialCannedReply(q)).toMatch(/為您服務/)
    }
  })
  it('道謝 → 不客氣罐頭', () => {
    for (const q of ['謝謝', '謝謝你', '感謝', '感恩', 'thanks', 'thx', '3Q']) {
      expect(socialCannedReply(q)).toMatch(/不客氣/)
    }
  })
  it('道別 → 再見罐頭', () => {
    for (const q of ['掰掰', '拜拜', '再見', 'bye']) {
      expect(socialCannedReply(q)).toMatch(/再見/)
    }
  })
  it('帶實際問題的句子 → null（不可誤攔）', () => {
    for (const q of ['你好我想問除濕機', '謝謝但這個多少錢', '哈囉小獴友多少錢', '請問營業時間']) {
      expect(socialCannedReply(q)).toBeNull()
    }
  })
})

describe('preferProductCards', () => {
  const c = (id: string, title: string): SimilarChunk => chunk({ id, title })
  it('把通用主題卡排到產品卡之後（穩定）', () => {
    const input = [
      c('1', '現貨庫存與預購說明'),
      c('2', 'NWT 威技 16L 除濕機'),
      c('3', '除濕機出廠測試現象說明'),
      c('4', 'GPLUS 居不可濕 除濕機'),
    ]
    expect(preferProductCards(input).map(x => x.id)).toEqual(['2', '4', '1', '3'])
  })
  it('候選全是主題卡時順序不變', () => {
    const input = [c('1', '除濕機保固政策'), c('2', '台灣在地保固與安全認證')]
    expect(preferProductCards(input).map(x => x.id)).toEqual(['1', '2'])
  })
})

describe('preferSpecCards', () => {
  const c = (id: string, title: string, tags: string[] = []): SimilarChunk => chunk({ id, title, tags })
  it('規格/特色卡排最前、售後卡排最後（7/31 稽核：比較題撈回保固/故障卡）', () => {
    const input = [
      c('warranty', 'GPLUS除濕機保固登錄方式'),
      c('trouble', '電源無法開啟故障排除'),
      c('spec', 'GPLUS除濕機12L產品規格'),
      c('storage', '長期存放注意事項'),
      c('feature', 'GPLUS除濕機特色介紹'),
    ]
    expect(preferSpecCards(input).map(x => x.id)).toEqual(['spec', 'feature', 'warranty', 'trouble', 'storage'])
  })
  it('同級內維持原相似度順序（穩定排序）', () => {
    const input = [
      c('a', 'W1 REGEN 除濕量與適用坪數'),
      c('b', '威技除濕機水箱容量'),
    ]
    expect(preferSpecCards(input).map(x => x.id)).toEqual(['a', 'b'])
  })
  it('tags 也參與比對（標題沒寫規格但 tag 有）', () => {
    const input = [
      c('after', '購買後注意事項', ['保固']),
      c('spec', 'GPLUS 12L 詳細資料', ['規格']),
    ]
    expect(preferSpecCards(input).map(x => x.id)).toEqual(['spec', 'after'])
  })
})

describe('detectSensitiveTopic', () => {
  const topics = ['退費', '法律', 'Refund']

  it('命中回傳原 topic（大小寫不敏感）', () => {
    expect(detectSensitiveTopic('我要退費！', topics)).toBe('退費')
    expect(detectSensitiveTopic('please REFUND me', topics)).toBe('Refund')
  })

  it('未命中 / 空輸入 → null', () => {
    expect(detectSensitiveTopic('請問營業時間', topics)).toBeNull()
    expect(detectSensitiveTopic('', topics)).toBeNull()
  })
})

describe('collapseSameProduct', () => {
  const c = (id: string, title: string, similarity: number, sourceId: string | null = null): SimilarChunk =>
    chunk({ id, title, similarity, sourceId })

  it('同產品不同面向卡（共用品牌/型號 run）併成一張代表卡，保留分數高者', () => {
    const input = [
      c('a', 'SHARP頂級A咖iBarista智慧咖啡機', 0.76, 's1'),
      c('b', 'iBarista 咖啡機隨附配件', 0.74, 's2'),
      c('c', 'iBarista 咖啡機募資資訊', 0.74, 's2'),
    ]
    // 三張都含 "ibarista" → 併成一組，rep 是分數最高的 a
    expect(collapseSameProduct(input).map(x => x.id)).toEqual(['a'])
  })

  it('不同品牌（gplus vs nwt）標題無共用 run → 各自獨立', () => {
    const input = [
      c('g', 'GPLUS居不可濕除濕機GD-B001', 0.74),
      c('n', 'NWT威技抽取式除濕機WDH31B16E', 0.73),
    ]
    expect(collapseSameProduct(input).map(x => x.id)).toEqual(['g', 'n'])
  })

  it('別名對照:同一台的兩個中文叫法(上好ㄟ ↔ NWT 威技)合併成一組', () => {
    // 實測災情:兩個叫法字面完全不同、來源不同、標題無共用英數 → 被當成兩台,
    // 反問要客人二選一、問出貨時間會並列成兩台的答案
    const input = [
      chunk({ id: 'x', title: '出貨進度', similarity: 0.8, sourceId: 's1', productName: '上好ㄟ抽取式除濕機' }),
      chunk({ id: 'y', title: '出貨時間說明', similarity: 0.78, sourceId: 's2', productName: 'NWT 威技 新一級能效 16L 高效抽取型除濕機' }),
    ]
    // 沒有對照表時仍是兩台(維持既有行為,不亂併)
    expect(collapseSameProduct(input).map(x => x.id)).toEqual(['x', 'y'])
    // 有對照表 → 併成一台,代表卡取分數高者
    const aliases = { [normalizeProductName('上好ㄟ抽取式除濕機')]: 'NWT 威技 新一級能效 16L 高效抽取型除濕機' }
    expect(collapseSameProduct(input, aliases).map(x => x.id)).toEqual(['x'])
  })

  it('只差標點的產品名自動視為同一台(不必人工確認)', () => {
    const input = [
      chunk({ id: 'a', title: '特色', similarity: 0.8, sourceId: 's1', productName: 'MATELASER《筋牌特務》 W1 REGEN' }),
      chunk({ id: 'b', title: '保固', similarity: 0.7, sourceId: 's2', productName: 'MATELASER 筋牌特務 W1 REGEN' }),
    ]
    expect(collapseSameProduct(input).map(x => x.id)).toEqual(['a'])
  })

  it('純中文品名無英數 → 退回 sourceId 判定（同 source 併、否則獨立）', () => {
    const input = [
      c('a', '兩全奇美燈保固政策', 0.74, 'lamp'),
      c('b', '兩全奇美燈產品特色', 0.73, 'lamp'),
      c('d', '上好ㄟ抽取式除濕機', 0.72, 'dehum'),
    ]
    // 前兩張同 source → 併；第三張不同 source → 留
    expect(collapseSameProduct(input).map(x => x.id)).toEqual(['a', 'd'])
  })

  it('中文屬性卡跨來源、標題無共用英數 → 靠 productName 併（治本）', () => {
    const cp = (id: string, title: string, sim: number, sourceId: string, productName: string): SimilarChunk =>
      chunk({ id, title, similarity: sim, sourceId, productName })
    const input = [
      cp('a', '上好ㄟ抽取式除濕機產品說明', 0.77, 's_faq', '上好ㄟ 除濕機'),
      cp('b', '上好ㄟ抽取式除濕機產品介紹', 0.75, 's_news', '上好ㄟ 除濕機'),
      cp('c', 'GPLUS除濕機保固政策', 0.74, 's_gplus', 'GPLUS 除濕機'),
    ]
    // a、b 同 productName（不同 source、標題無共用英數）→ 併；c 不同產品 → 留
    expect(collapseSameProduct(input).map(x => x.id)).toEqual(['a', 'c'])
  })
})

describe('productNamedInQuery', () => {
  const c = (id: string, title: string): SimilarChunk => chunk({ id, title })
  const g = (...members: SimilarChunk[]): SimilarChunk[] => members

  it('query 用品牌詞指名唯一一個產品 → 回該群組代表卡', () => {
    const groups = [
      g(c('bal', 'Balzano百佳諾義式咖啡機')),
      g(c('ib', 'iBarista 咖啡機保固與客服')),
    ]
    expect(productNamedInQuery('ibarista保固多久', groups)?.card.id).toBe('ib')
  })

  it('精確型號落在「非代表卡」的成員上也能指名 → 回該組代表卡（P1-2/P1-3 交互）', () => {
    const groups = [
      // NWT 組：代表卡是 16L高效（無 WDH 型號），成員裡才有 WDH-16EF
      g(c('nwt-rep', 'NWT威技16L高效抽取型除濕機'), c('nwt-wdh', 'NWT威技一級能效16L除濕機WDH-16EF')),
      g(c('up', '上好ㄟ抽取式除濕機')),
    ]
    expect(productNamedInQuery('WDH-16EF這台保固多久', groups)?.card.id).toBe('nwt-rep')
  })

  it('純中文 query（無英數品牌詞）→ 不算指名 → null（避免中文 bigram 跨界假命中）', () => {
    const groups = [
      g(c('bal', 'Balzano百佳諾義式咖啡機')),
      g(c('ib', 'iBarista 咖啡機保固與客服')),
    ]
    expect(productNamedInQuery('咖啡機好用嗎', groups)).toBeNull()
  })

  it('中文品類+屬性詞（除濕機保固）不該誤判成指名某品牌 → null', () => {
    const groups = [
      g(c('a', 'GPLUS除濕機保固優惠')),
      g(c('b', '上好ㄟ抽取式除濕機')),
    ]
    // 只認英數品牌詞;query 全中文 → null（不會被跨界 bigram「機保」誤命中 GPLUS）
    expect(productNamedInQuery('除濕機保固多久', groups)).toBeNull()
  })

  it('英數品類詞被多群組共用（都含 coffee）→ 不算指名 → null', () => {
    const groups = [
      g(c('bal', 'Balzano coffee machine')),
      g(c('ib', 'iBarista coffee machine')),
    ]
    expect(productNamedInQuery('coffee good?', groups)).toBeNull()
  })

  it('中文品名 whole-segment 指名（粒粒安 到貨）→ 回該組代表卡，tier=exact', () => {
    const groups = [
      g(c('rice', '粒粒安 飛利浦 無塗層 IH 智慧電子鍋 (HD5225/HD7000)')),
      g(c('dry', '上好ㄟ抽取式除濕機 出貨進度')),
      g(c('pkt', 'Poketomo 小獴友 出貨時間')),
    ]
    const m = productNamedInQuery('我有買粒粒安的早鳥，想問大概何時可收到貨', groups)
    expect(m?.card.id).toBe('rice')
    expect(m?.tier).toBe('exact')
  })

  it('中文品名打錯字（粒立安）→ 編輯距離容錯仍指名，tier=fuzzy', () => {
    const groups = [
      g(c('rice', '粒粒安 飛利浦 IH 電子鍋')),
      g(c('dry', '上好ㄟ抽取式除濕機')),
    ]
    const m = productNamedInQuery('粒立安什麼時候到貨', groups)
    expect(m?.card.id).toBe('rice')
    expect(m?.tier).toBe('fuzzy')
  })

  it('中文品名諧音（利利安 / 麗麗安）→ 拼音整段吻合仍指名，tier=fuzzy', () => {
    const groups = [
      g(c('rice', '粒粒安 飛利浦 IH 電子鍋')),
      g(c('dry', '上好ㄟ抽取式除濕機')),
    ]
    const li = productNamedInQuery('利利安到貨了嗎', groups)
    expect(li?.card.id).toBe('rice')
    expect(li?.tier).toBe('fuzzy')
    expect(productNamedInQuery('麗麗安到貨了嗎', groups)?.card.id).toBe('rice')
  })

  it('中文品名 whole-segment 被多組共用（都叫 除濕機）→ 不算指名 → null', () => {
    const groups = [
      g(c('a', '除濕機 A 型')),
      g(c('b', '除濕機 B 型')),
    ]
    expect(productNamedInQuery('除濕機保固多久', groups)).toBeNull()
  })

  it('擦邊球不因「品類+屬性」長字串重疊而誤命中（除濕機保固多久 vs 除濕機保固優惠）→ null', () => {
    const groups = [
      g(c('a', 'GPLUS除濕機保固優惠')),
      g(c('b', '上好ㄟ抽取式除濕機')),
    ]
    expect(productNamedInQuery('除濕機保固多久', groups)).toBeNull()
  })
})

describe('buildNamedGuessConfirm', () => {
  const c = (id: string, title: string): SimilarChunk => chunk({ id, title })

  it('造出單一猜測選項 + 帶產品名的反問語（去掉品號括號）', () => {
    const payload = buildNamedGuessConfirm(c('rice', '粒粒安 飛利浦 無塗層 IH 智慧電子鍋 (HD5225/HD7000)'))
    expect(payload.options).toHaveLength(1)
    expect(payload.options[0]!.chunkId).toBe('rice')
    // 送出的 text 用完整原標題（供下一輪精確命中）
    expect(payload.options[0]!.title).toBe('粒粒安 飛利浦 無塗層 IH 智慧電子鍋 (HD5225/HD7000)')
    // 反問語含產品名、且不含品號括號與裝飾符號
    expect(payload.clarification).toContain('粒粒安')
    expect(payload.clarification).not.toContain('HD5225')
    expect(payload.clarification).not.toMatch(/[⟣⟢◇◆｜]/)
    expect(payload.options[0]!.label!).not.toMatch(/[⟣⟢◇◆｜]/)
    // 按鈕 label ≤ 20（LINE 規格）
    expect(payload.options[0]!.label!.length).toBeLessThanOrEqual(20)
  })
})

describe('cleanProductLabel', () => {
  it('去掉裝飾符號與括號品號、收斂空白', () => {
    expect(cleanProductLabel('⟣ 粒粒安 ⟢ 飛利浦 無塗層 IH 智慧電子鍋 (HD5225/HD7000)'))
      .toBe('粒粒安 飛利浦 無塗層 IH 智慧電子鍋')
    expect(cleanProductLabel('SHARP 頂級A咖｜iBarista 智慧咖啡機')).toBe('SHARP 頂級A咖 iBarista 智慧咖啡機')
    expect(cleanProductLabel('★MYFEEL全品項總覽')).toBe('MYFEEL全品項總覽')
  })
})

describe('taiwanTodayLabel', () => {
  it('以台灣時區換日（UTC 晚上 10 點 = 台灣隔天早上 6 點）', () => {
    expect(taiwanTodayLabel(new Date('2026-07-31T22:00:00Z'))).toBe('2026年8月1日')
    expect(taiwanTodayLabel(new Date('2026-07-31T10:00:00Z'))).toBe('2026年7月31日')
  })
})

describe('isUnresolvedFeedback', () => {
  const history = [
    { role: 'user' as const, text: '除濕機沒反應' },
    { role: 'bot' as const, text: '請檢查插座並排空水箱試試看喔。' },
  ]

  it('bot 剛回答過 + 整句無效回報 → true', () => {
    expect(isUnresolvedFeedback('還是一樣', history)).toBe(true)
    expect(isUnresolvedFeedback('還是不行', history)).toBe(true)
    expect(isUnresolvedFeedback('沒用', history)).toBe(true)
    expect(isUnresolvedFeedback('試過了還是不行', history)).toBe(true)
    expect(isUnresolvedFeedback('還是一樣!!', history)).toBe(true)
  })

  it('帶新問題的句子不誤中（非全等）', () => {
    expect(isUnresolvedFeedback('價格還是一樣嗎', history)).toBe(false)
    expect(isUnresolvedFeedback('還是一樣要收運費嗎', history)).toBe(false)
    expect(isUnresolvedFeedback('換了插座還是一樣,水箱也排空了,還有什麼方法', history)).toBe(false)
  })

  it('上一句不是 bot 回覆 → false（冷啟動亂丟不觸發）', () => {
    expect(isUnresolvedFeedback('還是一樣', [])).toBe(false)
    expect(isUnresolvedFeedback('還是一樣', undefined)).toBe(false)
    expect(isUnresolvedFeedback('還是一樣', [{ role: 'user', text: '哈囉' }])).toBe(false)
  })
})
