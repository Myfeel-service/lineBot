import { describe, expect, it } from 'vitest'
import {
  describeMissing,
  describeSiteRead,
  emptyStoreProfile,
  filledFieldCount,
  isStoreProfileReady,
  markStoreProfileMissing,
  mergeAiGuesses,
  normalizeSiteUrl,
  normalizeStoreProfile,
  setStoreProfileField,
  storeProfileAskStepCount,
  storeProfileAskSteps,
  storeProfileFieldDef,
  storeProfileForPrompt,
  STORE_PROFILE_FIELDS,
  STORE_PROFILE_VALUE_MAX,
  type StoreProfileDoc,
} from './store-profile'

/** 走完精靈五題的輪廓（商家自己答的） */
function answeredByOwner(): StoreProfileDoc {
  let p = emptyStoreProfile()
  p = setStoreProfileField(p, 'industry', '零售／電商', 'owner', 1000)
  p = setStoreProfileField(p, 'products', '黑豆水、養生茶包', 'owner', 1000)
  p = setStoreProfileField(p, 'customers', '一般消費者', 'owner', 1000)
  p = setStoreProfileField(p, 'channel', '網購為主', 'owner', 1000)
  p = setStoreProfileField(p, 'pain', '加好友後沒人理', 'owner', 1000)
  return p
}

