/**
 * Google Gemini API client（Phase 1 只用到 embed；generate 留給 Phase 2）。
 *
 * 走 REST 不走 SDK：避免多一個 npm 依賴、也避免 SDK 跨 Node 版本相容性問題。
 * Key 由 nuxt.config.ts runtimeConfig.geminiApiKey 注入。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { EMBEDDING_DIMENSION } from '~~/shared/types/ai-knowledge'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// ═══════════════════════════════════════════════════════════════════
//  維運額度收口（C-45）
//  所有 LLM / embedding 呼叫都走這個檔案——額度守門收在這個出口，
//  未來任何新功能只要外層用 runWithLlmBudget 圈起來就自動被守住，
//  不必每個入口各自記得加檢查（「忘了加」正是健檢抓到的病）。
//
//  用 AsyncLocalStorage 傳 workspace 境域而非改每個函式簽名：
//  切卡/補問法/OCR 這些工具函式不用知道額度的存在。
//  沒被圈住的呼叫（回答客人路徑有自己的則數額度）不查、行為不變。
// ═══════════════════════════════════════════════════════════════════

const llmBudgetALS = new AsyncLocalStorage<{ workspaceId: string }>()

/** 把一段維運工作圈進某 workspace 的額度境域：內部所有 gemini 呼叫都會先過額度檢查 */
export function runWithLlmBudget<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  if (!workspaceId) return fn()
  return llmBudgetALS.run({ workspaceId }, fn)
}

/** 出口守門：境域內才查；超額丟 429（lazy import 避免模組相依環） */
async function assertLlmBudget(): Promise<void> {
  const ctx = llmBudgetALS.getStore()
  if (!ctx) return
  const { assertMaintenanceBudget } = await import('./ai-usage')
  await assertMaintenanceBudget(ctx.workspaceId)
}

/**
 * 過載 / 暫時性錯誤：自動重試。
 *
 * MAX_RETRIES 設 1（總共 2 次嘗試）是刻意保守的：每個 Gemini 模型呼叫最多花 ~3-5s 就決定成敗，
 * 配合 generateText 的 auto-fallback（flash 失敗 → flash-lite），整體最壞約 ~10s 結束。
 * 設高會讓 playground「AI 思考中」卡住很久（之前 3 retries 配合 fallback 最壞會卡 ~50s）。
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 1
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 2000

export type EmbeddingTaskType =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY'

interface EmbedResponse {
  embedding?: { values?: number[] }
  error?: { message?: string }
}

function getApiKey(): string {
  const key = useRuntimeConfig().geminiApiKey
  if (!key) {
    throw createError({
      statusCode: 500,
      statusMessage: 'GEMINI_API_KEY is not configured. Please set it in your .env file.',
    })
  }
  return key
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callGemini<T>(path: string, body: unknown): Promise<T> {
  const apiKey = getApiKey()
  // key 走 header 不走 query string，避免進到各層 access log
  const url = `${GEMINI_API_BASE}/${path}`

  let lastReason = ''
  let lastStatus = 0

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      })
    }
    catch (err) {
      // 網路層錯誤（DNS、TLS、連線中斷）也視為可重試
      lastReason = `network error: ${(err as Error).message}`
      lastStatus = 0
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt))
        continue
      }
      throw createError({ statusCode: 502, statusMessage: `Gemini error: ${lastReason}` })
    }

    const data = await res.json().catch(() => ({})) as any
    if (res.ok) return data as T

    lastReason = data?.error?.message || `Gemini API ${res.status}`
    lastStatus = res.status

    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES) {
      throw createError({ statusCode: 502, statusMessage: `Gemini error: ${lastReason}` })
    }

    await sleep(backoffDelay(attempt))
  }

  throw createError({
    statusCode: 502,
    statusMessage: `Gemini error (after ${MAX_RETRIES} retries, last status ${lastStatus}): ${lastReason}`,
  })
}

/** 指數退避 + 隨機抖動。attempt 從 0 起：500ms → 1s → 2s，上限 4s。 */
function backoffDelay(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  const jitter = Math.random() * base * 0.3
  return Math.round(base + jitter)
}

/**
 * 為「知識卡內容」算 embedding（會被存進向量索引）。
 * 模型 gemini-embedding-001，outputDimensionality=768（與 Firestore 向量索引相容）。
 */
export async function embedDocument(text: string): Promise<number[]> {
  await assertLlmBudget()
  return embed(text, 'RETRIEVAL_DOCUMENT')
}

/**
 * 為「使用者提問」算 embedding（用於向量搜尋）。
 * 用不同 taskType 是 Google 的推薦做法——同一句話 doc 跟 query 的 embedding 略有差別。
 */
export async function embedQuery(text: string): Promise<number[]> {
  return embed(text, 'RETRIEVAL_QUERY')
}

