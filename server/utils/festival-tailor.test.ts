import { describe, expect, it } from 'vitest'
import {
  buildTailorPrompt,
  rejectTailoredAngle,
  splitProfileProducts,
  TAILORED_ANGLE_MAX,
  TAILORED_ANGLE_TARGET,
  normalizeTailoredAngle,
} from './festival-tailor'
import { emptyStoreProfile, setStoreProfileField, type StoreProfileDoc } from '~~/shared/types/store-profile'
import { TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'

function profileOf(over: Record<string, string> = {}): StoreProfileDoc {
  let p = emptyStoreProfile()
  const base: Record<string, string> = {
    industry: '零售／電商',
    products: '黑豆水、養生茶包、節慶禮盒｜NT$180–1,280',
    customers: '一般消費者',
    channel: '網購為主',
    ...over,
  }
  for (const [k, v] of Object.entries(base)) {
    if (v) p = setStoreProfileField(p, k as never, v, 'owner', 1)
  }
  return p
}

const midAutumn = TAIWAN_FESTIVALS.find(f => f.name === '中秋節')!

describe('splitProfileProducts', () => {
  it('價格帶那半要切掉（它不是商品名）', () => {
    expect(splitProfileProducts(profileOf())).toEqual(['黑豆水', '養生茶包', '節慶禮盒'])
  })
  it('沒填商品回空陣列', () => {
    expect(splitProfileProducts(profileOf({ products: '' }))).toEqual([])
  })
  it('最多三樣', () => {
    expect(splitProfileProducts(profileOf({ products: 'A商品、B商品、C商品、D商品' }))).toHaveLength(3)
  })
  it('一個字的碎片不算商品（切壞的殘渣）', () => {
    expect(splitProfileProducts(profileOf({ products: '黑豆水、、茶' }))).toEqual(['黑豆水'])
  })
})

describe('rejectTailoredAngle', () => {
  const p = profileOf()
  const ok = '中秋送禮的人最多，把節慶禮盒做成兩入組合推給買過黑豆水的客人。'

  it('正常的一句話放行', () => {
    expect(rejectTailoredAngle(ok, p)).toBeNull()
  })

  it('空的擋掉', () => {
    expect(rejectTailoredAngle('', p)).toBe('空的')
    expect(rejectTailoredAngle('   ', p)).toBe('空的')
  })

  it('⛔ 太長擋掉（這句要塞進一則 LINE 訊息）', () => {
    expect(rejectTailoredAngle('黑豆水'.repeat(TAILORED_ANGLE_MAX), p)).toContain('太長')
  })

  it('⛔ 出現金額一律擋（我們不知道他賣多少錢）', () => {
    expect(rejectTailoredAngle('把節慶禮盒賣 NT$599。', p)).toBe('出現了金額')
    expect(rejectTailoredAngle('節慶禮盒訂 599 元就好。', p)).toBe('出現了金額')
    expect(rejectTailoredAngle('用新台幣訂價推節慶禮盒。', p)).toBe('出現了金額')
  })

  it('⛔ 換行或條列擋掉', () => {
    expect(rejectTailoredAngle('推節慶禮盒\n再推黑豆水', p)).toBe('有換行或條列')
    expect(rejectTailoredAngle('1. 推節慶禮盒', p)).toBe('有換行或條列')
  })

  it('⛔ 把 prompt 的欄位名抄回來要擋', () => {
    expect(rejectTailoredAngle('主打商品：節慶禮盒', p)).toBe('抄到了欄位名')
  })

  it('⛔ 講了商品卻沒有一個對得上輪廓 → 擋（掰一個他沒賣的比講通用句還傷）', () => {
    expect(rejectTailoredAngle('推出中秋月餅禮盒商品組合給送禮的人。', p)).toContain('對得上')
  })

  it('沒提到商品、只講客群或節奏 → 放行（那也是有用的建議）', () => {
    expect(rejectTailoredAngle('提早兩週開賣，讓送禮的客人有時間決定。', p)).toBeNull()
  })

  it('輪廓沒填商品時不套「要對得上」那條（會把所有句子擋光）', () => {
    const noProd = profileOf({ products: '' })
    expect(rejectTailoredAngle('把應景商品提早兩週開賣。', noProd)).toBeNull()
  })

  it('百分比折扣不擋（那是建議，不是我們不知道的事實）', () => {
    expect(rejectTailoredAngle('節慶禮盒做兩入八折，推給送禮的客人。', p)).toBeNull()
  })
})

describe('normalizeTailoredAngle', () => {
  it('⛔ 句尾標點要拿掉（模板後面接的是「，建議這幾天…」，不拿掉會撞成「。，」）', () => {
    // 2026-09-23 實測當場看到：「…輕鬆傳遞心意。，建議這幾天…」
    expect(normalizeTailoredAngle('主打節慶禮盒組合。', '中秋節')).toBe('主打節慶禮盒組合')
    expect(normalizeTailoredAngle('主打節慶禮盒組合！', '中秋節')).toBe('主打節慶禮盒組合')
  })

  it('⛔ 開頭重複節日名要拿掉（前面那句已經講過一次了）', () => {
    // 實測：「再過 7 天就是中秋節（09/25）。中秋節將至，主打…」
    expect(normalizeTailoredAngle('中秋節將至，主打節慶禮盒', '中秋節')).toBe('主打節慶禮盒')
    expect(normalizeTailoredAngle('中秋節，主打節慶禮盒', '中秋節')).toBe('主打節慶禮盒')
    expect(normalizeTailoredAngle('雙 11 快到了，主打囤貨組合', '雙 11 購物節')).toBe('雙 11 快到了，主打囤貨組合')
  })

  it('⛔ 開頭的稱呼要拿掉（這句被塞在句子中間，呼語讀不通）', () => {
    expect(normalizeTailoredAngle('老闆，雙 11 該推染髮預約', '雙 11 購物節')).toBe('雙 11 該推染髮預約')
  })

  it('包住整句的引號要拿掉', () => {
    expect(normalizeTailoredAngle('「主打節慶禮盒」', '中秋節')).toBe('主打節慶禮盒')
  })

  it('句子中間的引號不可以動（商品名常被引號括起來）', () => {
    expect(normalizeTailoredAngle('主打「節慶禮盒」與「養生茶包」組合', '中秋節')).toBe('主打「節慶禮盒」與「養生茶包」組合')
  })

  it('空的進去、空的出來，不炸', () => {
    expect(normalizeTailoredAngle('', '中秋節')).toBe('')
    expect(normalizeTailoredAngle(undefined as never, '中秋節')).toBe('')
  })

  it('沒給節日名也不會炸（正規表示式不可以吃到空字串）', () => {
    expect(normalizeTailoredAngle('主打節慶禮盒。')).toBe('主打節慶禮盒')
  })
})

describe('buildTailorPrompt', () => {
  it('節日、天數、通用切角、店家輪廓都要進去', () => {
    const t = buildTailorPrompt(profileOf(), midAutumn, 7)
    expect(t).toContain('中秋節')
    expect(t).toContain('還有 7 天')
    expect(t).toContain(midAutumn.angle)
    expect(t).toContain('黑豆水')
    expect(t).toContain('一般消費者')
  })

  it('⛔ 一定要寫「只能用上面列出的商品」與「不准出現金額」', () => {
    const t = buildTailorPrompt(profileOf(), midAutumn, 7)
    expect(t).toContain('只能用上面列出的商品')
    expect(t).toContain('不准出現任何金額')
  })

  it('⛔ 跟模型要的字數要比上限低一截（實測要 60 會寫到 74 而被整句退掉）', () => {
    const t = buildTailorPrompt(profileOf(), midAutumn, 7)
    expect(t).toContain(`${TAILORED_ANGLE_TARGET} 字以內`)
    expect(TAILORED_ANGLE_TARGET).toBeLessThan(TAILORED_ANGLE_MAX)
  })

  it('⛔ 要叫它不要重複節日名、不要稱呼開頭、句尾不要句號', () => {
    const t = buildTailorPrompt(profileOf(), midAutumn, 7)
    expect(t).toContain('開頭不要再提一次「中秋節」')
    expect(t).toContain('句尾不要句號')
  })

  it('沒填商品時不會留下一個空括號', () => {
    const t = buildTailorPrompt(profileOf({ products: '' }), midAutumn, 7)
    expect(t).not.toContain('（）')
  })
})
