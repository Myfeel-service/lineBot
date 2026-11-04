import { describe, expect, it } from 'vitest'
import { TAG_IDEA_MAX, TAG_NEEDS_RECORDS_REASON, needsRecords, tagIdeasNote, vetTagIdeas } from './tag-ideas'

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

  it('模型自己放進 skipped 的也照樣講給他聽', () => {
    const v = vetTagIdeas({ tags: [], skipped: [{ name: '消費滿千', reason: '要看帳才知道' }] }, [])
    expect(v.skipped).toEqual([{ name: '消費滿千', reason: '要看帳才知道' }])
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
