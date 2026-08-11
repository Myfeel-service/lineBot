/**
 * 用 Gemini Flash 把一份原始文件切成多張獨立知識卡。
 *
 * 設計重點：
 * - 一卡一主題；標題要簡短、內容講人話、不要 markdown
 * - 每張卡附 2–3 個「常見問法」：客人是用問句提問、卡片是敘述句，
 *   把問句一起 embed 能顯著拉高 query-card 相似度
 * - 忽略目錄、頁碼、版權聲明等沒實質內容的段落
 * - 強制 JSON 輸出（responseMimeType=application/json）
 * - 長文分段：單段過長會讓輸出 JSON 撞到 maxOutputTokens 被截斷（整次匯入歸零），
 *   所以超過 SEGMENT_CHAR_LEN 就切段、逐段呼叫再合併
 */
import { generateJson } from './gemini'
import type { ChunkInput } from './ai-knowledge-chunks'

export const MAX_CHUNKS_PER_DOC = 50

/**
 * 單段送進 LLM 的字數上限；超過就分段切卡。
 *
 * 兩個約束一起決定這個值：
 * 1) 內容很密（近乎逐字的手冊/說明書）時一段切出的卡總量會撞 maxOutputTokens 讓輸出 JSON
 *    被截斷（Unterminated string）→ 段要夠小。
 * 2) 非同步 job 一輪只切一段；那次 LLM 呼叫必須在閘道逾時內回（否則 poll 被 504、換手重跑
 *    同一段又同樣慢 → 卡死不前進）→ 段要夠小讓輸出快。
 * 8000 字對應的輸出約 ≤12k token（配 maxOutputTokens=12288），單次呼叫約 15–25s，兩個約束都滿足。
 * 真的還是撞到截斷，由呼叫端的「對半再切」保底。
 */
export const SEGMENT_CHAR_LEN = 8_000

/** 分段合併後的總卡數上限（大型商品目錄一份可能超過單段的 50 張） */
export const MAX_TOTAL_CHUNKS = 150

/**
 * 分段切卡的並行上限。多數文件截到 MAX_RAW_TEXT_LEN(100k)後 ≤ 5 段，
 * 設 5 讓典型情況「一波」做完；設了上限（而非無腦 Promise.all）是保底：
 * 萬一未來 segment 數變多，也不會一次併發爆掉 Gemini 的速率限制。
 */
export const CHUNK_CONCURRENCY = 5

const SYSTEM_INSTRUCTION = `你是專業的客服知識整理助手。任務：把使用者提供的原始文件切成獨立的「知識卡」，並讓每張卡對 AI 檢索 / 回答都最友善。

規則：
1. 一張卡聚焦一個主題（一卡一事）。不同主題就切開、相同主題就合併。
2. 標題簡短（不超過 20 字）、能讓人一眼看懂主題（例：「退換貨政策」、「運費說明」）。
3. 標題裡不要放品號、SKU、訂單編號等系統識別碼。
4. content 的格式：
   - 第一行：以「重點：」開頭，用 ｜ 分隔 3–6 個關鍵屬性（例：「重點：產地：巴拿馬｜處理：日曬｜烘焙：黃金｜主調：花香、白桃、藍莓」）。屬性只放主題**本身**的固定特徵，不要放它「現在」的狀態或進度。
   - 留一個空行。
   - 接著用完整句子的口語說明，不要 markdown / 項目符號 / 表情符號 / 敬語贅詞。
   - 如果整段內容沒有任何結構化屬性可以抽（例如純流程說明），則省略「重點：」行，直接寫敘述。
5. content **不要**出現品號、SKU、產品編號、訂單編號等系統識別碼；如果這些是該卡的核心識別資訊，請放到 tags（例：「品號21070906」）。
6. 內容要包含「客服回答時需要知道的完整資訊」，但去掉廢話 / 客套語 / 廣告詞。
7. 標籤從內容歸納 2–4 個關鍵字（例：售後、運費、會員）。
8. questions：為每張卡寫 2–3 個「客人實際會怎麼問」的口語問句（例：「運費怎麼算？」「多久會到貨？」）。用客人的字眼、不要照抄卡片標題。
9. 忽略、且「不要寫進任何卡片」的樣板文字：目錄、頁碼、版權／商標聲明、廣告、聯絡資訊樣板、純圖片標註，以及手冊常見的免責聲明（例：「畫面／插圖僅供示意」「內容如有變更，恕不另行通知」「可能與實際產品有所差異」「功能將持續升級故畫面可能變更」）。定義卡、說明卡也不要在結尾夾帶這類免責句。
10. 若整份文件都沒實質內容，回傳空陣列。
11. 最多輸出 50 張卡。
12. 連結：若某張卡對應的內容旁邊附有連結（原文格式為「文字（網址）」），請在該卡 content 最後**另起一行**寫「連結：<網址>」，方便客服回覆時提供。沒有附連結就不要寫這行，也**不要自己編造網址**。
13. **卡片內容只寫「下個月再看還是對的」的部分。** 原文裡描述「此時此刻」的敘述與數字不要抄進卡片——例如現在進行到哪、現在有多少人、現在還剩多少、還有多久結束。客服檢索到這張卡時那些值早就變了，等於拿舊資料回答客人。
    ⛔ 這條是「拿掉那幾句」，**不是「丟掉那張卡」**：一段內容混著固定事實與當下狀態時，主題本身（名稱、特色、規格、連結）照樣成卡，只略過當下狀態的那部分。商品、專案、活動的卡都要照切，不因為它「正在進行」就不切。
    判準是「這個值會不會自己變」，不是「它是不是數字」：價格、規格、容量、保固年限、費率、作業天數要完整保留；已經定案不會再變的紀錄（例如某活動的最終結果）當一般事實照寫。

輸出格式（嚴格 JSON）：
{
  "chunks": [
    { "title": "string", "content": "string", "tags": ["string", "string"], "questions": ["string", "string"] }
  ]
}`

