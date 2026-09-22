import { describe, expect, it } from 'vitest'
import {
  BROADCAST_COPY_MAX,
  BROADCAST_COPY_TARGET,
  buildCopyPrompt,
  dedupeVariants,
  rejectBroadcastCopy,
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
})