async function embed(text: string, taskType: EmbeddingTaskType): Promise<number[]> {
  const input = String(text || '').trim()
  if (!input) throw createError({ statusCode: 400, statusMessage: 'embed: empty input' })

  const data = await callGemini<EmbedResponse>('models/gemini-embedding-001:embedContent', {
    model: 'models/gemini-embedding-001',
    content: { parts: [{ text: input }] },
    taskType,
    outputDimensionality: EMBEDDING_DIMENSION,
  })
  const values = data?.embedding?.values
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSION) {
    throw createError({
      statusCode: 502,
      statusMessage: `Gemini embed: unexpected vector shape (got ${values?.length ?? 'null'} dims)`,
    })
  }
  return values
}

/**
 * 粗估 token 數（用於成本統計、quota 預警）。
 * Gemini 中文約 1 字 ~= 1.5 tokens；這邊用保守估算，正式用量由 API 回傳為準。
 */
export function estimateTokens(text: string): number {
  const t = String(text || '')
  if (!t) return 0
  return Math.ceil(t.length * 1.5)
}

// ═══════════════════════════════════════════════════════════════════
//  Generate（給 LLM 切卡與 Phase 2 的答題用）
// ═══════════════════════════════════════════════════════════════════

export interface GenerateOptions {
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
  /** 若指定 'application/json'，Gemini 會強制輸出合法 JSON */
  responseMimeType?: 'text/plain' | 'application/json'
  /** 預設用 gemini-2.5-flash（aiSettings 的 answerModel；切卡不另外傳） */
  model?: 'gemini-2.5-flash' | 'gemini-2.5-flash-lite'
  /**
   * Gemini 2.5 系列的 thinking token 會計入 maxOutputTokens。
   * 短回覆 + 緊的 output cap 時務必設 0，否則 thinking 吃掉配額會把輸出（尤其 JSON）截斷。
   * undefined = 交給模型預設（dynamic thinking）。
   */
  thinkingBudget?: number
}

interface GenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: { message?: string }
}

export interface GenerateResult {
  text: string
  inputTokens: number
  outputTokens: number
}

/** 一則 user message 的 part:純文字、或 inline 檔案(PDF / 圖片,base64) */
export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }

async function doGenerate(parts: GeminiPart[], opts: GenerateOptions, model: NonNullable<GenerateOptions['model']>): Promise<GenerateResult> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
      ...(opts.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
      ...(opts.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } } : {}),
    },
  }
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] }
  }

  const data = await callGemini<GenerateResponse>(`models/${model}:generateContent`, body)
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
  return {
    text,
    inputTokens: data?.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
  }
}

/**
 * 呼叫 Gemini generate。回傳純文字 + token 統計。
 *
 * **Auto-fallback**：主模型若是 `gemini-2.5-flash` 且 retry 後仍失敗（502，多半是高負載），
 * 自動再用 `gemini-2.5-flash-lite` 試一次。flash-lite 比較少人用、相對不會塞車，
 * 寧可拿到「輸出品質稍差但有」也好過完全失敗。flash-lite 本身失敗就照樣 throw。
 */
export async function generateText(prompt: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
  return generateParts([{ text: prompt }], opts)
}

/**
 * 同 generateText,但 user message 可帶多個 part(例:inline PDF + 指令文字)。
 * 給掃描檔 OCR 這類多模態輸入用;fallback 行為與 generateText 一致。
 */
export async function generateParts(parts: GeminiPart[], opts: GenerateOptions = {}): Promise<GenerateResult> {
  await assertLlmBudget()
  const primary = opts.model ?? 'gemini-2.5-flash'
  try {
    return await doGenerate(parts, opts, primary)
  }
  catch (err: any) {
    if (primary === 'gemini-2.5-flash' && err?.statusCode === 502) {
      console.warn(`[gemini] ${primary} unavailable (${err?.statusMessage ?? 'unknown'}), falling back to gemini-2.5-flash-lite`)
      return await doGenerate(parts, opts, 'gemini-2.5-flash-lite')
    }
    throw err
  }
}

/**
 * 呼叫 Gemini 並要求回傳 JSON。失敗時拋錯（避免拿不完整 JSON 去 parse）。
 */
export async function generateJson<T>(prompt: string, opts: Omit<GenerateOptions, 'responseMimeType'> = {}): Promise<{ data: T; inputTokens: number; outputTokens: number }> {
  const res = await generateText(prompt, { ...opts, responseMimeType: 'application/json' })
  try {
    return {
      data: JSON.parse(res.text) as T,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    }
  }
  catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: `Gemini JSON parse failed: ${(err as Error).message}. Raw: ${res.text.slice(0, 200)}`,
    })
  }
}