interface ChunkerJsonResponse {
  chunks?: Array<{ title?: unknown; content?: unknown; tags?: unknown; questions?: unknown }>
}

export interface ChunkerResult {
  chunks: ChunkInput[]
  inputTokens: number
  outputTokens: number
}

/**
 * 把長文按段落邊界切成 ≤ SEGMENT_CHAR_LEN 的片段。
 * 切點往前找最近的換行，避免把一個主題從中間劈開；整段沒換行就硬切。
 */
export function segmentText(text: string, segmentLen = SEGMENT_CHAR_LEN): string[] {
  if (text.length <= segmentLen) return [text]
  const segments: string[] = []
  let rest = text
  while (rest.length > segmentLen) {
    const slice = rest.slice(0, segmentLen)
    const lastBreak = slice.lastIndexOf('\n')
    // 換行太前面（< 50%）代表這段幾乎沒段落結構，硬切比丟掉一半好
    const cut = lastBreak > segmentLen * 0.5 ? lastBreak : segmentLen
    segments.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) segments.push(rest)
  return segments.filter(Boolean)
}

/**
 * 對半切一段（在最近的換行邊界），保證回 ≥2 段。
 * 用於「切卡撞輸出上限（JSON 被截斷）」時把段縮小重試。
 */
export function splitSegmentInHalf(text: string): string[] {
  const t = String(text || '')
  if (t.length < 2) return [t]
  const half = Math.ceil(t.length / 2)
  const parts = segmentText(t, half)
  if (parts.length >= 2) return parts
  // 保底：segmentText 沒切開就硬切（理論上不會發生）
  return [t.slice(0, half), t.slice(half)].filter(Boolean)
}

/**
 * 是否為「輸出 JSON 被截斷」的錯誤（撞 maxOutputTokens）。
 * generateJson 對截斷的 JSON 會丟 `Gemini JSON parse failed: Unterminated ...`。
 * 這類錯誤靠「把段切小再試」可救；其它錯誤（網路 502 等）不該無限切。
 */
export function isChunkTruncationError(err: unknown): boolean {
  const msg = String((err as any)?.statusMessage || (err as any)?.message || '')
  return /JSON parse failed|Unterminated|Unexpected end|MAX_TOKENS/i.test(msg)
}

// ═══════════════════════════════════════════════════════════════════
//  Boilerplate 剝除（免責樣板清洗）
//  手冊 / 說明書 PDF 常在封面、前言夾帶「免責聲明」：畫面僅供示意、內容如有
//  變更恕不另行通知、版權商標宣告…。切卡時它會黏在定義卡尾巴，之後被檢索到就
//  被 LLM 原封唸出來（客人問「X 是什麼」卻收到一串免責聲明）。
//  規則 9 只是「請 LLM 忽略」的軟性請求、不保證照做——這裡做程式化剝除當硬底線。
//
//  作法：逐句掃描，命中「免責樣板標記」的整句刪掉，保留其餘實質內容。
//  標記都挑「幾乎只出現在免責文」的高辨識片語，寧可漏刪也不要誤刪正常答案。
//  「重點：」「連結：」開頭的結構行整行保留、不切句（避免動到 ｜ 分隔與網址）。
// ═══════════════════════════════════════════════════════════════════

