import { generateParts } from './gemini'
import { getAiSettings } from './ai-settings'
import { recordAiUsage } from './ai-usage'
import { getStorage } from './firebase'

/**
 * 客人傳圖片進來時，讓 AI 看一眼，產出兩樣東西：
 *
 *   - `description`：給真人客服看的一句話（對話裡圖片下方、轉真人案例的原句）。
 *     這條路徑跟著 AI 總開關走、永遠不對客人說話，理由同 summarizeHandoffContext。
 *   - `question`：把這張圖翻譯成「客人想問的問題」，給答題流程當查詢句用。
 *     **只有工作區把「看圖作答」打開時才會產**（aiSettings.imageAnswer.enabled）——
 *     這個欄位會讓 AI 對客人開口，跟純後台的描述是不同等級的風險，不能共用一個開關。
 *
 * 為什麼要分兩個欄位而不是拿描述去查知識庫：描述是「破掉的白色馬克杯」這種名詞句，
 * 拿去做向量檢索會撈到商品介紹卡，然後 AI 對著一個抱怨破損的客人介紹商品規格。
 * 要撈到「破損怎麼換貨」那張卡，查詢句本身就得是問句。
 */

/** 圖片描述的長度上限（存進 Firestore 前先截）——一句話就夠，長了反而沒人看 */
const MAX_DESCRIPTION_CHARS = 60

/** 推測問題的長度上限：這是要拿去做向量檢索的查詢句，太長反而稀釋掉重點 */
const MAX_QUESTION_CHARS = 40

/**
 * 逾時：webhook 已經先回過客人了，這裡慢不影響客人，但 Lambda 是計時計費且有執行上限，
 * 不能讓一次卡住的 Gemini 呼叫把整個 webhook 拖到被砍。
 */
const DESCRIBE_TIMEOUT_MS = 8000

/** 太小的圖多半是貼圖截角/表情，看了也沒有資訊；省一次呼叫 */
const MIN_DESCRIBABLE_BYTES = 2 * 1024

const DESCRIBE_ONLY_INSTRUCTION = `你是客服助理。客人傳了一張圖片到官方帳號，請用一句繁體中文（台灣用語）描述這張圖，讓客服人員不用點開就知道客人在說什麼。

規則：
- 只描述畫面上真的看得到的東西，看不清楚就說看不清楚，絕對不要猜測或補充沒看到的資訊。
- 重點放在「客人想反映什麼」：商品外觀/瑕疵、螢幕截圖的內容、單據、地點等。
- 30 字以內，直接寫描述本身，不要加「這張圖是」「圖片顯示」之類的開場，也不要加標點以外的符號。
- 個資保護：看到身分證號、信用卡號、電話、地址等，只說有這類資訊（例如「含信用卡號的截圖」），不要把號碼本身寫出來。`

/**
 * 開了看圖作答時用這份：同一次呼叫要出描述與問句。
 *
 * `question` 留空是刻意設計的逃生門——AI 判斷不出客人想問什麼（自拍、風景、看不清楚的模糊照）
 * 時就該留空，讓流程退回「我只看得懂文字」的引導語，而不是硬掰一個問題去查知識庫。
 * 硬掰的代價是 AI 用很篤定的語氣回答一個客人根本沒問的問題。
 */
const DESCRIBE_AND_ASK_INSTRUCTION = `你是客服助理。客人傳了一張圖片到官方帳號，請輸出 JSON：{"description":"...","question":"..."}

description（給客服看的描述）：
- 用繁體中文（台灣用語）一句話，30 字以內。
- 只描述畫面上真的看得到的東西，看不清楚就說看不清楚，絕對不要猜測。
- 不要加「這張圖是」「圖片顯示」之類的開場。
- 個資保護：看到身分證號、信用卡號、電話、地址等，只說有這類資訊（例如「含信用卡號的截圖」），不要把號碼本身寫出來。

question（客人傳這張圖最可能想問的一句話）：
- 用客人的口吻寫成一個問句，20 字以內，例如「杯子破掉了可以換貨嗎」「這筆付款失敗要怎麼處理」。
- **判斷不出來就填空字串**。以下情況一律填空字串：純自拍或人物照、風景照、寵物照、迷因或表情圖、
  模糊到看不出內容、單純打招呼性質的圖。寧可留空讓真人接手，也不要猜一個客人沒問的問題。
- 不要把商品型號或金額寫進問句，除非圖上清楚可見。`

/** Gemini 支援的圖片 MIME；LINE 的圖片訊息實務上都是 jpeg，其餘保險起見一併放行 */
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

