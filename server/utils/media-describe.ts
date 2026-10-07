import { generateParts, parseFirstJsonValue } from './gemini'
import { getAiSettings } from './ai-settings'
import { recordAiUsage } from './ai-usage'
import { getStorage } from './firebase'

/**
 * 客人傳圖片進來時，讓 AI 看一眼，產出兩樣東西：
 *
 *   - `description`：給真人客服看的一句話（對話裡圖片下方、轉真人案例的原句）。
 *     這條路徑跟著 AI 總開關走、永遠不對客人說話，理由同 summarizeHandoffContext。
 *   - `questions`：猜「客人傳這張圖可能想問什麼」，最多兩句，做成快速回覆按鈕讓客人自己點。
 *     **只有工作區把「客人傳的照片」開關打開時才會產**（aiSettings.imageAnswer.enabled）——
 *     這個欄位會出現在客人的畫面上，跟純後台的描述是不同等級的風險，不能共用一個開關。
 *
 * ⛔ 問句只能當「給客人點的選項」，不能直接拿去問 AI（2026-10-07 `C-207`）：舊做法拿猜的問句
 * 直接答題，正式站 140 次裡猜中不到三成，而九成客人自己會打字講要問什麼——AI 等於在客人打字的
 * 同時搶答一個他沒問的問題，答案還算在他頭上。按鈕讓客人自己選，點了才算他問的。
 */

/** 圖片描述的長度上限（存進 Firestore 前先截）——一句話就夠，長了反而沒人看 */
const MAX_DESCRIPTION_CHARS = 60

/**
 * 問句的長度上限＝LINE 快速回覆按鈕的字數上限（label 最多 20 字，超過整則回覆會被 LINE 退件）。
 * 超過的**整句丟掉**、不截斷：截成半句的問題放在按鈕上，比少一顆按鈕更糟。
 */
const MAX_QUESTION_CHARS = 20

/** 最多幾顆猜的按鈕（後面還要留一顆「找真人」） */
const MAX_QUESTIONS = 2

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
 * 開了「客人傳的照片」開關時用這份：同一次呼叫要出描述與問句。
 *
 * `questions` 給空陣列是刻意設計的出口——AI 判斷不出客人想問什麼（自拍、風景、模糊照）時，
 * 問客人的那一句照樣會發，只是不附猜的按鈕（只剩「找真人」），而不是硬掰兩個選項。
 */
const DESCRIBE_AND_ASK_INSTRUCTION = `你是客服助理。客人傳了一張圖片到官方帳號，請輸出 JSON：{"description":"...","questions":["...","..."]}

description（給客服看的描述）：
- 用繁體中文（台灣用語）一句話，30 字以內。
- 只描述畫面上真的看得到的東西，看不清楚就說看不清楚，絕對不要猜測。
- 不要加「這張圖是」「圖片顯示」之類的開場。
- 個資保護：看到身分證號、信用卡號、電話、地址等，只說有這類資訊（例如「含信用卡號的截圖」），不要把號碼本身寫出來。

questions（客人傳這張圖最可能想問的話，會做成按鈕讓客人點選）：
- 最多兩句，每句 16 字以內，用客人的口吻寫成問句，例如「瑕疵可以換貨嗎？」「付款失敗怎麼辦？」。
- 兩句要是不同的事，不要同一個問題換句話說。
- **判斷不出來就給空陣列 []**。以下情況一律給空陣列：純自拍或人物照、風景照、寵物照、迷因或表情圖、
  模糊到看不出內容、單純打招呼性質的圖。寧可不給選項，也不要猜客人沒問的問題。
- 不要把訂單編號、商品型號或金額寫進問句。`

/** Gemini 支援的圖片 MIME；LINE 的圖片訊息實務上都是 jpeg，其餘保險起見一併放行 */
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

function clampOneLine(raw: unknown, max: number): string {
  const oneLine = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/**
 * 為什麼沒有問句——**三種「沒有」的下一步完全不同，不能都只留一行 log**：
 *   - `noQuestion`：AI 明講看不出客人想問什麼（自拍／風景）→ 問句照發、不附猜的按鈕，不用管。
 *   - `malformed`：AI 其實讀懂了，只是交回來的格式壞掉 → 客人少了猜的按鈕，這是要修的 bug。
 *     2026-09-10 之前它只寫進 console，正式站上壞了兩週沒有人知道，
 *     是老闆自己看到對話截圖才發現的。
 *   - `unavailable`：根本沒讀（AI 沒開／圖太小／下載失敗／逾時）。
 */
export type InboundImageReadState = 'ok' | 'noQuestion' | 'malformed' | 'answerOff' | 'unavailable'

/** 讀圖的產物。`questions` 只有工作區開了「客人傳的照片」、而且 AI 判斷得出來時才有值 */
export interface InboundImageReading {
  /** 給客服看的一句描述 */
  description: string
  /** 客人可能想問的話（最多兩句、每句塞得進 LINE 按鈕）；空陣列＝判斷不出來 */
  questions: string[]
  /** 這次讀圖的結果分類；`malformed` 是唯一代表「壞掉」的值 */
  state: InboundImageReadState
}

const EMPTY_READING: InboundImageReading = { description: '', questions: [], state: 'unavailable' }

/**
 * 把模型給的問句整理成按鈕用的樣子：壓成一行、去重、超過按鈕字數的整句丟掉、最多兩句。
 * 舊格式（單一 `question` 字串）也收，模型偶爾會照舊格式回。
 */
function cleanQuestions(raw: unknown, legacy: unknown): string[] {
  const list = Array.isArray(raw) ? raw : (typeof legacy === 'string' ? [legacy] : [])
  const out: string[] = []
  for (const item of list) {
    const q = String(item ?? '').replace(/\s+/g, ' ').trim()
    // 用 .length（UTF-16）數：emoji 會被算成兩個字，只會比 LINE 的算法更嚴、不會超過上限被退件
    if (!q || q.length > MAX_QUESTION_CHARS || out.includes(q)) continue
    out.push(q)
    if (out.length >= MAX_QUESTIONS) break
  }
  return out
}

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

  // 開關關著時只要描述，省一半輸出、也不會產生「客人想問什麼」這種會被誤用的欄位
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
          // 問句從一句變兩句，輸出上限跟著放寬：被截斷的 JSON 會整份讀不出來（＝malformed）
          maxOutputTokens: wantQuestion ? 256 : 120,
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

    if (!wantQuestion) return { description: clampOneLine(res.text, MAX_DESCRIPTION_CHARS), questions: [], state: 'answerOff' }

    // 模型偶爾會在合法 JSON 後面多吐一截殘句（見 parseFirstJsonValue 的實測紀錄）——
    // 取第一份完整的就好，不能因為後面有雜訊就把填對的兩格一起丟掉。
    const parsed = parseFirstJsonValue<{ description?: unknown; questions?: unknown; question?: unknown }>(res.text)
    if (!parsed) {
      // 連一份完整的都撿不到：至少把原文當描述留下來給客服，但絕不把壞掉的內容放到客人畫面上。
      console.warn('[media-describe] JSON parse failed, falling back to description only')
      return { description: clampOneLine(res.text, MAX_DESCRIPTION_CHARS), questions: [], state: 'malformed' }
    }
    const questions = cleanQuestions(parsed.questions, parsed.question)
    return {
      description: clampOneLine(parsed.description, MAX_DESCRIPTION_CHARS),
      questions,
      state: questions.length ? 'ok' : 'noQuestion',
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