/** 命中任一即視整句為免責樣板。挑高辨識片語，寧可漏刪也不要誤刪正常內容。 */
const BOILERPLATE_MARKERS: RegExp[] = [
  /恕不(另行|事先)?通知/, //                                如有變更，恕不另行通知
  /**
   * 「僅供示意」只出現在圖片免責；「僅供參考」不行——2026-08-11 拿正式站卡片實測，
   * 裸配「僅供參考」會誤刪真操作說明：「內鍋水位刻度僅供參考（請依米種調整水量）」
   * 「飯碗容量以 265ml 為參考值，容量僅供參考」。所以「僅供參考」必須綁圖像主詞才算免責。
   */
  /僅供示意/,
  /(畫面|插圖|圖片|圖示|示意圖|外觀)[^。！？!?\n]{0,10}僅供參考/,
  /(畫面|插圖|圖片|圖示|示意圖)[^。！？!?\n]{0,16}(與實際|實際產品|可能[^。！？!?\n]{0,4}(不同|差異|不一樣|不符))/,
  /與實際(產品|物品|商品|畫面)[^。！？!?\n]{0,8}(不同|差異|不符|不一樣|有所出入|為準)/,
  /(指南|手冊|說明書|本文件|本產品)[^。！？!?\n]{0,24}(可能|如有)[^。！？!?\n]{0,8}(變更|更新|差異|不同|升級)/,
  /版權所有|著作權所有|翻(印|譯)必究|保留[^。！？!?\n]{0,6}權利/,
  /all rights reserved/i,
  /[©™®]/,
  /[^。！？!?\n]{1,16}為[^。！？!?\n]{0,10}(註冊)?商標/, //     ○○為△△之（註冊）商標
  /概不負責|恕不負責|不負[^。！？!?\n]{0,4}責任/,
]

function isBoilerplateSentence(sentence: string): boolean {
  return BOILERPLATE_MARKERS.some(re => re.test(sentence))
}

/**
 * 從卡片 content 剝除免責樣板句。逐行處理：
 * - 「重點：」「連結：」開頭的結構行原樣保留（不切句，避免動到 ｜ 分隔或網址）。
 * - 其餘行按句尾（。！？!?）切句，逐句丟掉命中免責標記的整句、其餘留下。
 * 全部剝完後若沒剩實質內容，回空字串——由呼叫端當「純免責卡」丟棄。
 * 純函數，好測試。
 */
export function stripBoilerplate(content: string): string {
  const lines = String(content || '').split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      kept.push('') // 保留空行維持段落結構（下方再收合連續空行）
      continue
    }
    if (trimmed.startsWith('重點：') || trimmed.startsWith('連結：')) {
      kept.push(line)
      continue
    }
    // 按句尾標點切句（保留標點），逐句過濾免責樣板
    const cleaned = line
      .split(/(?<=[。！？!?])/)
      .filter(s => s.trim() && !isBoilerplateSentence(s))
      .join('')
    if (cleaned.trim()) kept.push(cleaned)
  }
  // 收合連續空行、去頭尾空白
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 對「單一段」原始文字切卡。長文分段（chunkTextWithLlm）與非同步 job 狀態機
 * （ai-preview-jobs 逐段推進）共用；export 讓後者能一輪呼叫一段。
 */
