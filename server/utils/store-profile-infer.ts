/**
 * 老店反推輪廓（`D-85` / `C-222`）：從既有資料猜出「這家店是誰」。
 *
 * ── 為什麼不叫既有商家重填 ────────────────────────────────────
 * 已經用了一陣子的帳號，知識庫、標籤、活動名稱裡其實寫滿了這家店在賣什麼。
 * 再叫他從頭答五題，等於在說「我認識你這麼久了還是不認識你」。
 * 而且這是驗「AI 猜得準不準」最快的方法——拿真實資料試，一次就知道。
 *
 * ── 三條紀律 ───────────────────────────────────────────────────
 * ① **全部唯讀**，而且只讀「名字級」的東西（卡片標題、標籤名、活動名），
 *    ⛔ 不整包撈內文：那是 `offset()` 讀取費暴衝的同型問題，而且對猜輪廓沒有更好。
 * ② **撞上限要講得出來**：查詢有 limit，取到上限時要回 `truncated`，
 *    ⛔ 不可以把「只看了前 N 筆」講成「看了全部」。
 * ③ **猜出來的一律標 `ai`**，而且商家改過的欄位不覆蓋（交給 `mergeAiGuesses`）。
 */

import { FieldPath, type Firestore } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { generateJson } from '~~/server/utils/gemini'
import { aiGuessableFields } from '~~/server/utils/store-profile-extract'
import type { StoreProfileFieldId } from '~~/shared/types/store-profile'

/** 各類最多看幾筆。夠猜出輪廓就好，⛔ 不是越多越準，只是越貴。 */
export const INFER_LIMITS = { chunks: 60, tags: 40, campaigns: 20 } as const

export interface InferSources {
  workspaceName: string
  /** 知識卡標題（不含內文） */
  chunkTitles: string[]
  /** 客人常見問法（知識卡上 LLM 生成的那幾句） */
  questions: string[]
  tagNames: string[]
  campaignNames: string[]
  /** 哪幾類撞到上限了——⛔ 一定要往上傳，不然「只看了前 60 張」會被講成「看了全部」 */
  truncated: string[]
}

/** 有沒有足夠的東西可以猜。⛔ 什麼都沒有時不要硬猜，那只會生出一份憑空捏造的輪廓。 */
export function hasEnoughToInfer(s: InferSources): boolean {
  return s.chunkTitles.length + s.tagNames.length + s.campaignNames.length >= 3
}

/** 唯讀撈既有資料。每一類各自 try/catch：一類查不到不該讓整支失敗。 */
export async function collectInferSources(
  workspaceId: string,
  workspaceName: string,
  db: Firestore = getDb(),
): Promise<InferSources> {
  const out: InferSources = {
    workspaceName,
    chunkTitles: [],
    questions: [],
    tagNames: [],
    campaignNames: [],
    truncated: [],
  }

  try {
    // 單欄位 equality 查詢，免複合索引（沿用 setup-status 的做法）。
    // ⚠️ **一定要 orderBy 文件 id**：沒有排序時 Firestore 每次回的那 60 筆可能不一樣，
    // 於是同一個帳號重跑兩次，模型看到的是**兩份不同的資料**。
    // 2026-09-22 端到端實測連跑兩次，商品清單完全不同；加了排序之後兩次一模一樣。
    // 用 `__name__` 排序不需要複合索引（自動的單欄位索引就夠）。
    // ⚠️ 只保證**送進模型的東西**一樣；`temperature: 0` 之下用字仍可能微幅不同
    //    （實測「家電與電子產品電商」vs「家電選物店」），那是模型端的性質，這裡管不到。
    const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .orderBy(FieldPath.documentId())
      .limit(INFER_LIMITS.chunks)
      .get()
    for (const d of snap.docs) {
      const data = d.data() as { title?: string, questions?: string[], isDeleted?: boolean }
      if (data.isDeleted) continue
      const t = String(data.title ?? '').trim()
      if (t) out.chunkTitles.push(t.slice(0, 80))
      for (const q of (data.questions ?? []).slice(0, 2)) {
        const s = String(q ?? '').trim()
        if (s) out.questions.push(s.slice(0, 60))
      }
    }
    if (snap.size >= INFER_LIMITS.chunks) out.truncated.push('知識卡')
  }
  catch { out.truncated.push('知識卡（這次查不到）') }

  try {
    const snap = await db.collection('tags')
      .where('workspaceId', '==', workspaceId)
      .orderBy(FieldPath.documentId())
      .limit(INFER_LIMITS.tags)
      .get()
    for (const d of snap.docs) {
      const n = String((d.data() as { name?: string }).name ?? '').trim()
      if (n) out.tagNames.push(n.slice(0, 40))
    }
    if (snap.size >= INFER_LIMITS.tags) out.truncated.push('標籤')
  }
  catch { out.truncated.push('標籤（這次查不到）') }

  try {
    const snap = await db.collection('leadCampaigns')
      .where('workspaceId', '==', workspaceId)
      .orderBy(FieldPath.documentId())
      .limit(INFER_LIMITS.campaigns)
      .get()
    for (const d of snap.docs) {
      const n = String((d.data() as { name?: string }).name ?? '').trim()
      if (n) out.campaignNames.push(n.slice(0, 40))
    }
    if (snap.size >= INFER_LIMITS.campaigns) out.truncated.push('活動')
  }
  catch { out.truncated.push('活動（這次查不到）') }

  // 常見問法去重（同一支商品好幾張卡會生出很像的問法）
  out.questions = [...new Set(out.questions)].slice(0, 30)
  return out
}

