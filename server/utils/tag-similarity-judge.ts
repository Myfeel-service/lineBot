/**
 * 標籤名「像不像」——兩層漏斗的**第二層**（LLM 判官）。
 *
 * 第一層（`shared/tag-similarity.ts`）只比字面，會挑出「在看錄音麥克風」同時撞到
 * 「在看收音麥克風」與「在看 AI 錄音耳機」——後者是耳機不是麥克風，字面層分不出來。
 * 這一層負責回答真正的問題：**這兩顆標籤會不會貼到同一群客人身上？**
 *
 * 沿用知識庫「重複卡片偵測」判官（`ai-duplicate-scan`）的形狀，包含那條最重要的規矩：
 * ⛔ **只有 `same` 才出聲，`different` 與 `unsure` 都不出聲——寧可漏、不可誤。**
 * 理由是誤報的代價不對稱：漏報只是少一次提醒（人本來就會自己看到名字），
 * 誤報是每週跳出來煩人，而一直誤報的提醒，人第三次就整片跳過了（同 `C-68` 的教訓）。
 *
 * 成本：一次掃描最多 3 條提案 × 3 個候選＝9 組，一次 LLM 呼叫、一週一次，可忽略。
 * ⛔ 沒有候選就**不呼叫**（別為了零組配對去燒一次額度）。
 */
import { generateJson, runWithLlmBudget } from './gemini'

/** 一次最多送幾組給判官（防提案數暴增時把 prompt 撐爆） */
export const MAX_JUDGE_PAIRS = 12
/** 判斷條件塞進 prompt 的長度上限（兩顆標籤各一段，太長只是噪音） */
export const JUDGE_CRITERIA_MAX = 120

export type NameVerdict = 'same' | 'different' | 'unsure'

export interface JudgeNamePair {
  /** 新的那個名字（AI 提的新標籤，或人正要建的） */
  candidate: string
  candidateCriteria?: string
  /** 既有標籤 */
  existing: string
  existingCriteria?: string
}

export interface JudgedPair {
  verdict: NameVerdict
  /** 白話一句，給店家看（⛔ 不是術語：這句會直接印在提案卡上） */
  reason: string
}

const SYSTEM_RULES = `你在幫商家整理 LINE 官方帳號的「顧客標籤」。使用者會給你幾組標籤名（每組兩個：一個是新的、一個是店家已經有的），每個名字可能附帶「AI 判斷條件」。

任務：逐組判斷這兩顆標籤**會不會貼到同一群客人身上**。

規則（嚴格遵守）：
1. verdict 只能是 "same" / "different" / "unsure"。
2. same＝同一個產品品類或同一件事，只是換個說法（例：「在看收音麥克風」與「在看無線麥克風」都是在看麥克風的客人）。
3. ⛔ **名字有共用的字不代表 same**：不同產品品類一律 "different"（例：「在看錄音麥克風」與「在看錄音耳機」是兩種產品，只是都能錄音）。
4. ⛔ 一個是「在看／想買」、另一個是「買了之後的問題」（維修、退貨、發票）→ 一律 "different"，那是兩群不同狀態的客人。
5. 沒有足夠把握就回 "unsure"，不要猜。寧可漏、不可誤。
6. reason 用一句白話說明，給店家看的，不要術語，20 字內。例：「兩顆都是在看麥克風的客人，只是收音方式的說法不同」。

輸出格式（嚴格 JSON）：{ "results": [ { "index": 0, "verdict": "same", "reason": "string" } ] }`

interface RawVerdictRow {
  index?: unknown
  verdict?: unknown
  reason?: unknown
}

function clip(raw: string | undefined, max: number): string {
  return String(raw ?? '').trim().slice(0, max)
}

export function buildJudgePrompt(pairs: JudgeNamePair[]): string {
  const blocks = pairs.map((p, i) => {
    const lines = [`【第 ${i} 組】`, `新的：${p.candidate}`]
    const cc = clip(p.candidateCriteria, JUDGE_CRITERIA_MAX)
    if (cc) lines.push(`　判斷條件：${cc}`)
    lines.push(`已經有的：${p.existing}`)
    const ec = clip(p.existingCriteria, JUDGE_CRITERIA_MAX)
    if (ec) lines.push(`　判斷條件：${ec}`)
    return lines.join('\n')
  })
  return [SYSTEM_RULES, '', '要判斷的組別：', blocks.join('\n\n')].join('\n')
}

/**
 * 把模型回來的東西清成「每一組一個判決」。
 *
 * ⛔ **回傳長度一定等於 `pairs.length`**：模型少回幾組、或 index 亂給，都不可以讓結果
 * 錯位——那會把 A 組的判決套到 B 組身上（畫面指著一顆無關的標籤說「這是同一件事」）。
 * 沒回到的一律當 `unsure`（＝不出聲），這是這支唯一安全的預設值。
 */
export function parseJudgeVerdicts(raw: unknown, count: number): JudgedPair[] {
  const rows = Array.isArray((raw as { results?: unknown })?.results)
    ? (raw as { results: RawVerdictRow[] }).results
    : []
  const out: JudgedPair[] = Array.from({ length: count }, () => ({ verdict: 'unsure' as NameVerdict, reason: '' }))
  for (const row of rows) {
    const idx = Number(row?.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue
    const v = String(row?.verdict ?? '').trim().toLowerCase()
    // ⛔ 白名單外一律 unsure：模型偶爾會發明 "maybe"、"likely"，當成 same 就是誤報
    const verdict: NameVerdict = v === 'same' ? 'same' : v === 'different' ? 'different' : 'unsure'
    out[idx] = { verdict, reason: String(row?.reason ?? '').trim().slice(0, 60) }
  }
  return out
}

/**
 * 問判官：這幾組標籤名是不是同一件事。
 *
 * 回 `null`＝**這輪沒judge成**（額度用完、模型出錯、JSON 壞掉）。
 * ⛔ 不可以退化成「全部 different」：那是一句假的否定——我們根本沒問到，
 * 而呼叫端要靠這個 null 把「查過沒有」跟「沒查過」分開存
 * （同 `feedback_filters_must_report_what_they_dropped` 的三態鐵律）。
 */
export async function judgeSimilarTagNames(
  workspaceId: string,
  pairs: JudgeNamePair[],
): Promise<{ verdicts: JudgedPair[]; inputTokens: number; outputTokens: number } | null> {
  if (!pairs.length) return { verdicts: [], inputTokens: 0, outputTokens: 0 }
  const batch = pairs.slice(0, MAX_JUDGE_PAIRS)

  try {
    const { data, inputTokens, outputTokens } = await runWithLlmBudget(workspaceId, () =>
      generateJson<{ results?: RawVerdictRow[] }>(buildJudgePrompt(batch), {
        // 「兩個短名字是不是同一件事」是簡單任務（同挑選類），用便宜的那顆
        model: 'gemini-2.5-flash-lite',
        temperature: 0,
        maxOutputTokens: 1200,
        thinkingBudget: 0,
      }))
    const verdicts = parseJudgeVerdicts(data, batch.length)
    // 撞到上限被切掉的那幾組補成 unsure＝不出聲（長度必須對得起來，見 parseJudgeVerdicts）
    while (verdicts.length < pairs.length) verdicts.push({ verdict: 'unsure', reason: '' })
    return { verdicts, inputTokens, outputTokens }
  }
  catch (e) {
    console.warn('[tag-similarity] 判官失敗，這輪不出相似提醒：', workspaceId, e)
    return null
  }
}