export async function chunkSegment(text: string, hint: string | undefined): Promise<ChunkerResult> {
  const prompt = [
    hint ? `來源提示：${hint}` : '',
    '請依照規則把以下原始文件切成知識卡：',
    '------',
    text,
    '------',
  ].filter(Boolean).join('\n\n')

  const { data, inputTokens, outputTokens } = await generateJson<ChunkerJsonResponse>(prompt, {
    systemInstruction: SYSTEM_INSTRUCTION,
    // temperature 0（不是 0.2）：切卡是抽取任務，不需要多樣性，而「同一份原文重切兩次要得到
    // 同一批卡」是重新同步能不能被信任的前提。0.2 會讓每次重切換句話說、甚至換一種切法，
    // diff 就會憑空冒出一堆「修改 / 移除 + 新增」——網頁根本沒改，使用者卻被要求逐張決定。
    temperature: 0,
    // 內容密的手冊一段可切出很多卡；8192 太緊會讓輸出 JSON 截斷。給到 12288 有餘裕，
    // 但也不設更高——單次呼叫要在閘道逾時內回（見 SEGMENT_CHAR_LEN 註解）。撞到就靠對半再切。
    maxOutputTokens: 12288,
    // thinking 會吃掉 maxOutputTokens 配額，讓 JSON 寫到一半被截斷（Unterminated string）。
    // 切卡不需要深度思考，關掉把整個配額留給輸出。
    thinkingBudget: 0,
  })

  const rawChunks = Array.isArray(data?.chunks) ? data.chunks : []
  const chunks: ChunkInput[] = []
  for (const raw of rawChunks.slice(0, MAX_CHUNKS_PER_DOC)) {
    const title = String(raw?.title ?? '').trim()
    // 剝除免責樣板：規則 9 只是「請 LLM 忽略」的軟指令，這裡做程式化硬剝除。
    // 純免責卡剝完會變空字串，被下方 `!content` 守衛丟掉。
    const content = stripBoilerplate(String(raw?.content ?? '').trim())
    const tags = Array.isArray(raw?.tags)
      ? raw.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 6)
      : []
    const questions = Array.isArray(raw?.questions)
      ? raw.questions.map(q => String(q).trim()).filter(Boolean).slice(0, 3)
      : []
    if (!title || !content) continue
    chunks.push({ title, content, tags, questions, sourceId: null })
  }

  return { chunks, inputTokens, outputTokens }
}

/**
 * 把原始純文字交給 Gemini 切成知識卡。
 * 超過 SEGMENT_CHAR_LEN 自動分段逐段切卡再合併（同 title 留第一張）。
 * 失敗會 throw（讓上層決定要不要降級成「整包當一張卡」）；
 * 分段模式下單段失敗就整體 throw——寧可重來也不要默默少一段。
 */
export async function chunkTextWithLlm(rawText: string, opts?: { hint?: string }): Promise<ChunkerResult> {
  const text = String(rawText || '').trim()
  if (!text) return { chunks: [], inputTokens: 0, outputTokens: 0 }

  const segments = segmentText(text)

  // 逐段切卡改「有上限的並行」：原本是循序 await，N 段 = N×單段耗時，
  // 長文(最多 5 段)累積到 2–3 分鐘就撞 Amplify/CloudFront 的閘道逾時 → 前端看到 504。
  // 並行後 wall-clock ≈ 單段耗時。結果仍照「段序」合併/去重，輸出與原循序版一致。
  // 代價：原本一撞 MAX_TOTAL_CHUNKS 就不再呼叫後續段（省 token），並行版會先把所有段
  // 都跑完才合併，極端情況多花 1–2 段 token；用量照實入帳，換到的是不再逾時，划算。
  const results: ChunkerResult[] = new Array(segments.length)
  let nextIndex = 0
  async function worker() {
    for (let i = nextIndex++; i < segments.length; i = nextIndex++) {
      const hint = segments.length > 1
        ? `${opts?.hint ?? ''}（第 ${i + 1}/${segments.length} 段）`.trim()
        : opts?.hint
      results[i] = await chunkSegment(segments[i]!, hint)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CHUNK_CONCURRENCY, segments.length) }, () => worker()),
  )

  // 照段序合併 + 去重（同 title 留先出現的那張），維持與原循序版相同的取捨順序。
  const seenTitles = new Set<string>()
  const merged: ChunkInput[] = []
  let inputTokens = 0
  let outputTokens = 0
  for (const res of results) {
    inputTokens += res.inputTokens
    outputTokens += res.outputTokens
    for (const c of res.chunks) {
      const key = c.title.replace(/\s+/g, '')
      if (seenTitles.has(key)) continue
      seenTitles.add(key)
      merged.push(c)
      if (merged.length >= MAX_TOTAL_CHUNKS) break
    }
    if (merged.length >= MAX_TOTAL_CHUNKS) break
  }

  return { chunks: merged, inputTokens, outputTokens }
}

