import { describe, expect, it } from 'vitest'
import {
  PREVIEW_SAMPLE_DISPLAY_NAME,
  broadcastBlankVariableNote,
  findSendVariables,
  previewVariableNote,
  renderBroadcastVariablesDeep,
  renderPreviewVariablesDeep,
  renderPreviewVariablesInText,
  splitPreviewMarks,
} from './preview-variables'

describe('renderPreviewVariablesInText', () => {
  it('displayName 換成範例名字，並回報換了什麼', () => {
    const r = renderPreviewVariablesInText('請問{{displayName}}想問哪些有關訂單的問題呢？')
    expect(r.value).toBe(`請問${PREVIEW_SAMPLE_DISPLAY_NAME}想問哪些有關訂單的問題呢？`)
    expect(r.keys).toEqual(['displayName'])
  })

  it('自訂屬性換成看得懂的佔位，不假裝知道值', () => {
    const r = renderPreviewVariablesInText('{{city}} 的 {{order}} 出貨了')
    expect(r.value).toBe('（city） 的 （order） 出貨了')
    expect(r.keys).toEqual(['city', 'order'])
  })

  it('容得下空白寫法，重複的只回報一次', () => {
    const r = renderPreviewVariablesInText('{{ displayName }} 你好，{{displayName}}')
    expect(r.value).toBe(`${PREVIEW_SAMPLE_DISPLAY_NAME} 你好，${PREVIEW_SAMPLE_DISPLAY_NAME}`)
    expect(r.keys).toEqual(['displayName'])
  })

  it('沒有變數就原字不動，keys 是空的', () => {
    const r = renderPreviewVariablesInText('你好')
    expect(r.value).toBe('你好')
    expect(r.keys).toEqual([])
  })
})

describe('renderPreviewVariablesDeep', () => {
  const messages = [
    { type: 'text', text: '嗨 {{displayName}}' },
    {
      type: 'quickReply',
      text: '請問{{displayName}}要做什麼？',
      quickReplies: [{ action: { label: '查{{order}}' } }],
    },
  ]

  it('巢狀的文字都換到，keys 收齊', () => {
    const r = renderPreviewVariablesDeep<any[]>(messages)
    expect(r.value[0]!.text).toBe(`嗨 ${PREVIEW_SAMPLE_DISPLAY_NAME}`)
    expect(r.value[1]!.quickReplies[0].action.label).toBe('查（order）')
    expect(r.keys).toEqual(['displayName', 'order'])
  })

  /** ⛔ 改到原物件＝把範例值寫進店家正在編的資料裡 */
  it('不就地改原物件', () => {
    renderPreviewVariablesDeep(messages)
    expect(messages[0]!.text).toBe('嗨 {{displayName}}')
    expect((messages[1] as any).quickReplies[0].action.label).toBe('查{{order}}')
  })

  /** ⛔ 網址類欄位換掉會變成連不上的網址 */
  it('網址類欄位不動', () => {
    const r = renderPreviewVariablesDeep<any[]>([
      { type: 'text', text: '{{displayName}}', uri: 'https://x.tw/{{displayName}}', imageUrl: 'https://i/{{a}}.png' },
    ])
    expect(r.value[0]!.text).toBe(PREVIEW_SAMPLE_DISPLAY_NAME)
    expect(r.value[0]!.uri).toBe('https://x.tw/{{displayName}}')
    expect(r.value[0]!.imageUrl).toBe('https://i/{{a}}.png')
  })
})

