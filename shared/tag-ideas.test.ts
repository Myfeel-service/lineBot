import { describe, expect, it } from 'vitest'
import { TAG_IDEA_MAX, TAG_NEEDS_RECORDS_REASON, needsRecords, relatesToAsk, tagIdeasNote, vetTagIdeas } from './tag-ideas'

const idea = (name: string, criteria = '客人提到要內用、在店裡吃。外帶的不算。', why = '內用有活動時找他們。') => ({ name, criteria, why })

describe('vetTagIdeas（D-171「還想怎麼分？問 AI」）', () => {
  it('示意頁那一題：內用、外帶、外送各一顆，帶著判斷條件', () => {
    const v = vetTagIdeas({ tags: [idea('內用客'), idea('外帶客'), idea('外送客')] }, ['問過訂位'])
    expect(v.ideas.map(i => i.name)).toEqual(['內用客', '外帶客', '外送客'])
    expect(v.ideas.every(i => i.criteria.length > 0)).toBe(true)
    expect(v.skipped).toEqual([])
  })

  // 🔴 沒有貼法的標籤永遠 0 人：模型沒照規則放進 skipped，這裡還要擋一次，⛔ 而且要講給他聽
  it('⛔ 要訂單或來店紀錄的名字擋下來，並且說得出為什麼', () => {
    const v = vetTagIdeas({ tags: [idea('VIP'), idea('回購客'), idea('第一次來'), idea('常客'), idea('內用客')] }, [])
    expect(v.ideas.map(i => i.name)).toEqual(['內用客'])
    expect(v.skipped.map(s => s.name)).toEqual(['VIP', '回購客', '第一次來', '常客'])
    expect(v.skipped.every(s => s.reason === TAG_NEEDS_RECORDS_REASON)).toBe(true)
  })

  it('「問過會員方案」「想首購優惠」是對話講得出來的，不擋', () => {
    expect(needsRecords('問過會員方案')).toBe(false)
    expect(needsRecords('想首購優惠')).toBe(false)
    expect(needsRecords('會員')).toBe(true)
  })

  it('模型自己放進 skipped 的也照樣講給他聽；要紀錄的那種一律講同一句短的（實測模型寫得又長又不一樣）', () => {
    const v = vetTagIdeas({ tags: [], skipped: [
      { name: '消費滿千', reason: '要看帳才知道' },
      { name: 'VIP', reason: 'AI 無法從 LINE 對話判斷客人是否為 VIP，這需要依賴消費紀錄或會員等級資料。' },
      { name: '住哪一區', reason: '對話裡不一定會講地址。' },
    ] }, [])
    expect(v.skipped).toEqual([
      { name: '消費滿千', reason: TAG_NEEDS_RECORDS_REASON },
      { name: 'VIP', reason: TAG_NEEDS_RECORDS_REASON },
      // 不是要紀錄的那種：照模型的話、尾巴句號拿掉（外面會再補一個）
      { name: '住哪一區', reason: '對話裡不一定會講地址' },
    ])
  })

  /**
   * 2026-11-05 真模型實測（gemini-2.5-flash，6 題）抓到的：做不到的時候模型拿別的標籤湊數。
   * 下面的 raw 就是那次真的回來的東西（節錄）。
   */
  it('⛔ 跟他問的那句沒關係的丟掉（問 VIP 卻塞咖啡、鬆餅）並記原因', () => {
    const raw = {
      tags: [
        { name: '問過內用', criteria: '提到內用', why: '' },
        { name: '問過咖啡', criteria: '提到咖啡', why: '' },
        { name: '問過鬆餅', criteria: '提到鬆餅', why: '' },
        { name: '問過夏天活動', criteria: '提到夏天', why: '' },
      ],
      skipped: [{ name: 'VIP', reason: '…' }, { name: '常客', reason: '…' }],
    }
    const v = vetTagIdeas(raw, [], '我想分 VIP 跟常客')
    expect(v.ideas).toEqual([])
    expect(v.dropped.map(d => d.text)).toEqual(['問過內用', '問過咖啡', '問過鬆餅', '問過夏天活動'])
    expect(v.dropped.every(d => d.reason.includes('沒關係'))).toBe(true)
    expect(tagIdeasNote(v)).toBe(`「VIP」「常客」沒列：${TAG_NEEDS_RECORDS_REASON}。`)
  })
  it('問「台灣和海外」：留台灣／海外那兩顆，丟掉順手塞的週年慶、母親節', () => {
    const raw = { tags: [
      { name: '海外寄送需求', criteria: '要寄到國外', why: '' },
      { name: '台灣寄送需求', criteria: '寄台灣', why: '' },
      { name: '關注週年慶', criteria: '提到週年慶', why: '' },
      { name: '關注母親節', criteria: '提到母親節', why: '' },
    ] }
    expect(vetTagIdeas(raw, [], '分台灣和海外的客人').ideas.map(i => i.name)).toEqual(['海外寄送需求', '台灣寄送需求'])
  })
  it('名字對不上、但模型標的 from 是他講的字也算（「在意價格」↔ 他說「在意價錢」）', () => {
    const raw = { tags: [{ name: '價格敏感', from: '在意價錢', criteria: '嫌貴', why: '' }] }
    expect(vetTagIdeas(raw, [], '想分怕痛的、在意價錢的').ideas.map(i => i.name)).toEqual(['價格敏感'])
  })
  it('實測那幾題正常的照樣過（內用外帶外送、國小國中高中、怕痛）', () => {
    const t = (name: string) => ({ name, criteria: 'x', why: '' })
    expect(vetTagIdeas({ tags: ['想內用', '想外帶', '想外送'].map(t) }, [], '我想分內用、外帶、外送的客人').ideas).toHaveLength(3)
    expect(vetTagIdeas({ tags: ['國小家長', '國中家長', '高中家長'].map(t) }, [], '我想分國小、國中、高中的家長').ideas).toHaveLength(3)
    expect(vetTagIdeas({ tags: ['怕痛', '在意價格'].map(t) }, [], '想分怕痛的、在意價錢的').ideas.map(i => i.name)).toEqual(['怕痛', '在意價格'])
  })
  it('「客人／問過」這種每句都有的字不算關係（⛔ 不能靠它混過去）', () => {
    expect(relatesToAsk('問過客人鬆餅', '', '我想分 VIP 的客人')).toBe(false)
  })

  it('那一排已經有的不再加（換個寫法、大小寫、括號也認得）', () => {
    const v = vetTagIdeas({ tags: [idea('「問過訂位」'), idea('內用客')] }, ['問過訂位'])
    expect(v.ideas.map(i => i.name)).toEqual(['內用客'])
    expect(v.already).toEqual(['問過訂位'])
  })

  it('⛔ 沒有判斷條件的丟掉（AI 之後貼不上）、名字太長的丟掉；丟掉的記得原因', () => {
    const v = vetTagIdeas({ tags: [idea('內用客', ''), idea('非常非常非常長的標籤名字')] }, [])
    expect(v.ideas).toEqual([])
    expect(v.dropped.map(d => d.reason)).toEqual(['沒有判斷條件', '名字太長（12 字）'])
  })

  it(`最多 ${TAG_IDEA_MAX} 顆；同一批裡重複的只留一顆`, () => {
    const v = vetTagIdeas({ tags: ['甲', '乙', '甲', '丙', '丁', '戊'].map(n => idea(`${n}客`)) }, [])
    expect(v.ideas.map(i => i.name)).toEqual(['甲客', '乙客', '丙客', '丁客'])
  })

  it('模型回壞格式也不會炸：當成沒回', () => {
    expect(vetTagIdeas(null, []).ideas).toEqual([])
    expect(vetTagIdeas({ tags: 'x' }, []).dropped.map(d => d.reason)).toContain('模型沒有回任何一顆')
  })
})

describe('tagIdeasNote（⛔ 不可以按了沒反應）', () => {
  it('有新的可以加、沒擋掉什麼：不用多講', () => {
    expect(tagIdeasNote({ ideas: [idea('內用客')], skipped: [], already: [] })).toBe('')
  })
  it('擋掉的點名講原因', () => {
    expect(tagIdeasNote({ ideas: [], skipped: [{ name: 'VIP', reason: TAG_NEEDS_RECORDS_REASON }], already: [] }))
      .toBe(`「VIP」沒列：${TAG_NEEDS_RECORDS_REASON}。`)
  })
  it('全部上面已經有了：講出來', () => {
    expect(tagIdeasNote({ ideas: [], skipped: [], already: ['問過訂位'] })).toBe('「問過訂位」上面已經有了。')
  })
  it('什麼都沒有：叫他換個說法', () => {
    expect(tagIdeasNote({ ideas: [], skipped: [], already: [] })).toContain('換個說法')
  })
})