// ═══════════════════════════════════════════════════════════════════
//  Overview（總覽卡）
//  列表頁（商品首頁、型錄頁）切碎成個別卡片後，再額外合成「一張」分類索引卡。
//  用途：接「你們有賣什麼 / 有哪些產品」這類列舉型問題 —— 個別產品卡對這種廣泛
//  提問相似度都低且接近，會誤觸反問澄清；一張帶分類結構的總覽卡能被廣泛提問
//  精準命中（靠它的 questions），top-1 衝高就直接回答。
//
//  設計：從「已切好的子卡片標題 + 重點行」合成，不重讀原文 ——
//  比再跑一次原文便宜、且保證總覽內容與實際卡片一致；長文也只餵標題不會撞 token 上限。
// ═══════════════════════════════════════════════════════════════════

const OVERVIEW_SYSTEM_INSTRUCTION = `你是專業的客服知識整理助手。任務：把一份「卡片清單」濃縮成「一張」總覽卡，讓客人問「你們有賣什麼 / 有哪些 / 全部品項」這類列舉型問題時，能用這張卡一次回答。

規則：
1. 只輸出「一張」卡，不要拆成多張。
2. 把清單裡的品項依性質歸成幾個分類（例：家電、咖啡、寵物、生活…），同類放一起。
3. content 格式：
   - 第一行以「重點：」開頭，用 ｜ 分隔各分類，每個分類後面用括號列出該類的主要品項（例：「重點：家電（循環扇、洗衣機、除濕機）｜咖啡（智慧咖啡機、手沖機）｜寵物（飲水機、清淨機）」）。
   - 留一個空行。
   - 接著用 1–3 句口語總結（例：「我們主要販售各式家電、咖啡與生活用品，想了解哪一類可以再告訴我。」），不要 markdown / 項目符號 / 表情符號。
4. 不要遺漏清單裡的主要品項；但同質、重複的可合併描述。不要捏造清單裡沒有的品項。
5. 不要出現品號、SKU、價格、編號，也不要出現描述「此時此刻」的狀態或進度（它下個月就不對了）。
6. tags：放 2–4 個分類關鍵字（例：商品總覽、產品列表）。
7. questions：寫 3–4 個客人會用來問「全部品項」的口語問句（例：「你們有賣什麼？」「有哪些產品？」「全部商品有哪些？」「有什麼推薦？」）。

輸出格式（嚴格 JSON）：
{ "title": "string", "content": "string", "tags": ["string"], "questions": ["string"] }`

/** 合成總覽卡時，每張子卡只取「標題 + 內容第一行」餵進 LLM，控制 input 量 */
function overviewSourceLine(c: ChunkInput): string {
  const firstLine = c.content.split('\n').map(s => s.trim()).find(Boolean) ?? ''
  return firstLine ? `- ${c.title}：${firstLine}` : `- ${c.title}`
}

export interface OverviewResult {
  card: ChunkInput
  inputTokens: number
  outputTokens: number
}

/**
 * 從已切好的卡片清單合成「一張」總覽卡（isOverview=true）。
 * 子卡片不足 2 張時回 null（沒必要做總覽）。失敗時 throw，由 caller 決定要不要降級。
 */
