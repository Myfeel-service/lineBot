import { describe, expect, it } from 'vitest'
import { buildDiscoveryPrompt } from './tag-discovery'

describe('AI 發現新標籤：prompt', () => {
  const digests = [
    { userDocId: 'ws_u1', text: '請問除濕機保固多久 / 6L 跟 12L 差在哪' },
    { userDocId: 'ws_u2', text: '想買來送爸爸 可以包裝嗎' },
  ]

  it('對話摘要逐行帶場次編號（模型靠編號指回名單）', () => {
    const p = buildDiscoveryPrompt(digests, [])
    expect(p).toContain('S0: 請問除濕機保固多久')
    expect(p).toContain('S1: 想買來送爸爸')
  })

  it('排除名單要整串進 prompt——既有標籤與否決過的主題不准再提', () => {
    const p = buildDiscoveryPrompt(digests, ['在看除濕機', '想送禮'])
    expect(p).toContain('在看除濕機、想送禮')
    expect(p).toContain('不要再提')
  })

  it('沒有排除名單時明講（無），不留空白讓模型自由發揮', () => {
    expect(buildDiscoveryPrompt(digests, [])).toContain('（無）')
  })

  it('粒度紅線寫死在 prompt：品類不是型號', () => {
    const p = buildDiscoveryPrompt(digests, [])
    expect(p).toContain('品類')
    expect(p).toContain('不要提「在看某品牌 6L 除濕機」')
  })
})