describe('預覽上標出範例（`D-128`）', () => {
  it('{ mark: true }：範例值前後夾記號，切開來那一段標成 mark；不帶就跟以前一樣', () => {
    const r = renderPreviewVariablesInText('Hi {{displayName}}，{{phone}}', { mark: true })
    expect(splitPreviewMarks(r.value)).toEqual([
      { text: 'Hi ', mark: false },
      { text: PREVIEW_SAMPLE_DISPLAY_NAME, mark: true },
      { text: '，', mark: false },
      { text: '（phone）', mark: true },
    ])
    expect(renderPreviewVariablesInText('Hi {{displayName}}').value).toBe(`Hi ${PREVIEW_SAMPLE_DISPLAY_NAME}`)
  })

  it('整包訊息也帶得到記號；網址照樣不動', () => {
    const r = renderPreviewVariablesDeep<any[]>([{ type: 'text', text: '{{displayName}}', uri: 'https://x/{{displayName}}' }], { mark: true })
    expect(splitPreviewMarks(r.value[0]!.text)).toEqual([{ text: PREVIEW_SAMPLE_DISPLAY_NAME, mark: true }])
    expect(r.value[0]!.uri).toBe('https://x/{{displayName}}')
  })

  it('記號被字數截斷剩一半也不壞（有按鈕時只畫前 160 字）', () => {
    const r = renderPreviewVariablesInText('{{displayName}}', { mark: true }).value
    expect(splitPreviewMarks(r.slice(0, 2))).toEqual([{ text: PREVIEW_SAMPLE_DISPLAY_NAME[0], mark: true }])
    expect(splitPreviewMarks('沒有記號')).toEqual([{ text: '沒有記號', mark: false }])
  })
})

describe('previewVariableNote', () => {
  it('沒換東西就不要多講一句廢話', () => {
    expect(previewVariableNote([])).toBe('')
  })

  /** ⛔ 一定要講「取不到會是空白」——寫成「嗨 {{displayName}}！」的人，那些客人收到的是「嗨 ！」 */
  it('講清楚是範例（`D-128` 範例標黃色，從「標黃色的」講起）、客人看到他自己的 LINE 名稱、取不到會空白', () => {
    const s = previewVariableNote(['displayName'])
    expect(s).toBe('標黃色的是範例：客人看到的是他自己的 LINE 名稱。取不到的話那一格會是空白。')
  })

  it('自訂屬性也講', () => {
    expect(previewVariableNote(['displayName', 'city'])).toContain('（city）')
  })
})

/**
 * `D-118`：2026-10-15 以前送出的推播一律群發，名字變數客人收到的是空白——回頭看那些推播時照實畫。
 * ⛔ 那種預覽不可以畫「王小明」、不可以說「客人看到的是他自己的名字」。
 * （跟送出端逐字一樣的那條釘在 `server/utils/handler.render-text.test.ts`）
 */
describe('舊推播（群發）的預覽：名字是空白', () => {
  it('換成空白並回報換了什麼，不碰網址欄位、不就地改', () => {
    const input = [{ type: 'text', text: '{{displayName}} ，還記得我們', uri: 'https://x.tw/{{displayName}}' }]
    const r = renderBroadcastVariablesDeep(input)
    expect(r.value[0]!.text).toBe(' ，還記得我們')
    expect(r.value[0]!.uri).toBe('https://x.tw/{{displayName}}')
    expect(r.keys).toEqual(['displayName'])
    expect(input[0]!.text).toBe('{{displayName}} ，還記得我們')
  })

  it('說明講的是「當時是空白」，⛔ 不出現範例名字、⛔ 不把 {{displayName}} 原字印給店家看', () => {
    const s = broadcastBlankVariableNote(['displayName'])
    expect(s).toContain('空白')
    expect(s).toContain('當時')
    expect(s).toContain('客人的 LINE 名稱')
    expect(s).not.toContain(PREVIEW_SAMPLE_DISPLAY_NAME)
    expect(s).not.toContain('{{')
    expect(broadcastBlankVariableNote(['displayName', 'city'])).toContain('（city）')
    expect(broadcastBlankVariableNote([])).toBe('')
  })

  it('送出端靠它決定要不要一人一則：每一格都掃（連網址），沒有就是空的', () => {
    expect(findSendVariables([{ altText: '{{displayName}} 你關注的', actions: [{ uri: 'https://x/{{code}}' }] }]))
      .toEqual(['displayName', 'code'])
    expect(findSendVariables([{ type: 'text', text: '今天公休' }])).toEqual([])
    // ⚠️ 中文變數名送出端不換，也不算「用了變數」（不會因為它改成一人一則）
    expect(findSendVariables([{ type: 'text', text: '{{姓名}} 你好' }])).toEqual([])
  })
})