function clampOneLine(raw: unknown, max: number): string {
  const oneLine = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** 讀圖的產物。`question` 只有工作區開了看圖作答、而且 AI 判斷得出來時才有值 */
export interface InboundImageReading {
  /** 給客服看的一句描述 */
  description: string
  /** 客人可能想問的問句（拿去查知識庫）；空字串＝判斷不出來，該退回引導語 */
  question: string
}

const EMPTY_READING: InboundImageReading = { description: '', question: '' }

/**
 * 讀圖。任何失敗都回空值——這是錦上添花的功能，
 * 不能因為 Gemini 掛了就讓「收訊存檔」這條主線跟著失敗。
 *
 * 圖從 Storage 存檔讀回（`storagePath` 由 archiveConversationMedia 給），
 * 不重新跟 LINE 要：存檔一定已經寫好，而 LINE 的 content API 有流量限制又會過期。
 */
export async function readInboundImage(opts: {
  workspaceId: string
  storagePath: string
  contentType: string
}): Promise<InboundImageReading> {
  const { workspaceId, storagePath, contentType } = opts
  if (!workspaceId || !storagePath) return EMPTY_READING

  const mimeType = String(contentType || '').split(';')[0]!.trim().toLowerCase()
  if (!SUPPORTED_MIME.has(mimeType)) return EMPTY_READING

  // AI 沒啟用的工作區不該因為客人傳圖就產生 Gemini 費用。
  // draft 模式照做：草稿模式的用途正是「先讓 AI 幫客服、還不讓它對外說話」。
  // 這道檢查放在下載之前：沒要用的圖連讀都不用讀。
  const settings = await getAiSettings(workspaceId).catch(() => null)
  if (!settings?.enabled) return EMPTY_READING

  // 看圖作答關著時只要描述，省一半輸出、也不會產生「客人想問什麼」這種會被誤用的欄位
  const wantQuestion = settings.imageAnswer?.enabled === true

  const buffer = await getStorage().bucket().file(storagePath).download()
    .then(([buf]) => buf)
    .catch((e) => {
      console.warn('[media-describe] download failed:', storagePath, e instanceof Error ? e.message : e)
      return null
    })
  if (!buffer?.length || buffer.length < MIN_DESCRIBABLE_BYTES) return EMPTY_READING

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DESCRIBE_TIMEOUT_MS)
    })
    const res = await Promise.race([
      generateParts(
        [
          { inlineData: { mimeType, data: buffer.toString('base64') } },
          { text: wantQuestion ? '請看這張圖並輸出 JSON。' : '請用一句話描述這張圖。' },
        ],
        {
          systemInstruction: wantQuestion ? DESCRIBE_AND_ASK_INSTRUCTION : DESCRIBE_ONLY_INSTRUCTION,
          temperature: 0.2,
          maxOutputTokens: wantQuestion ? 200 : 120,
          // 一句描述不需要思考預算，開著會把輸出配額吃掉導致回傳空字串
          thinkingBudget: 0,
          ...(wantQuestion ? { responseMimeType: 'application/json' as const } : {}),
          // 描述用不到旗艦模型，flash-lite 便宜約三分之一（見 summarizeHandoffContext 同樣取捨）
          model: 'gemini-2.5-flash-lite',
        },
      ),
      timeout,
    ])
    if (!res) {
      console.warn('[media-describe] timed out')
      return EMPTY_READING
    }

    // 成本要看得到：圖片會換算成 token（一張手機照片約 800–1,600），
    // 不記帳的話用量頁的成本會少一塊、對不上 Google 帳單。
    // 刻意不記 invocations——那個欄位是「AI 介入客人對話」的次數，
    // 用量頁靠 invocations = answered + handoffs + disambiguations 這個恆等式畫圖，
    // 這裡加上去會讓三段長條永遠湊不滿。
    if (res.inputTokens || res.outputTokens) {
      recordAiUsage(workspaceId, { inputTokens: res.inputTokens, outputTokens: res.outputTokens })
        .catch(e => console.error('[media-describe] recordAiUsage error:', e))
    }

    if (!wantQuestion) return { description: clampOneLine(res.text, MAX_DESCRIPTION_CHARS), question: '' }

    // JSON 壞掉不能讓整張圖白讀：至少把原文當描述留下來給客服，只是不作答。
    let parsed: { description?: unknown; question?: unknown } | null = null
    try {
      parsed = JSON.parse(res.text)
    }
    catch {
      console.warn('[media-describe] JSON parse failed, falling back to description only')
      return { description: clampOneLine(res.text, MAX_DESCRIPTION_CHARS), question: '' }
    }
    return {
      description: clampOneLine(parsed?.description, MAX_DESCRIPTION_CHARS),
      question: clampOneLine(parsed?.question, MAX_QUESTION_CHARS),
    }
  }
  catch (err) {
    console.warn('[media-describe] failed:', err instanceof Error ? err.message : err)
    return EMPTY_READING
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}