export async function summarizeAsOverviewCard(
  chunks: ChunkInput[],
  opts?: { hint?: string },
): Promise<OverviewResult | null> {
  const items = chunks.filter(c => c.title && c.content)
  if (items.length < 2) return null

  const prompt = [
    opts?.hint ? `來源：${opts.hint}` : '',
    '請把下面這份卡片清單濃縮成「一張」總覽卡：',
    '------',
    items.map(overviewSourceLine).join('\n'),
    '------',
  ].filter(Boolean).join('\n\n')

  const { data, inputTokens, outputTokens } = await generateJson<{
    title?: unknown
    content?: unknown
    tags?: unknown
    questions?: unknown
  }>(prompt, {
    systemInstruction: OVERVIEW_SYSTEM_INSTRUCTION,
    temperature: 0.2,
    maxOutputTokens: 2048,
    // 同其它結構化 JSON 任務：關掉 thinking，避免吃掉配額把 JSON 截斷
    thinkingBudget: 0,
  })

  const title = String(data?.title ?? '').trim()
  const content = String(data?.content ?? '').trim()
  if (!title || !content) return null
  const tags = Array.isArray(data?.tags)
    ? data.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 6)
    : []
  const questions = Array.isArray(data?.questions)
    ? data.questions.map(q => String(q).trim()).filter(Boolean).slice(0, 4)
    : []

  return {
    card: { title, content, tags, questions, sourceId: null, isOverview: true },
    inputTokens,
    outputTokens,
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Enrich（補問法）
//  Google Sheet / 乾淨 Excel 的「一列一卡」不經 LLM，卡片天生沒有 questions
//  （客人問法）——而 questions 進 embedding 對 query-card 相似度的拉抬，
//  是切卡路徑已驗證的（見檔頭設計重點）。
//
//  鐵則：只「補」不「改」。不動 title / content —— 它們是 gsheet 同步的
//  比對基準（title 是 key、content 是變更偵測），改寫會讓每次同步都誤判
//  「內容有變」而無限重跑。所以這裡只生成 questions + tags。
// ═══════════════════════════════════════════════════════════════════

/** 一次 LLM 呼叫最多補幾張卡。輸出量小（每卡 ~80 token），15 張一批單次呼叫仍快。 */
export const ENRICH_BATCH_SIZE = 15

/** 補問法時每張卡餵給 LLM 的內容字數上限：生成問法只需要卡片大意，全文是浪費。 */
const ENRICH_CARD_CONTENT_LEN = 600

const ENRICH_SYSTEM_INSTRUCTION = `你是專業的客服知識整理助手。使用者會給你一批「客服問答卡」（每張有編號、標題、內容）。任務：為每一張卡生成「客人可能的問法」與分類標籤。

規則：
1. questions：每張卡寫 2–3 句「客人實際會怎麼問」的口語問句。用客人的字眼（例：「錢什麼時候會退？」「多久會到貨？」），不要照抄卡片標題，句子之間要有變化。
2. tags：從內容歸納 1–2 個分類關鍵字（例：退款、運費、會員）。
3. 不要改寫、不要評論卡片內容；只輸出 questions 與 tags。
4. 每張輸入的卡都要有對應輸出，index 用輸入時的編號。

輸出格式（嚴格 JSON）：
{ "cards": [ { "index": 0, "questions": ["string", "string"], "tags": ["string"] } ] }`

export interface EnrichedCard {
  questions: string[]
  tags: string[]
}

export interface EnrichResult {
  /** 與輸入同長度、同順序；LLM 漏答（或該批失敗）的位置為空陣列 */
  items: EnrichedCard[]
  inputTokens: number
  outputTokens: number
}

/**
 * 對「一批」卡片（≤ ENRICH_BATCH_SIZE）跑一次 LLM 補問法。
 * 失敗會 throw，由呼叫端決定降級（卡片沒有問法仍可用，不該擋匯入/同步）。
 */
export async function enrichCardBatch(
  cards: Array<{ title: string; content: string }>,
): Promise<EnrichResult> {
  if (!cards.length) return { items: [], inputTokens: 0, outputTokens: 0 }

  const prompt = [
    '請為以下每一張問答卡生成 questions 與 tags：',
    '------',
    ...cards.map((c, i) =>
      `[${i}] 標題：${c.title}\n內容：${String(c.content ?? '').slice(0, ENRICH_CARD_CONTENT_LEN)}`),
    '------',
  ].join('\n\n')

  const { data, inputTokens, outputTokens } = await generateJson<{
    cards?: Array<{ index?: unknown; questions?: unknown; tags?: unknown }>
  }>(prompt, {
    systemInstruction: ENRICH_SYSTEM_INSTRUCTION,
    temperature: 0.2,
    // 15 卡 × ~80 token ≈ 1200；給 4096 餘裕
    maxOutputTokens: 4096,
    // 同其它結構化 JSON 任務：關掉 thinking，避免吃掉配額把 JSON 截斷
    thinkingBudget: 0,
  })

  const items: EnrichedCard[] = cards.map(() => ({ questions: [], tags: [] }))
  const assigned = new Set<number>()
  for (const raw of Array.isArray(data?.cards) ? data.cards : []) {
    // 嚴格解析 index：只收「數字」或「純數字字串」。Number(null)/Number('')/Number([]) 都會變 0，
    // 若照收會讓漏帶 index 的壞資料洗掉 items[0]；重複 index 也只認第一筆（assigned 擋掉）。
    const rawIdx: unknown = raw?.index
    const idx = typeof rawIdx === 'number'
      ? rawIdx
      : (typeof rawIdx === 'string' && /^\d+$/.test(rawIdx.trim()) ? Number(rawIdx) : Number.NaN)
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length || assigned.has(idx)) continue
    assigned.add(idx)
    items[idx] = {
      questions: Array.isArray(raw?.questions)
        ? raw.questions.map(q => String(q).trim()).filter(Boolean).slice(0, 3)
        : [],
      tags: Array.isArray(raw?.tags)
        ? raw.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 2)
        : [],
    }
  }
  return { items, inputTokens, outputTokens }
}