export function buildInferPrompt(s: InferSources): string {
  const fields = aiGuessableFields()
  const schema = fields.map(f => `  "${f.id}": "${f.aiHint}"`).join(',\n')

  const blocks: string[] = []
  blocks.push(`官方帳號名稱：${s.workspaceName || '（沒有）'}`)
  if (s.chunkTitles.length) blocks.push(`知識庫裡的資料標題（${s.chunkTitles.length} 筆）：\n${s.chunkTitles.join('\n')}`)
  if (s.questions.length) blocks.push(`客人常問的問題（${s.questions.length} 筆）：\n${s.questions.join('\n')}`)
  if (s.tagNames.length) blocks.push(`他們建過的標籤：${s.tagNames.join('、')}`)
  if (s.campaignNames.length) blocks.push(`他們辦過的活動：${s.campaignNames.join('、')}`)

  return [
    '你是一位資深行銷企劃。下面是一家店在客服系統裡累積的資料，請從中整理出「這家店是誰」。',
    '',
    '規則（違反任何一條這次就算失敗）：',
    '1. 只根據下面的資料回答。**看不出來的就回空字串**，不要用產業常識補。',
    '2. 不要編造價格、品牌名稱或競爭對手。價格只能寫資料裡真的出現的數字。',
    '3. 「客人最常問的事」請從上面那份問題清單歸納成三件事，用頓號分開。',
    '4. 每一格都用**繁體中文**，一句話以內，不要條列符號。',
    '5. 回傳純 JSON，不要加說明文字。',
    '',
    '要填的欄位（值的意思寫在後面）：',
    '{',
    schema,
    '}',
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

export interface InferOutcome {
  guesses: Partial<Record<StoreProfileFieldId, string>>
  sources: InferSources
  inputTokens: number
  outputTokens: number
}

export async function inferProfileFromExisting(
  workspaceId: string,
  workspaceName: string,
  db: Firestore = getDb(),
): Promise<InferOutcome> {
  const sources = await collectInferSources(workspaceId, workspaceName, db)
  if (!hasEnoughToInfer(sources)) {
    return { guesses: {}, sources, inputTokens: 0, outputTokens: 0 }
  }

  const { data, inputTokens, outputTokens } = await generateJson<Record<string, unknown>>(buildInferPrompt(sources), {
    // 抽事實不需要創意；溫度 0 讓同一批資料每次讀出來一樣
    temperature: 0,
    maxOutputTokens: 1200,
    thinkingBudget: 0,
  })

  const allowed = new Set(aiGuessableFields().map(f => f.id))
  const guesses: Partial<Record<StoreProfileFieldId, string>> = {}
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!allowed.has(k as StoreProfileFieldId)) continue
    const str = String(v ?? '').trim()
    if (!str || str === '無' || str === '沒有' || str === 'N/A' || str === 'null') continue
    guesses[k as StoreProfileFieldId] = str
  }
  return { guesses, sources, inputTokens, outputTokens }
}

/** 講得出「我是看了哪些東西猜的」。⛔ 撞上限要講，不可以把「前 60 張」講成「全部」。 */
export function describeInferSources(s: InferSources): string {
  const parts: string[] = []
  if (s.chunkTitles.length) parts.push(`知識庫 ${s.chunkTitles.length} 筆`)
  if (s.questions.length) parts.push(`客人問過的 ${s.questions.length} 種問題`)
  if (s.tagNames.length) parts.push(`${s.tagNames.length} 顆標籤`)
  if (s.campaignNames.length) parts.push(`${s.campaignNames.length} 個活動`)
  if (!parts.length) return '你的帳號裡還沒有足夠的資料可以讓我猜'
  const base = `我看了${parts.join('、')}`
  return s.truncated.length ? `${base}（${s.truncated.join('、')}只看了前面一批，不是全部）` : base
}
