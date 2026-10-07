import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({}))

// parseFirstJsonValue 用真的：這支測試要驗的正是「模型多吐殘句時還撿不撿得回來」，
// 把它一起 mock 掉就等於把要驗的東西拿掉了
vi.mock('./gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gemini')>()),
  generateParts: vi.fn(),
}))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./firebase', () => ({ getStorage: vi.fn() }))

import { readInboundImage } from './media-describe'
import { generateParts } from './gemini'
import { getAiSettings } from './ai-settings'
import { recordAiUsage } from './ai-usage'
import { getStorage } from './firebase'

const WS = 'ws1'
const PATH = 'conversation-media/ws1/msg-1'

/** 假 Storage：download() 回一顆夠大的假圖 buffer（小於門檻的會被當雜訊跳過） */
function mockStorage(bytes = 50 * 1024) {
  const download = vi.fn(async () => [Buffer.alloc(bytes, 1)])
  vi.mocked(getStorage).mockReturnValue({
    bucket: () => ({ file: () => ({ download }) }),
  } as any)
  return download
}

function mockGemini(text: string, tokens = { inputTokens: 900, outputTokens: 20 }) {
  vi.mocked(generateParts).mockResolvedValue({ text, ...tokens } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAiSettings).mockResolvedValue({ enabled: true, replyMode: 'auto' } as any)
})

describe('客人傳圖：AI 讀一句描述給客服看', () => {
  it('讀得出來就回一句話，並把圖片的 token 記進用量（不然成本會對不上帳單）', async () => {
    mockStorage()
    mockGemini('破掉的白色馬克杯')

    const { description: desc } = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(desc).toBe('破掉的白色馬克杯')
    expect(vi.mocked(recordAiUsage)).toHaveBeenCalledWith(WS, { inputTokens: 900, outputTokens: 20 })
  })

  it('不能記 invocations：用量頁靠「介入次數 = 答題 + 轉真人 + 反問」畫三段長條', async () => {
    mockStorage()
    mockGemini('付款失敗的螢幕截圖')

    await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    const delta = vi.mocked(recordAiUsage).mock.calls[0]![1]
    expect(delta).not.toHaveProperty('invocations')
    expect(delta).not.toHaveProperty('answered')
  })

  it('AI 沒啟用的工作區：連圖都不下載，更不會產生 Gemini 費用', async () => {
    const download = mockStorage()
    vi.mocked(getAiSettings).mockResolvedValue({ enabled: false } as any)

    const { description: desc } = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(desc).toBe('')
    expect(download).not.toHaveBeenCalled()
    expect(vi.mocked(generateParts)).not.toHaveBeenCalled()
  })

  it('draft 模式照樣讀：草稿模式的用途就是先讓 AI 幫客服、還不對客人說話', async () => {
    mockStorage()
    vi.mocked(getAiSettings).mockResolvedValue({ enabled: true, replyMode: 'draft' } as any)
    mockGemini('外包裝壓扁的紙箱')

    const { description: desc } = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(desc).toBe('外包裝壓扁的紙箱')
  })

  it('Gemini 掛掉只是少一句說明，不能往外炸（圖片本身還是要看得到）', async () => {
    mockStorage()
    vi.mocked(generateParts).mockRejectedValue(new Error('502 upstream'))

    await expect(
      readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' }),
    ).resolves.toEqual({ description: '', questions: [], state: 'unavailable' })
  })

  it('存檔讀不到（過期/剛好被清掉）也只是安靜跳過', async () => {
    const download = vi.fn(async () => { throw new Error('404 no such object') })
    vi.mocked(getStorage).mockReturnValue({ bucket: () => ({ file: () => ({ download }) }) } as any)

    await expect(
      readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' }),
    ).resolves.toEqual({ description: '', questions: [], state: 'unavailable' })
    expect(vi.mocked(generateParts)).not.toHaveBeenCalled()
  })

  it('太小的圖（多半是截角/表情）不值得花一次呼叫', async () => {
    mockStorage(500)
    mockGemini('不該被呼叫')

    const { description: desc } = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(desc).toBe('')
    expect(vi.mocked(generateParts)).not.toHaveBeenCalled()
  })

  it('不是圖片的 MIME 直接跳過（Phase 1 只讀圖，影片/語音不在範圍）', async () => {
    mockStorage()

    const { description: desc } = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'video/mp4' })

    expect(desc).toBe('')
    expect(vi.mocked(generateParts)).not.toHaveBeenCalled()
  })

  it('模型話太多時截斷：這句話是要塞進對話泡泡下方的，不能變成一段文章', async () => {
    mockStorage()
    mockGemini('這是一張'.repeat(40))

    const { description: desc } = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(desc.length).toBeLessThanOrEqual(61) // 60 字 + 省略號
    expect(desc.endsWith('…')).toBe(true)
  })

  it('換行會被壓成一行（多行說明在氣泡下方會擠壞版面）', async () => {
    mockStorage()
    mockGemini('  第一行\n\n  第二行  ')

    const { description: desc } = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(desc).toBe('第一行 第二行')
  })

  it('圖片是以 inlineData 送出、且用便宜的 flash-lite（描述不需要旗艦模型）', async () => {
    mockStorage()
    mockGemini('收據照片')

    await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg; charset=binary' })

    const [parts, opts] = vi.mocked(generateParts).mock.calls[0]!
    expect(parts[0]).toHaveProperty('inlineData')
    expect((parts[0] as any).inlineData.mimeType).toBe('image/jpeg')
    expect(opts?.model).toBe('gemini-2.5-flash-lite')
  })

  it('沒開「客人傳的照片」時不要問句：那個欄位一產出就會出現在客人畫面上', async () => {
    mockStorage()
    mockGemini('破掉的白色馬克杯')

    const r = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(r.questions).toEqual([])
    // 沒開作答時不該要求 JSON（多出來的格式限制只會增加失敗機會）
    expect(vi.mocked(generateParts).mock.calls[0]![1]?.responseMimeType).toBeUndefined()
  })
})