/**
 * 對任意數量的卡片補問法：切成 ≤ ENRICH_BATCH_SIZE 的批次並行呼叫。
 * 單批失敗不擋整體——該批的位置維持空陣列（卡片沒問法仍可用），只記 warning。
 * 給同步路徑用；匯入預覽走 job 狀態機、一輪一批，直接呼叫 enrichCardBatch。
 */
export async function enrichCardsWithLlm(
  cards: Array<{ title: string; content: string }>,
): Promise<EnrichResult> {
  const batches: Array<Array<{ title: string; content: string }>> = []
  for (let i = 0; i < cards.length; i += ENRICH_BATCH_SIZE) {
    batches.push(cards.slice(i, i + ENRICH_BATCH_SIZE))
  }

  const results = await Promise.all(batches.map(async (batch) => {
    try {
      return await enrichCardBatch(batch)
    }
    catch (e) {
      console.warn('[enrichCardsWithLlm] batch failed（該批卡片不補問法，照常繼續）:', e)
      return {
        items: batch.map(() => ({ questions: [], tags: [] })),
        inputTokens: 0,
        outputTokens: 0,
      } satisfies EnrichResult
    }
  }))

  return {
    items: results.flatMap(r => r.items),
    inputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
  }
}

/**
 * 這張卡是否該補問法（給「reenrich 回填程序」判斷）：
 * - 總覽卡（isOverview）另有合成流程，不動。
 * - 人工編輯過（manuallyEditedAt）的卡尊重使用者版本，不動。
 * - 已有有效問法的不重補。
 * - title / content 任一為空的沒東西可餵 LLM，跳過。
 * 純函數，方便測試；欄位型別放寬（直接吃 Firestore doc data）。
 */
export function needsQuestionEnrichment(card: {
  title?: unknown
  content?: unknown
  questions?: unknown
  isOverview?: unknown
  manuallyEditedAt?: unknown
}): boolean {
  if (card.isOverview === true) return false
  if (card.manuallyEditedAt) return false // null / undefined = 沒被人工編輯過
  const hasQuestions = Array.isArray(card.questions) && card.questions.some(q => String(q ?? '').trim())
  if (hasQuestions) return false
  return !!String(card.title ?? '').trim() && !!String(card.content ?? '').trim()
}

// ═══════════════════════════════════════════════════════════════════
//  Normalize（單卡整理）
//  既有卡 / 手打卡用同樣的 system instruction 跑一次，把它變成標準格式：
//    - 第一行「重點：」keyword 摘要
//    - 移除品號 / 編號
//    - 內文重寫成口語完整句
// ═══════════════════════════════════════════════════════════════════

const NORMALIZE_SYSTEM_INSTRUCTION = `你是專業的客服知識整理助手。任務：把使用者提供的「單一張知識卡」重新整理成標準格式，**不要切成多張**。

規則：
1. 保持是一張卡（不要拆）；輸出一個 chunk 物件。
2. 標題保留主要識別資訊，但移除品號、SKU、訂單編號等系統識別碼；長度不超過 20 字。
3. content 的格式：
   - 第一行：以「重點：」開頭，用 ｜ 分隔 3–6 個關鍵屬性（例：「重點：產地：巴拿馬｜處理：日曬｜烘焙：黃金｜主調：花香、白桃、藍莓」）。
   - 留一個空行。
   - 接著用完整句子的口語說明，不要 markdown / 項目符號 / 表情符號 / 敬語贅詞。
   - 若原文已有「重點：」開頭，請替換為新版，不要疊加。
   - 如果沒有任何結構化屬性可抽（純流程說明等），則省略「重點：」行，直接寫敘述。
4. content 不要包含品號、SKU 等系統識別碼；若這些是核心識別，請放到 tags。
5. 保留所有有意義的事實資訊；不要漏資訊、不要加你自己編的內容。
   唯一的例外：描述「此時此刻」的敘述與數字要拿掉（判準是這個值會不會自己變，不是它是不是數字）——價格、規格、保固、費率、作業天數一律保留。
6. 標籤盡量沿用原本的、需要時補充 1–2 個新標籤，總共 2–6 個。
7. questions：寫 2–3 個「客人實際會怎麼問」的口語問句，用客人的字眼、不要照抄標題。

輸出格式（嚴格 JSON）：
{ "title": "string", "content": "string", "tags": ["string"], "questions": ["string"] }`

