/**
 * `C-338`①：叫了 AI 卻完全沒記帳的幾處，補上之後記到對的桶、帶著實際模型、次數跟著進同一桶。
 *
 *   - 擬節慶推播文案（broadcast-copy-gen）→ 後台自用（有人按「幫我擬」才跑）
 *   - 擬好友統計行銷提案的文案（同一支，`D-155`）→ 後台自用
 *   - 每日摘要的節慶建議（festival-tailor）→ 後台自用（給老闆看的、跟客人多寡無關）
 *   ⛔ 模型回的東西不能用（JSON 壞掉、驗不過）時，錢一樣付了，一樣要記
 *   （原本還有「貼標報告的總結」：`D-155` 把那段 AI 總結拿掉了，產生報告不再叫 AI）
 *
 * 假的 generateJson／generateText 照 gemini.ts 出口的真實行為演：回 200 就在計量器登記一筆。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportAiCall } from './ai-usage-calls'

vi.mock('./gemini', () => ({
  generateJson: vi.fn(),
  generateText: vi.fn(),
  runWithLlmBudget: (_ws: string, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))

const { generateJson, generateText } = await import('./gemini')
const { recordAiUsage } = await import('./ai-usage')
const { tailorFestivalAngle } = await import('./festival-tailor')
const { generateBroadcastCopy, generateProposalCopy } = await import('./broadcast-copy-gen')
const { emptyStoreProfile, setStoreProfileField } = await import('~~/shared/types/store-profile')
const { TAIWAN_FESTIVALS } = await import('~~/shared/taiwan-festivals')

const FLASH = 'gemini-2.5-flash' as const

function profileOf() {
  let p = emptyStoreProfile()
  for (const [k, v] of Object.entries({ industry: '零售／電商', products: '黑豆水、養生茶包、節慶禮盒', customers: '一般消費者', channel: '網購為主' })) {
    p = setStoreProfileField(p, k as never, v, 'owner', 1)
  }
  return p
}
const midAutumn = TAIWAN_FESTIVALS.find(f => f.name === '中秋節')!

function paidText(text: string, inputTokens: number, outputTokens: number) {
  reportAiCall({ model: FLASH, inputTokens, outputTokens })
  return { text, inputTokens, outputTokens, model: FLASH }
}
function paidJson<T>(data: T, inputTokens: number, outputTokens: number) {
  reportAiCall({ model: FLASH, inputTokens, outputTokens })
  return { data, inputTokens, outputTokens, model: FLASH }
}
function paidButBroken(inputTokens: number, outputTokens: number): never {
  reportAiCall({ model: FLASH, inputTokens, outputTokens })
  throw Object.assign(new Error('Gemini JSON parse failed'), { statusCode: 502, aiUsage: { model: FLASH, inputTokens, outputTokens } })
}

/** 後台自用那桶該長的樣子：test* ＋ 明細在 test 底下 ＋ 次數一起進 */
function testBucket(inputTokens: number, outputTokens: number) {
  return {
    testInputTokens: inputTokens,
    testOutputTokens: outputTokens,
    testInvocations: 1,
    // 這幾件都圈在後台自用那本：每月上限只數這一格（`C-414`）
    assistTokens: inputTokens + outputTokens,
    modelTokens: { test: { flash: { input: inputTokens, output: outputTokens } } },
  }
}

beforeEach(() => {
  vi.mocked(generateJson).mockReset()
  vi.mocked(generateText).mockReset()
  vi.mocked(recordAiUsage).mockClear()
})

describe('擬節慶推播文案', () => {
  it('記進後台自用、次數一起記；⛔ 不碰回答客人那桶', async () => {
    vi.mocked(generateJson).mockImplementationOnce(async () => paidJson({ variants: ['中秋送禮選節慶禮盒，自己喝就選黑豆水。', '想送長輩？養生茶包剛好。', '中秋快到了，禮盒可以先訂起來。'] }, 900, 150))
    const out = await generateBroadcastCopy('ws1', profileOf(), midAutumn)
    expect(out.variants.length).toBeGreaterThan(0)
    expect(recordAiUsage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordAiUsage).mock.calls[0]).toEqual(['ws1', testBucket(900, 150)])
  })

  it('模型回的 JSON 壞掉：丟錯照丟（端點會講「擬不出來」），但那次的錢照記', async () => {
    vi.mocked(generateJson).mockImplementationOnce(async () => paidButBroken(900, 600))
    await expect(generateBroadcastCopy('ws1', profileOf(), midAutumn)).rejects.toThrow('JSON parse failed')
    expect(vi.mocked(recordAiUsage).mock.calls[0]).toEqual(['ws1', testBucket(900, 600)])
  })
})

describe('每日摘要的節慶建議', () => {
  it('記進後台自用、次數一起記', async () => {
    vi.mocked(generateText).mockImplementationOnce(async () => paidText('把節慶禮盒推給買過黑豆水的客人', 400, 30))
    const angle = await tailorFestivalAngle('ws1', profileOf(), midAutumn, 7)
    expect(angle).toBeTruthy()
    expect(vi.mocked(recordAiUsage).mock.calls[0]).toEqual(['ws1', testBucket(400, 30)])
  })

  it('寫出來驗不過、退回通用句：錢一樣付了、一樣記', async () => {
    vi.mocked(generateText).mockImplementationOnce(async () => paidText('NT$599 限時特價'.repeat(10), 400, 90))
    await expect(tailorFestivalAngle('ws1', profileOf(), midAutumn, 7)).resolves.toBeNull()
    expect(vi.mocked(recordAiUsage).mock.calls[0]).toEqual(['ws1', testBucket(400, 90)])
  })

  it('輪廓沒有商品就不叫 AI，也就不記', async () => {
    await expect(tailorFestivalAngle('ws1', emptyStoreProfile(), midAutumn, 7)).resolves.toBeNull()
    expect(generateText).not.toHaveBeenCalled()
    expect(recordAiUsage).not.toHaveBeenCalled()
  })
})

describe('擬好友統計行銷提案的文案（D-155）', () => {
  const input = { tagName: '在看養生茶', tagMeaning: '', festival: null }

  it('記進後台自用、次數一起記；跟節慶那支同一桶', async () => {
    vi.mocked(generateJson).mockImplementationOnce(async () => paidJson({ variants: ['天氣轉涼，養生茶包可以先備著。', '最近想喝點溫的？黑豆水很順口。', '想知道哪一款適合你，直接回我們就好。'] }, 800, 120))
    const out = await generateProposalCopy('ws1', profileOf(), input)
    expect(out.variants.length).toBeGreaterThan(0)
    expect(vi.mocked(recordAiUsage).mock.calls[0]).toEqual(['ws1', testBucket(800, 120)])
  })

  it('三版都沒過檢查：一版都不給，但錢照記', async () => {
    vi.mocked(generateJson).mockImplementationOnce(async () => paidJson({ variants: ['我們注意到你在看養生茶', '系統判斷你想買', 'NT$599 限時'] }, 800, 120))
    const out = await generateProposalCopy('ws1', profileOf(), input)
    expect(out.variants).toEqual([])
    expect(out.dropped).toHaveLength(3)
    expect(vi.mocked(recordAiUsage).mock.calls[0]).toEqual(['ws1', testBucket(800, 120)])
  })
})
