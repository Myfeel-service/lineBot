/**
 * 準度考卷（`C-297`，`D-120` 第 2 步）：拿真實客人問過的題目，問現在的 AI，量出
 * 「答對／答錯／該答沒答／該轉沒轉」四個數字。之後改回答方式（`C-298` 原文模式）時同一份再考一次，**贏了才切換**。
 *
 * 跑法、題目怎麼來、怎麼改答案要點：見同一層的 README.md。
 *
 * ⚠️ 會真的打 AI（Gemini，一題約 4～6 次呼叫，整份 60 題台幣幾塊錢），讀 MYFEEL 正式庫的知識卡。
 * ⛔ **正式庫零寫入**，兩道保險：
 *    ① 用量記帳（recordAiUsage，後台測試對話會記「測試花了多少」）換成什麼都不做；
 *    ② Firestore 所有寫入方法（set／update／delete／add／batch／transaction）在這個程序裡直接丟錯——
 *       之後回答流程哪天多了一個寫入，考卷會當場失敗，而不是悄悄寫進正式庫。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, vi } from 'vitest'
import { BulkWriter, CollectionReference, DocumentReference, Firestore, WriteBatch } from 'firebase-admin/firestore'

vi.mock('~~/server/utils/ai-usage', async (orig) => ({
  ...(await orig<typeof import('~~/server/utils/ai-usage')>()),
  recordAiUsage: async () => {},
}))

const GUARD = '考卷是唯讀的'
const deny = (what: string) => Object.assign(function () { throw new Error(`${GUARD}：擋下一次 Firestore ${what}`) }, { examDeny: true })
// ⚠️ 「全部擋」要真的全部（2026-10-13 `/code-review`：BulkWriter 以前只擋了 create，set／update／delete 跟整棵刪都會直接寫進正式庫）
const WRITE_METHODS = ['set', 'update', 'delete', 'create'] as const
for (const m of WRITE_METHODS) (DocumentReference.prototype as any)[m] = deny(`doc.${m}`)
;(CollectionReference.prototype as any).add = deny('collection.add')
for (const m of [...WRITE_METHODS, 'commit'] as const) (WriteBatch.prototype as any)[m] = deny(`batch.${m}`)
for (const m of WRITE_METHODS) (BulkWriter.prototype as any)[m] = deny(`bulkWriter.${m}`)
;(Firestore.prototype as any).runTransaction = deny('runTransaction')
;(Firestore.prototype as any).recursiveDelete = deny('recursiveDelete')

/**
 * 被擋下的寫入。伺服器很多寫入是「失敗只記一行、不擋主流程」（用量記帳就是），錯誤會被吃掉——
 * 從 console 撈回來，結果裡講「擋下了幾次」，⛔ 不能讓「擋下了」跟「根本沒寫」看起來一樣。
 */
const blockedWrites: string[] = []
for (const level of ['error', 'warn'] as const) {
  const orig = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    const text = args.map(a => String((a as Error)?.message ?? a)).join(' ')
    if (text.includes(GUARD)) blockedWrites.push(text.slice(0, 200))
    orig(...args)
  }
}

// Nuxt 自動匯入的兩個全域（伺服器程式直接呼叫，不是 import 進來的）
const runtimeConfig = {
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? '',
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
  firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY ?? '',
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? '',
  public: {},
}
;(globalThis as any).useRuntimeConfig = () => runtimeConfig
;(globalThis as any).createError = (o: { statusCode?: number, statusMessage?: string, message?: string }) =>
  Object.assign(new Error(o.statusMessage ?? o.message ?? 'error'), o)

const HERE = dirname(fileURLToPath(import.meta.url))

/** 這題該怎麼處理才算對 */
type Expect =
  | 'answer' // 知識庫有答案，要答出來
  | 'handoff' // 要查這一位客人自己的訂單／帳號、或要人處理（瑕疵、退款、合作）——AI 該轉真人
  | 'clarify' // 問的是哪一台講不清楚、而且答案因產品而異：先問清楚是對的；把每一台都答對也算對
  | 'either' // 答（照要點）或轉真人都可以

