/**
 * AI 生成腳本草稿:「答不出來就卡死」的把關。
 * 起因是線上「查詢訂單」腳本問訂單編號用嚴格格式又沒跳過出口,沒編號的客人被無限重問,
 * 而備援的「如果沒有訂單編號…」快速回覆被擺在下一步(要先答得出編號才看得到)=永遠走不到。
 * 這裡驗:生成端會回饋給模型重生,模型再不改就確定性補上跳過出口,不讓卡死的流程出得了門。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('createError', (o: any) => Object.assign(new Error(o?.statusMessage ?? 'error'), o))

const { generateJson } = vi.hoisted(() => ({ generateJson: vi.fn() }))
vi.mock('./gemini', () => ({ generateJson }))

import { generateScriptDraft } from './ai-script-generate'
import type { ScriptCollectNode } from '~~/shared/types/ai-script'

/** 卡死版:問訂單編號(嚴格格式)沒有跳過出口,備援問句擺在下一步 */
const STUCK = {
  name: '查詢訂單',
  rootNodeId: 't',
  nodes: [
    { id: 't', type: 'trigger', matchMode: 'semantic', keywords: ['訂單'], examples: ['我想查訂單'], priority: 50, next: 'c1' },
    { id: 'c1', type: 'collect', question: '請問您的訂單編號是?', fieldName: 'order_id', format: 'alphanumericSymbol', reaskText: '再確認一次', next: 'q1' },
    { id: 'q1', type: 'quickReply', question: '如果沒有訂單編號,方便給 Email 嗎?', options: [{ label: '提供 Email', next: 'c2' }] },
    { id: 'c2', type: 'collect', question: '請給 Email', fieldName: 'email', format: 'email', reaskText: '再確認一次', next: 'r1' },
    { id: 'r1', type: 'reply', text: '已收到,將由專人為您處理', thenHandoff: true },
  ],
}

/** 好版:跳過出口掛在同一題上 */
const FIXED = {
  ...STUCK,
  nodes: STUCK.nodes.map(n => n.id === 'c1' ? { ...n, next: 'r1', skipLabel: '我沒有訂單編號', skipNext: 'q1' } : n),
}

function reply(data: unknown) {
  return { data, inputTokens: 100, outputTokens: 200 }
}
function collectNode(draft: { nodes: any[] }, id: string): ScriptCollectNode {
  return draft.nodes.find(n => n.id === id) as ScriptCollectNode
}

beforeEach(() => generateJson.mockReset())