export interface NormalizeResult {
  title: string
  content: string
  tags: string[]
  questions: string[]
  inputTokens: number
  outputTokens: number
}

/**
 * 對單張卡跑 LLM 整理，回傳整理後的 title / content / tags。
 * 失敗時 throw；caller 自行決定要不要降級成「保留原本不動」。
 */
export async function normalizeChunkWithLlm(input: {
  title: string
  content: string
  tags: string[]
}): Promise<NormalizeResult> {
  const prompt = [
    '請依規則整理這張知識卡：',
    '------',
    `[原標題] ${input.title}`,
    `[原標籤] ${input.tags.join('、') || '（無）'}`,
    '[原內容]',
    input.content,
    '------',
  ].join('\n')

  const { data, inputTokens, outputTokens } = await generateJson<{
    title?: unknown
    content?: unknown
    tags?: unknown
    questions?: unknown
  }>(prompt, {
    systemInstruction: NORMALIZE_SYSTEM_INSTRUCTION,
    temperature: 0.2,
    maxOutputTokens: 4096,
    // 同 chunkSegment：關掉 thinking，避免吃掉配額把 JSON 截斷。
    thinkingBudget: 0,
  })

  const title = String(data?.title ?? '').trim() || input.title
  const content = String(data?.content ?? '').trim()
  const tags = Array.isArray(data?.tags)
    ? data.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 6)
    : input.tags
  const questions = Array.isArray(data?.questions)
    ? data.questions.map(q => String(q).trim()).filter(Boolean).slice(0, 3)
    : []

  if (!content) {
    throw createError({ statusCode: 502, statusMessage: 'normalize: LLM 回傳的 content 為空' })
  }

  return { title, content, tags, questions, inputTokens, outputTokens }
}

// ═══════════════════════════════════════════════════════════════════
//  Detect product name（匯入自動認產品名，P1-1）
//  來源層 productName 是反問分組 / 防混答 / 指名作答的根基，過去全靠工程師手動
//  改 Firestore（無主卡兩次釀成實測事故）。匯入預覽收尾時自動偵測、預填給使用者確認。
// ═══════════════════════════════════════════════════════════════════

const DETECT_PRODUCT_SYSTEM_INSTRUCTION = `你在幫商家整理客服知識庫。判斷這份文件是否「以單一產品為主」（產品說明書、單一商品頁等）。

規則：
1. 是單一產品 → 回該產品的完整正規名稱：品牌 + 產品名 +（有的話）型號 / 規格，例「GPLUS 智慧除濕機 12L」「SHARP iBarista 智慧咖啡機」。以文件自己的寫法為準，不要自行翻譯或改寫品牌名。
2. 文件涵蓋多個產品（型錄、FAQ 彙整、公告）或是平台/公司頁（關於我們、隱私權、運送說明）→ productName 回空字串。
3. 名稱長度 30 字以內；不要包含「說明書」「使用手冊」「操作指南」這類文件類型字眼。

輸出格式（嚴格 JSON）：{ "productName": "string" }`

export interface DetectProductNameResult {
  productName: string
  inputTokens: number
  outputTokens: number
}

/**
 * 從「來源名稱（檔名 / 網址 / 標題）＋內文前段」偵測單一產品名。
 * 多產品 / 平台頁回空字串。失敗 throw；caller 降級為「不預填」即可（不擋匯入）。
 */
export async function detectProductName(sampleText: string, sourceHint: string): Promise<DetectProductNameResult> {
  const prompt = [
    `[來源名稱] ${sourceHint || '（無）'}`,
    '[內文開頭]',
    String(sampleText ?? '').slice(0, 2000),
  ].join('\n')

  const { data, inputTokens, outputTokens } = await generateJson<{ productName?: unknown }>(prompt, {
    systemInstruction: DETECT_PRODUCT_SYSTEM_INSTRUCTION,
    temperature: 0.1,
    maxOutputTokens: 256,
    // 同 chunkSegment：關掉 thinking，避免吃掉配額把 JSON 截斷。
    thinkingBudget: 0,
  })

  return {
    productName: String(data?.productName ?? '').trim().slice(0, 60),
    inputTokens,
    outputTokens,
  }
}