describe('欄位定義表', () => {
  it('每個欄位的 id 唯一', () => {
    const ids = STORE_PROFILE_FIELDS.map(f => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('要問的題目一定有問法，不問的一定沒有 askStep', () => {
    for (const f of STORE_PROFILE_FIELDS) {
      if (f.askStep != null) expect(f.question, `${f.id} 有 askStep 卻沒有問法`).toBeTruthy()
      else expect(f.question, `${f.id} 沒有 askStep 卻有問法`).toBeNull()
    }
  })

  it('精靈剛好問五步（承諾「五題」的那個數字）', () => {
    expect(storeProfileAskStepCount()).toBe(5)
  })

  it('askStep 從 1 連號到 5，沒有跳號', () => {
    const steps = storeProfileAskSteps().map(s => s.step)
    expect(steps).toEqual([1, 2, 3, 4, 5])
  })

  it('AI 猜不到的欄位不給 aiHint（免得 prompt 裡出現一句沒人用的說明）', () => {
    for (const f of STORE_PROFILE_FIELDS) {
      if (!f.aiCanGuess) expect(f.aiHint, `${f.id}`).toBe('')
      else expect(f.aiHint.length, `${f.id}`).toBeGreaterThan(0)
    }
  })

  it('沒有值時每個欄位都講得出一句話', () => {
    for (const f of STORE_PROFILE_FIELDS) expect(f.emptyHint.length).toBeGreaterThan(0)
  })

  it('查得到定義，查不到的回 null 不是 throw', () => {
    expect(storeProfileFieldDef('industry')?.label).toBe('產業與品類')
    expect(storeProfileFieldDef('已經拿掉的舊欄位')).toBeNull()
  })
})

describe('normalizeStoreProfile', () => {
  it('空的／壞掉的輸入回空輪廓，不炸', () => {
    expect(normalizeStoreProfile(undefined).fields).toEqual({})
    expect(normalizeStoreProfile(null).siteUrl).toBe('')
    expect(normalizeStoreProfile('字串').fields).toEqual({})
  })

  it('不認得的欄位 id 直接丟掉', () => {
    const p = normalizeStoreProfile({ fields: { industry: { value: '餐飲', source: 'owner', updatedAt: 1 }, 舊欄位: { value: 'x', source: 'owner', updatedAt: 1 } } })
    expect(p.fields.industry?.value).toBe('餐飲')
    expect((p.fields as Record<string, unknown>).舊欄位).toBeUndefined()
  })

  it('⛔ 不認得的 source 降成 ai，不可以升成 owner', () => {
    const p = normalizeStoreProfile({ fields: { industry: { value: '餐飲', source: '亂寫的', updatedAt: 1 } } })
    expect(p.fields.industry?.source).toBe('ai')
  })

  it('沒有值的欄位一定帶得出 missing 分型', () => {
    const p = normalizeStoreProfile({ fields: { rivals: { value: '', source: 'ai', updatedAt: 1 } } })
    expect(p.fields.rivals?.missing).toBe('never_asked')
    const q = normalizeStoreProfile({ fields: { rivals: { value: '', source: 'ai', missing: 'not_in_source', updatedAt: 1 } } })
    expect(q.fields.rivals?.missing).toBe('not_in_source')
  })

  it('有值的欄位不會被塞 missing', () => {
    const p = normalizeStoreProfile({ fields: { industry: { value: '餐飲', source: 'owner', missing: 'not_in_source', updatedAt: 1 } } })
    expect(p.fields.industry?.missing).toBeUndefined()
  })

  it('值超長會被截斷', () => {
    const long = 'あ'.repeat(STORE_PROFILE_VALUE_MAX + 50)
    const p = normalizeStoreProfile({ fields: { products: { value: long, source: 'owner', updatedAt: 1 } } })
    expect(p.fields.products?.value.length).toBe(STORE_PROFILE_VALUE_MAX)
  })

  it('壞掉的 updatedAt 變 0 而不是 NaN', () => {
    const p = normalizeStoreProfile({ fields: { industry: { value: '餐飲', source: 'owner', updatedAt: 'x' } } })
    expect(p.fields.industry?.updatedAt).toBe(0)
  })

  it('讀網站結果正規化：不認得的狀態一律當失敗，不當成功', () => {
    const p = normalizeStoreProfile({ siteRead: { status: '亂寫', pagesRead: 3, at: 5 } })
    expect(p.siteRead?.status).toBe('failed')
  })

  it('讀網站失敗清單的原因不認得就 unknown', () => {
    const p = normalizeStoreProfile({ siteRead: { status: 'partial', pagesRead: 1, pagesFailed: [{ url: 'https://a.tw/x', reason: '亂寫' }], at: 5 } })
    expect(p.siteRead?.pagesFailed[0]).toEqual({ url: 'https://a.tw/x', reason: 'unknown' })
  })
})

describe('normalizeSiteUrl', () => {
  it('有協定的原樣留著', () => {
    expect(normalizeSiteUrl('https://a.example.tw/x')).toBe('https://a.example.tw/x')
  })
  it('長得像網域的補 https', () => {
    expect(normalizeSiteUrl('shop.example.tw')).toBe('https://shop.example.tw')
  })
  it('完全不像網址的存空', () => {
    expect(normalizeSiteUrl('我沒有網站')).toBe('')
  })
  it('⛔ 補過協定的再跑一次不會被清掉（normalize 讀取時也會跑）', () => {
    expect(normalizeSiteUrl(normalizeSiteUrl('shop.example.tw'))).toBe('https://shop.example.tw')
  })
})

describe('setStoreProfileField', () => {
  it('商家寫的自動帶 ownerEdited', () => {
    const p = setStoreProfileField(emptyStoreProfile(), 'industry', '餐飲／飲料', 'owner', 7)
    expect(p.fields.industry).toEqual({ value: '餐飲／飲料', source: 'owner', ownerEdited: true, updatedAt: 7 })
  })
  it('AI 寫的不帶 ownerEdited', () => {
    const p = setStoreProfileField(emptyStoreProfile(), 'tone', '親切', 'ai', 7)
    expect(p.fields.tone?.ownerEdited).toBeUndefined()
  })
  it('不改到原來那份（純函式）', () => {
    const before = emptyStoreProfile()
    setStoreProfileField(before, 'industry', '餐飲', 'owner')
    expect(before.fields.industry).toBeUndefined()
  })
})

describe('mergeAiGuesses', () => {
  it('⛔ 商家改過的欄位不被覆蓋，而且要講得出跳過了哪幾格', () => {
    const p = answeredByOwner()
    const r = mergeAiGuesses(p, { industry: 'AI 猜的別的產業', tone: '親切、不誇大' }, 2000)
    expect(r.profile.fields.industry?.value).toBe('零售／電商')
    expect(r.profile.fields.industry?.source).toBe('owner')
    expect(r.skippedOwnerEdited).toContain('industry')
    expect(r.filled).toContain('tone')
  })

  it('AI 猜不到的欄位（旺季、最想解決）完全不碰', () => {
    const p = emptyStoreProfile()
    const r = mergeAiGuesses(p, { season: '夏天', pain: '客服回不完' } as Record<string, string>, 2000)
    expect(r.profile.fields.season).toBeUndefined()
    expect(r.profile.fields.pain).toBeUndefined()
  })

  it('AI 沒給值的可猜欄位標成「找過了，來源沒提到」', () => {
    const r = mergeAiGuesses(emptyStoreProfile(), { tone: '親切' }, 2000)
    expect(r.profile.fields.rivals?.missing).toBe('not_in_source')
    expect(r.profile.fields.rivals?.value).toBe('')
  })

  it('AI 沒給值時，已經有值的欄位不會被清空', () => {
    let p = emptyStoreProfile()
    p = setStoreProfileField(p, 'tone', '之前猜到的語氣', 'ai', 1000)
    const r = mergeAiGuesses(p, {}, 2000)
    expect(r.profile.fields.tone?.value).toBe('之前猜到的語氣')
  })

  it('空白字串不算值（只有空格的猜測要當成沒猜到）', () => {
    const r = mergeAiGuesses(emptyStoreProfile(), { tone: '   ' }, 2000)
    expect(r.profile.fields.tone?.missing).toBe('not_in_source')
    expect(r.filled).not.toContain('tone')
  })
})

describe('markStoreProfileMissing', () => {
  it('已經有值的欄位不會被標成沒有', () => {
    let p = emptyStoreProfile()
    p = setStoreProfileField(p, 'tone', '親切', 'ai', 1)
    const q = markStoreProfileMissing(p, 'tone', 'not_in_source', 'ai', 2)
    expect(q.fields.tone?.value).toBe('親切')
  })
  it('保留 ownerEdited（商家清空過的欄位仍然是他的）', () => {
    let p = emptyStoreProfile()
    p = setStoreProfileField(p, 'rivals', '', 'owner', 1)
    const q = markStoreProfileMissing(p, 'rivals', 'not_in_source', 'ai', 2)
    expect(q.fields.rivals?.ownerEdited).toBe(true)
  })
})

describe('isStoreProfileReady', () => {
  it('沒有輪廓＝不認識', () => {
    expect(isStoreProfileReady(null)).toBe(false)
    expect(isStoreProfileReady(emptyStoreProfile())).toBe(false)
  })

  it('⛔ AI 猜滿整份也不算認識（沒有商家親自答的題）', () => {
    const r = mergeAiGuesses(emptyStoreProfile(), {
      industry: '零售', products: '茶包', customers: '一般消費者', channel: '網購', tone: '親切', faq: '出貨', rivals: '某某',
    }, 1)
    expect(isStoreProfileReady(r.profile)).toBe(false)
  })

  it('商家答滿五題＝認識', () => {
    expect(isStoreProfileReady(answeredByOwner())).toBe(true)
  })

  it('商家只答兩題還不算（門檻是三題）', () => {
    let p = emptyStoreProfile()
    p = setStoreProfileField(p, 'industry', '零售', 'owner', 1)
    p = setStoreProfileField(p, 'products', '茶包', 'owner', 1)
    expect(isStoreProfileReady(p)).toBe(false)
    p = setStoreProfileField(p, 'customers', '一般消費者', 'owner', 1)
    expect(isStoreProfileReady(p)).toBe(true)
  })

  it('商家沒答、但被 AI 蓋過的欄位不算數', () => {
    let p = emptyStoreProfile()
    p = setStoreProfileField(p, 'industry', '零售', 'ai', 1)
    p = setStoreProfileField(p, 'products', '茶包', 'ai', 1)
    p = setStoreProfileField(p, 'customers', '一般消費者', 'ai', 1)
    expect(isStoreProfileReady(p)).toBe(false)
  })
})

describe('講給人看的字', () => {
  it('「還沒問」與「讀了但沒提到」講的不是同一句', () => {
    const def = storeProfileFieldDef('rivals')!
    expect(describeMissing(def, 'never_asked')).not.toBe(describeMissing(def, 'not_in_source'))
    expect(describeMissing(def, 'not_in_source')).toContain('沒提到')
  })

  it('沒讀過、全讀到、讀一半、讀不到各講各的', () => {
    expect(describeSiteRead(undefined)).toContain('還沒有讀過')
    expect(describeSiteRead({ status: 'ok', pagesRead: 5, pagesFailed: [], at: 1 })).toContain('5 頁')
    const partial = describeSiteRead({ status: 'partial', pagesRead: 3, pagesFailed: [{ url: 'https://a.tw/x', reason: 'timeout' }], at: 1 })
    expect(partial).toContain('一部分')
    expect(partial).toContain('1 頁讀不到')
    expect(describeSiteRead({ status: 'failed', pagesRead: 0, pagesFailed: [], reason: 'blocked', at: 1 })).toContain('擋住')
  })

  it('⛔ 讀一半不可以跟全讀到講同一句話', () => {
    const ok = describeSiteRead({ status: 'ok', pagesRead: 3, pagesFailed: [], at: 1 })
    const partial = describeSiteRead({ status: 'partial', pagesRead: 3, pagesFailed: [{ url: 'https://a.tw/x', reason: 'empty' }], at: 1 })
    expect(ok).not.toBe(partial)
  })
})

describe('storeProfileForPrompt', () => {
  it('沒有輪廓回空字串（呼叫端要走通用句那條路）', () => {
    expect(storeProfileForPrompt(null)).toBe('')
    expect(storeProfileForPrompt(emptyStoreProfile())).toBe('')
  })

  it('⛔ 只放有值的欄位，「還沒有」不進 prompt', () => {
    const r = mergeAiGuesses(answeredByOwner(), { tone: '親切' }, 1)
    const text = storeProfileForPrompt(r.profile)
    expect(text).toContain('產業與品類：零售／電商')
    expect(text).toContain('品牌語氣：親切')
    expect(text).not.toContain('競爭對手')
    expect(text).not.toContain('還沒有')
  })

  it('照欄位表的順序排（卡片與 prompt 同一個順序）', () => {
    const text = storeProfileForPrompt(answeredByOwner())
    expect(text.indexOf('產業與品類')).toBeLessThan(text.indexOf('主打商品'))
    expect(text.indexOf('主打商品')).toBeLessThan(text.indexOf('主要客群'))
  })
})

describe('filledFieldCount', () => {
  it('只數真的有值的', () => {
    expect(filledFieldCount(emptyStoreProfile())).toBe(0)
    expect(filledFieldCount(answeredByOwner())).toBe(5)
    const r = mergeAiGuesses(answeredByOwner(), { tone: '親切' }, 1)
    expect(filledFieldCount(r.profile)).toBe(6)
  })
})