describe('generateScriptDraft：不讓「答不出來就卡死」的草稿出門', () => {
  it('第一次就沒有卡死步驟 → 直接回,不多花一次 LLM', async () => {
    generateJson.mockResolvedValueOnce(reply(FIXED))
    const draft = await generateScriptDraft('客人查訂單時先問訂單編號')
    expect(generateJson).toHaveBeenCalledTimes(1)
    expect(collectNode(draft, 'c1').skipLabel).toBe('我沒有訂單編號')
    expect(draft.inputTokens).toBe(100)
  })

  it('第一次卡死 → 把問題回饋給模型重生,第二次改好就用第二次(token 兩次都記帳)', async () => {
    generateJson.mockResolvedValueOnce(reply(STUCK)).mockResolvedValueOnce(reply(FIXED))
    const draft = await generateScriptDraft('客人查訂單時先問訂單編號')

    expect(generateJson).toHaveBeenCalledTimes(2)
    const retryPrompt = generateJson.mock.calls[1]![0] as string
    expect(retryPrompt).toContain('卡死')
    expect(retryPrompt).toContain('c1')

    const c1 = collectNode(draft, 'c1')
    expect(c1.skipLabel).toBe('我沒有訂單編號')
    expect(c1.skipNext).toBe('q1')
    expect(draft.inputTokens).toBe(200)
    expect(draft.outputTokens).toBe(400)
  })

  it('模型兩次都不補 → 確定性補一顆跳過按鈕（跳過這題往下走），不回傳卡死流程', async () => {
    generateJson.mockResolvedValue(reply(STUCK))
    const draft = await generateScriptDraft('客人查訂單時先問訂單編號')

    const c1 = collectNode(draft, 'c1')
    expect(c1.skipLabel).toBe('我沒有這項資料')
    expect(c1.skipNext).toBe('q1') // = 該題原本的 next
    // 其他題沒被亂動
    expect(collectNode(draft, 'c2').skipLabel).toBeUndefined()
  })

  it('第二次連驗證都沒過 → 退回第一次的草稿並補跳過出口,不整個失敗', async () => {
    generateJson.mockResolvedValueOnce(reply(STUCK)).mockResolvedValueOnce(reply({ name: '壞掉', rootNodeId: 'nope', nodes: [] }))
    const draft = await generateScriptDraft('客人查訂單時先問訂單編號')
    expect(collectNode(draft, 'c1').skipLabel).toBe('我沒有這項資料')
  })

  it('兩次都生出驗證不過的東西 → 422', async () => {
    generateJson.mockResolvedValue(reply({ name: '壞掉', rootNodeId: 'nope', nodes: [] }))
    await expect(generateScriptDraft('亂七八糟')).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('generateScriptDraft：拒答出口（描述不是流程/腳本做不到）', () => {
  it('模型回 error → 422 帶模型講的原因,不再多花第二次 LLM', async () => {
    generateJson.mockResolvedValueOnce(reply({ error: '腳本無法依時間自動判斷,請改用 AI 設定裡的勿擾時段' }))
    await expect(generateScriptDraft('下班時間自動回覆')).rejects.toMatchObject({
      statusCode: 422,
      statusMessage: '腳本無法依時間自動判斷,請改用 AI 設定裡的勿擾時段',
    })
    expect(generateJson).toHaveBeenCalledTimes(1)
  })

  it('第一次卡死、第二次才拒答 → 退回第一次的草稿補跳過出口(有堪用的就不空手而回)', async () => {
    generateJson.mockResolvedValueOnce(reply(STUCK)).mockResolvedValueOnce(reply({ error: '做不到' }))
    const draft = await generateScriptDraft('客人查訂單時先問訂單編號')
    expect(collectNode(draft, 'c1').skipLabel).toBe('我沒有這項資料')
  })

  it('第一次驗證沒過、第二次拒答 → 422 帶拒答原因(比「沒生好」講得清楚)', async () => {
    generateJson.mockResolvedValueOnce(reply({ name: '壞', rootNodeId: 'nope', nodes: [] })).mockResolvedValueOnce(reply({ error: '這不是客服流程' }))
    await expect(generateScriptDraft('嗯')).rejects.toMatchObject({ statusCode: 422, statusMessage: '這不是客服流程' })
  })
})

describe('generateScriptDraft：觸發關鍵字後檢(泛用詞/單字/敏感詞剔除)', () => {
  function withKeywords(keywords: string[]) {
    return { ...FIXED, nodes: FIXED.nodes.map(n => n.id === 't' ? { ...n, keywords } : n) }
  }
  function triggerOf(draft: { nodes: any[] }) {
    return draft.nodes.find(n => n.type === 'trigger')
  }

  it('高頻通用詞與單一個字被剔除,具體詞保留(語意路由不靠 keywords,剔光也能觸發)', async () => {
    generateJson.mockResolvedValueOnce(reply(withKeywords(['你好', '問題', '抽', '退貨', '訂單查詢'])))
    const draft = await generateScriptDraft('客人查訂單')
    expect(triggerOf(draft).keywords).toEqual(['退貨', '訂單查詢'])
  })

  it('含租戶敏感情境詞的關鍵字是死關鍵字(敏感層排在腳本前面)→ 剔除', async () => {
    generateJson.mockResolvedValueOnce(reply(withKeywords(['退款', '退款申請', '退錢'])))
    const draft = await generateScriptDraft('客人要退款', { sensitiveTopics: ['退款', '申訴'] })
    expect(triggerOf(draft).keywords).toEqual(['退錢'])
  })

  it('沒帶 sensitiveTopics → 只做泛用詞/單字剔除,不誤傷', async () => {
    generateJson.mockResolvedValueOnce(reply(withKeywords(['退款', '退貨'])))
    const draft = await generateScriptDraft('客人要退貨')
    expect(triggerOf(draft).keywords).toEqual(['退款', '退貨'])
  })
})