describe('客人傳的照片（工作區開了 imageAnswer 才會走）', () => {
  beforeEach(() => {
    vi.mocked(getAiSettings).mockResolvedValue({
      enabled: true, replyMode: 'auto', imageAnswer: { enabled: true },
    } as any)
  })

  it('讀得出客人可能想問什麼 → 描述給客服、最多兩句問句給客人當按鈕', async () => {
    mockStorage()
    mockGemini(JSON.stringify({ description: '破掉的白色馬克杯', questions: ['破掉可以換貨嗎？', '多久會寄新的？'] }))

    const r = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(r).toEqual({ description: '破掉的白色馬克杯', questions: ['破掉可以換貨嗎？', '多久會寄新的？'], state: 'ok' })
  })

  it('看不出想問什麼（自拍/風景）→ 空陣列，問句照發但不硬掰選項', async () => {
    mockStorage()
    mockGemini(JSON.stringify({ description: '在海邊的自拍照', questions: [] }))

    const r = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(r.description).toBe('在海邊的自拍照')
    expect(r.questions).toEqual([])
    // 「AI 說看不出來」跟「AI 交回來的格式壞掉」都是沒有問句，但一個是正常出口、
    // 一個是要修的 bug——分不出來就只能靠人翻對話發現（正式站上就是這樣壞了三週）
    expect(r.state).toBe('noQuestion')
  })

  // 2026-09-10 正式站實況：同一張圖用相同參數重跑五次，兩次的輸出是「完整 JSON + 後面多一截殘句」
  // （`{"description":"…","question":"這款電子鍋有什麼優惠？"}\n現省多少錢？"}`）。
  // 舊做法整份 JSON.parse 失敗 → 問句連坐丟掉 → 客人收到「我目前只能閱讀文字」，
  // 但那兩格其實都填對了。指定 responseMimeType 也擋不住，所以要在讀的這一端容忍。
  it('模型在合法 JSON 後面多吐殘句：取第一份完整的就好，不能把填對的兩格一起丟掉', async () => {
    mockStorage()
    mockGemini(`${JSON.stringify({ description: '飛利浦鍋具特價 NT$6,990', questions: ['這款有什麼優惠？'] })}\n現省多少錢？"}`)

    const r = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(r.description).toBe('飛利浦鍋具特價 NT$6,990')
    expect(r.questions).toEqual(['這款有什麼優惠？'])
    expect(r.state).toBe('ok')
  })

  it('JSON 壞掉時至少保住描述給客服，但絕不把壞掉的內容放到客人畫面上', async () => {
    mockStorage()
    mockGemini('這不是 JSON，是模型隨口講的一句話')

    const r = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(r.description).toBe('這不是 JSON，是模型隨口講的一句話')
    expect(r.questions).toEqual([])
    expect(r.state).toBe('malformed')
  })

  it('超過按鈕字數（20 字）的整句丟掉、不截成半句：LINE 會把超長的整則回覆退件', async () => {
    mockStorage()
    mockGemini(JSON.stringify({ description: '收據', questions: ['請問一下'.repeat(6), '收據可以補開嗎？'] }))

    const r = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(r.questions).toEqual(['收據可以補開嗎？'])
  })

  it('最多兩句、重複的只留一句（後面還要留一顆「找真人」）', async () => {
    mockStorage()
    mockGemini(JSON.stringify({ description: '收據', questions: ['可以補開嗎？', '可以補開嗎？', '要多久？', '寄到哪？'] }))

    const r = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(r.questions).toEqual(['可以補開嗎？', '要多久？'])
  })

  it('模型照舊格式回單一 question 也收', async () => {
    mockStorage()
    mockGemini(JSON.stringify({ description: '破掉的杯子', question: '可以換貨嗎？' }))

    const r = await readInboundImage({ workspaceId: WS, storagePath: PATH, contentType: 'image/jpeg' })

    expect(r.questions).toEqual(['可以換貨嗎？'])
    expect(r.state).toBe('ok')
  })
})
