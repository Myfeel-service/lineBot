import { describe, expect, it } from 'vitest'
import {
  BROADCAST_COPY_MAX,
  BROADCAST_COPY_TARGET,
  buildCopyPrompt,
  buildProposalCopyPrompt,
  dedupeVariants,
  rejectBroadcastCopy,
  rejectProposalCopy,
  tooSimilar,
} from './broadcast-copy-gen'
import { emptyStoreProfile, setStoreProfileField, type StoreProfileDoc } from '~~/shared/types/store-profile'
import { TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'
import { BROADCAST_DRAFT_VARIANTS } from '~~/shared/broadcast-draft-handoff'

const midAutumn = TAIWAN_FESTIVALS.find(f => f.name === '中秋節')!

function profileOf(over: Record<string, string> = {}): StoreProfileDoc {
  let p = emptyStoreProfile()
  const base: Record<string, string> = {
    industry: '零售／電商',
    products: '黑豆水、養生茶包、節慶禮盒',
    customers: '一般消費者',
    channel: '網購為主',
    tone: '親切、不誇大',
    ...over,
  }
  for (const [k, v] of Object.entries(base)) if (v) p = setStoreProfileField(p, k as never, v, 'owner', 1)
  return p
}

describe('rejectBroadcastCopy', () => {
  const p = profileOf()

  it('正常的一則放行', () => {
    expect(rejectBroadcastCopy('中秋快到了，節慶禮盒開始接單，想送長輩的可以先留言問我們 😊', p)).toBeNull()
  })

  it('空的擋掉', () => {
    expect(rejectBroadcastCopy('   ', p)).toBe('空的')
  })

  it('⛔ 太長擋掉（客人在手機上要一眼讀完）', () => {
    expect(rejectBroadcastCopy('黑豆水'.repeat(BROADCAST_COPY_MAX), p)).toContain('太長')
  })

  it('⛔ 價格、折扣一律擋（客人會照那個數字來要）', () => {
    expect(rejectBroadcastCopy('節慶禮盒 NT$599 起。', p)).toContain('價格或折扣')
    expect(rejectBroadcastCopy('節慶禮盒八折。', p)).toContain('價格或折扣')
    expect(rejectBroadcastCopy('節慶禮盒 599 元。', p)).toContain('價格或折扣')
    expect(rejectBroadcastCopy('節慶禮盒 8% 回饋。', p)).toContain('價格或折扣')
  })

  it('⛔ 中文數字的折扣也要抓（台灣最常見的就是這種寫法）', () => {
    // 單元測試當場抓到：原本只寫 `\d折`，「八折」整批漏掉
    for (const s of ['節慶禮盒八折', '節慶禮盒七五折', '節慶禮盒買一送一不打折但對折出清', '折扣三成']) {
      expect(rejectBroadcastCopy(s, p), s).toContain('價格或折扣')
    }
  })

  it('「折」字出現在別的詞裡不要誤擋', () => {
    // ⚠️ 對照組：擋太寬會把正常句子全殺光
    expect(rejectBroadcastCopy('中秋不打折，但我們把節慶禮盒的包裝換新了。', p)).toBeNull()
  })

  it('⛔ 期限與名額也擋（我們沒有這個資訊）', () => {
    expect(rejectBroadcastCopy('節慶禮盒限時 3 天。', p)).toContain('期限或名額')
    expect(rejectBroadcastCopy('節慶禮盒前 50 名加贈。', p)).toContain('期限或名額')
  })

  it('⛔ 變數語法要擋（這段會被原樣發給客人）', () => {
    expect(rejectBroadcastCopy('{{displayName}} 您好，節慶禮盒開賣了', p)).toBe('出現了變數語法')
  })

  it('⛔ 講了商品卻對不上輪廓 → 擋', () => {
    expect(rejectBroadcastCopy('中秋月餅商品開賣囉，快來看看。', p)).toContain('對得上')
  })

  it('沒提到商品、只講節慶氣氛 → 放行', () => {
    expect(rejectBroadcastCopy('中秋快到了，想好要送誰了嗎？我們幫你準備好了。', p)).toBeNull()
  })

  it('輪廓沒填商品時不套「要對得上」那條', () => {
    expect(rejectBroadcastCopy('中秋商品開賣囉。', profileOf({ products: '' }))).toBeNull()
  })
})

describe('tooSimilar / dedupeVariants', () => {
  it('一模一樣算重複', () => {
    expect(tooSimilar('中秋禮盒開賣', '中秋禮盒開賣')).toBe(true)
  })
  it('只差標點算重複', () => {
    expect(tooSimilar('中秋禮盒開賣！', '中秋禮盒開賣。')).toBe(true)
  })
  it('一句被另一句整個包住算重複', () => {
    expect(tooSimilar('中秋禮盒開賣', '中秋禮盒開賣，快來看看')).toBe(true)
  })
  it('切角不同的兩句不算重複', () => {
    expect(tooSimilar(
      '中秋想送長輩？節慶禮盒幫你準備好了。',
      '自己喝也可以，黑豆水一箱這幾天有現貨。',
    )).toBe(false)
  })
  it('去重保留先來的那一版', () => {
    expect(dedupeVariants(['甲案內容', '甲案內容！', '乙案完全不同的句子'])).toEqual(['甲案內容', '乙案完全不同的句子'])
  })
  it('空陣列不炸', () => {
    expect(dedupeVariants([])).toEqual([])
  })
})

describe('buildCopyPrompt', () => {
  const t = buildCopyPrompt(profileOf(), midAutumn, '親切、不誇大')

  it('節日、商品、口氣都要進去', () => {
    expect(t).toContain('中秋節')
    expect(t).toContain('黑豆水')
    expect(t).toContain('親切、不誇大')
  })

  it('⛔ 三條紅線都要寫進 prompt', () => {
    expect(t).toContain('只能提到上面列出的商品')
    expect(t).toContain('不准出現任何價格、折扣數字、期限或名額')
    expect(t).toContain('不准使用')
  })

  it('⛔ 跟模型要的字數要比上限低一截（C-223 實測要上限值它就會超過）', () => {
    expect(t).toContain(`${BROADCAST_COPY_TARGET} 字以內`)
    expect(BROADCAST_COPY_TARGET).toBeLessThan(BROADCAST_COPY_MAX)
  })

  it('⛔ 要叫它三版明顯不一樣（三句雷同等於只給一版）', () => {
    expect(t).toContain('明顯不一樣')
    expect(t).toContain(`${BROADCAST_DRAFT_VARIANTS} 版`)
  })

  it('沒填商品時不會留下空括號', () => {
    expect(buildCopyPrompt(profileOf({ products: '' }), midAutumn, '')).not.toContain('（）')
  })

  it('`D-122`②：自己的檔期講「這是店家自己的檔期」，⛔ 不塞一行空的「通用切角：」', () => {
    const own = { id: 'own-anniv00001', date: '2026-10-24', name: '週年慶', angle: '', own: true }
    const p = buildCopyPrompt(profileOf(), own, '')
    expect(p).toContain('檔期：週年慶（2026-10-24）')
    expect(p).toContain('店家自己的檔期')
    expect(p).not.toContain('通用切角')
    // 節日照舊（對照組）
    expect(t).toContain('這個節日的通用切角：禮盒與送禮的需求會明顯升溫')
  })
})

describe('好友統計行銷提案的文案（D-155）', () => {
  const water = profileOf({ products: '淨水系統、濾芯' })

  it('⛔ 讓客人覺得被觀察的說法一律擋（「我們注意到你」「系統判斷你」）', () => {
    expect(rejectProposalCopy('我們注意到你最近在看淨水系統', water)).toBe('寫出了「我們在觀察你」的話')
    expect(rejectProposalCopy('系統判斷你可能需要濾芯', water)).toBe('寫出了「我們在觀察你」的話')
    expect(rejectProposalCopy('根據你的紀錄，推薦濾芯', water)).toBe('寫出了「我們在觀察你」的話')
  })

  it('⛔ 寫成「您」也一樣擋（店家口氣設成「您」時 AI 就會這樣寫）', () => {
    expect(rejectProposalCopy('我們注意到您最近在看淨水系統', water)).toBe('寫出了「我們在觀察你」的話')
    expect(rejectProposalCopy('根據您的紀錄，推薦濾芯', water)).toBe('寫出了「我們在觀察你」的話')
    expect(rejectProposalCopy('偵測到您的濾芯快到期了', water)).toBe('寫出了「我們在觀察你」的話')
  })

  it('⛔ 商品名裡的「系統」不可以被誤擋（C-404：賣淨水系統的店以前一版都擬不出來）', () => {
    expect(rejectProposalCopy('換季了，淨水系統的濾芯記得換，想問哪一款直接回我們。', water)).toBeNull()
  })

  it('⛔ 要人補的空格擋掉（忘了補會原樣送出去），但「【雙 11 限定】」這種正常寫法放行', () => {
    expect(rejectProposalCopy('淨水系統有［優惠內容］，直接回我們', water)).toBe('留了要人補的空格')
    expect(rejectProposalCopy('【雙 11 限定】淨水系統有活動，直接回我們', water)).toBeNull()
  })

  it('prompt 帶得到這群人是誰、搭哪一檔，也寫了「不可以讓客人覺得被觀察」', () => {
    const double11 = TAIWAN_FESTIVALS.find(f => f.id === 'double11-2026')!
    const p = buildProposalCopyPrompt(water, { tagName: '在看淨水器', tagMeaning: '問過淨水器規格', festival: double11 }, '')
    expect(p).toContain('「在看淨水器」')
    expect(p).toContain('問過淨水器規格')
    expect(p).toContain('雙 11 購物節')
    expect(p).toContain('不可以讓客人覺得被觀察')
  })
})