interface ExamQuestion {
  id: string
  category: 'handoff' | 'price' | 'compare' | 'multi' | 'product' | 'policy'
  q: string
  expect: Expect
  /**
   * 出題當時知識庫裡有沒有這題的答案。分開算才分得出「AI 沒用好」跟「知識庫本來就沒有」：
   * 沒有的題目，對的做法是老實說不知道或轉真人；這種題答錯＝AI 自己編。
   */
  kb: boolean
  /** 回答要講到的事實（照當時的知識卡與真人客服的回覆寫） */
  keyPoints?: string[]
  /** 出現就算錯（編造訂單狀態、講錯數字…） */
  mustNot?: string[]
  /** 出題時看到什麼、為什麼這樣定答案 */
  note?: string
}

interface ExamFile {
  version: number
  workspaceId: string
  /** 答案要點是照哪一天的知識庫寫的：知識庫改了、要點要跟著看一次 */
  keyPointsAsOf: string
  questions: ExamQuestion[]
}

type Bucket = '答對' | '答對一半' | '答錯' | '該答沒答' | '該轉沒轉'

interface Graded {
  id: string
  category: ExamQuestion['category']
  kb: boolean
  q: string
  expect: Expect
  decision: string
  handoffReason: string | null
  answer: string
  clarification: string
  sources: string[]
  judge: { verdict: 'correct' | 'partial' | 'wrong', reason: string } | null
  bucket: Bucket
  ms: number
  error?: string
}

const outcomeOf = (decision: string): 'answered' | 'clarify' | 'handoff' =>
  decision === 'answered' ? 'answered' : decision === 'disambiguate' ? 'clarify' : 'handoff'

function bucketOf(q: ExamQuestion, outcome: 'answered' | 'clarify' | 'handoff', verdict: 'correct' | 'partial' | 'wrong' | null): Bucket {
  const byVerdict = (): Bucket => (verdict === 'correct' ? '答對' : verdict === 'partial' ? '答對一半' : '答錯')
  switch (q.expect) {
    case 'answer':
      return outcome === 'answered' ? byVerdict() : '該答沒答'
    case 'handoff':
      // 要查他自己的訂單卻自己回了（或反問產品）＝該轉沒轉；轉真人才對
      return outcome === 'handoff' ? '答對' : '該轉沒轉'
    case 'clarify':
      if (outcome === 'clarify') return '答對'
      return outcome === 'answered' ? byVerdict() : '該答沒答'
    case 'either':
      if (outcome !== 'answered') return '答對'
      return byVerdict()
  }
}

async function judge(
  generateJson: typeof import('~~/server/utils/gemini').generateJson,
  q: ExamQuestion,
  answer: string,
): Promise<Graded['judge']> {
  const prompt = [
    '你是客服回答的評分員。只根據下面的「標準答案要點」判斷，不要用你自己的知識補充或推翻要點。',
    `客人問：${q.q}`,
    `AI 回答：${answer}`,
    '標準答案要點（回答要講到的事實）：',
    ...(q.keyPoints?.length ? q.keyPoints.map(k => `- ${k}`) : ['- （沒有指定要點：只看有沒有出現下面不可以的內容、有沒有答非所問）']),
    ...(q.mustNot?.length ? ['不可以出現：', ...q.mustNot.map(k => `- ${k}`)] : []),
    '評分規則：',
    '- 要點全部講到、沒有出現不可以的內容 → correct',
    '- 講到一部分要點、其餘沒講到但沒有講錯 → partial',
    '- 有跟要點矛盾的內容、出現不可以的內容、或完全答非所問 → wrong',
    '- 回答說「沒有這項資訊」「不確定」「請洽客服」不算跟要點矛盾，算「沒講到」',
    '- 沒有指定要點的題目：沒有編造、沒有出現不可以的內容 → correct；有一部分沒回答到但沒講錯 → partial；有編造或出現不可以的內容 → wrong',
    '- 數字（價格、尺寸、天數、年數）要一致；寫法不同（12,900／一萬兩千九百）算一致',
    '- 多講了要點以外的內容不扣分，除非跟要點矛盾、或是知識以外的編造',
    '只回 JSON：{"verdict":"correct|partial|wrong","reason":"30 字以內"}',
  ].join('\n')
  // 第一次考時評分員的 JSON 被截斷過一次（理由寫太長）：理由限字數、再失敗重試一次
  let data: { verdict?: string, reason?: string } | null = null
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    data = (await generateJson<{ verdict: string, reason: string }>(prompt, { temperature: 0, maxOutputTokens: 2048 }).catch(() => null))?.data ?? null
  }
  if (!data) throw new Error('評分員兩次都沒有回完整的 JSON')
  const v = data.verdict === 'correct' || data.verdict === 'partial' || data.verdict === 'wrong' ? data.verdict : 'wrong'
  return { verdict: v, reason: String(data.reason ?? '').slice(0, 200) }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++
      out[k] = await fn(items[k]!)
    }
  }))
  return out
}

describe('準度考卷', () => {
  it('考一次', async () => {
    const mode = process.env.EXAM_MODE ?? 'run'
    const out = process.env.EXAM_OUT
    if (!out) throw new Error('要給 EXAM_OUT（結果寫到哪裡；含客人原話與 AI 回答，放 repo 外面）')
    mkdirSync(dirname(out), { recursive: true })
    const exam = JSON.parse(readFileSync(process.env.EXAM_FILE ?? join(HERE, 'questions.json'), 'utf8')) as ExamFile
    const only = (process.env.EXAM_ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean)

    const { getDb } = await import('~~/server/utils/firebase')
    const { embedQuery, generateJson } = await import('~~/server/utils/gemini')

    // 保險真的裝在回答流程用的那一個資料庫上（⛔ 不靠寫一筆試試看——裝錯的話那一筆就真的寫進正式庫了）：
    // 套件被載入兩份時，上面改的是另一份的類別，這裡會抓到
    const realDb = getDb() as any
    const probe = realDb.collection('__exam_guard__').doc('probe')
    const guarded = [
      ...WRITE_METHODS.map(m => probe[m]),
      realDb.collection('__exam_guard__').add,
      realDb.batch().commit,
      realDb.runTransaction,
      realDb.recursiveDelete,
      // ⚠️ bulkWriter() 會開一個真的寫入排程器，只看類別上的方法、不建實體
      ...WRITE_METHODS.map(m => (BulkWriter.prototype as any)[m]),
    ]
    if (!guarded.every(fn => fn?.examDeny === true)) {
      throw new Error('唯讀保險沒有裝在回答流程用的資料庫上，停下來不考')
    }

    // ── 出題輔助：每一題現在的知識庫裡最像的幾條（寫答案要點時對照用）──
    if (mode === 'evidence') {
      const { searchSimilarChunks } = await import('~~/server/utils/ai-knowledge-chunks')
      const queries: string[] = process.env.EXAM_QUERIES
        ? JSON.parse(readFileSync(process.env.EXAM_QUERIES, 'utf8'))
        : exam.questions.filter(q => !only.length || only.includes(q.id)).map(q => q.q)
      const rows = await pool(queries, 4, async (query) => {
        const hits = await searchSimilarChunks(getDb(), exam.workspaceId, await embedQuery(query), 6)
        return { query, hits: hits.map(h => ({ sim: Number(h.similarity.toFixed(3)), title: h.title, product: h.productName ?? '', content: h.content.slice(0, 500) })) }
      })
      writeFileSync(out, JSON.stringify(rows, null, 1))
      return
    }

    const { answerWithAi } = await import('~~/server/utils/ai-answer')
    const questions = exam.questions.filter(q => !only.length || only.includes(q.id))
    const graded = await pool(questions, Number(process.env.EXAM_CONCURRENCY ?? 3), async (q): Promise<Graded> => {
      const t0 = Date.now()
      try {
        let res = await answerWithAi({ workspaceId: exam.workspaceId, query: q.q, history: [], isTest: true })
        // AI 服務本身出錯（llm_error）時回答流程會轉真人——⛔ 不能算成「轉對了」：那是那一刻 AI 沒在運作，不是它判斷該轉。
        // 重試一次，還是錯就標成考卷出錯（2026-10-12 第一次考的 Q19 就是這樣被算成答對）
        if (res.handoffReason === 'llm_error') res = await answerWithAi({ workspaceId: exam.workspaceId, query: q.q, history: [], isTest: true })
        if (res.handoffReason === 'llm_error') throw new Error(`AI 服務出錯（llm_error）：${res.errorDetail ?? ''}`)
        const outcome = outcomeOf(res.decision)
        const verdict = outcome === 'answered' && q.expect !== 'handoff' ? await judge(generateJson, q, res.answer) : null
        const r: Graded = {
          id: q.id, category: q.category, kb: q.kb, q: q.q, expect: q.expect,
          decision: res.decision, handoffReason: res.handoffReason ?? null,
          answer: res.answer ?? '', clarification: (res as any).disambiguation?.clarification ?? '',
          sources: (res.sources ?? []).slice(0, 4).map(s => `${s.title}（${s.similarity.toFixed(2)}）`),
          judge: verdict, bucket: bucketOf(q, outcome, verdict?.verdict ?? null), ms: Date.now() - t0,
        }
        console.log(`${q.id} ${r.bucket}｜${r.decision}${r.handoffReason ? `/${r.handoffReason}` : ''}${verdict ? `｜${verdict.verdict}` : ''}`)
        return r
      }
      catch (e) {
        // 考卷自己出錯（網路、額度）不算 AI 答錯：標出來、整份照樣考完，最後分開講
        const msg = String((e as Error)?.message ?? e).slice(0, 300)
        console.log(`${q.id} 出錯：${msg}`)
        return { id: q.id, category: q.category, kb: q.kb, q: q.q, expect: q.expect, decision: 'error', handoffReason: null, answer: '', clarification: '', sources: [], judge: null, bucket: '答錯', ms: Date.now() - t0, error: msg }
      }
    })

    const ok = graded.filter(g => !g.error)
    const count = (b: Bucket, list = ok) => list.filter(g => g.bucket === b).length
    const buckets: Bucket[] = ['答對', '答對一半', '答錯', '該答沒答', '該轉沒轉']
    const summary = {
      when: new Date().toISOString(),
      exam: { version: exam.version, keyPointsAsOf: exam.keyPointsAsOf, questions: questions.length },
      errors: graded.filter(g => g.error).map(g => g.id),
      // 應該是 0：用量記帳已經換成什麼都不做；不是 0＝回答流程多了一個寫入，要看是什麼
      blockedWrites,
      total: Object.fromEntries(buckets.map(b => [b, count(b)])),
      // 知識庫有答案的題 vs 沒有的題：後者答錯＝AI 自己編，前者該答沒答＝AI 沒用好現成的卡
      kbHasAnswer: Object.fromEntries(buckets.map(b => [b, count(b, ok.filter(g => g.kb))])),
      kbHasNoAnswer: Object.fromEntries(buckets.map(b => [b, count(b, ok.filter(g => !g.kb))])),
      byCategory: Object.fromEntries([...new Set(ok.map(g => g.category))].map(c => [c, Object.fromEntries(buckets.map(b => [b, count(b, ok.filter(g => g.category === c))]))])),
      needsLook: ok.filter(g => g.bucket !== '答對').map(g => `${g.id} ${g.bucket}`),
    }
    writeFileSync(out, JSON.stringify({ summary, graded }, null, 1))
    console.log(`\n${JSON.stringify(summary, null, 1)}`)
  })
})
