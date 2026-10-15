import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import {
  docToSourceSummary,
  getSource,
  KNOWLEDGE_SOURCES_COLLECTION,
  listChunksBySource,
  SOURCE_SUMMARY_MAX_LINES,
  updateSourceSettings,
} from '~~/server/utils/ai-knowledge-sources'
import { writeAuditLog, auditSnapshot, diffChangedFields } from '~~/server/utils/audit-log'
import { fillProductNameFromGroup } from '~~/server/utils/ai-knowledge-product-group'
import { generateJson, runWithLlmBudget } from '~~/server/utils/gemini'
import { recordAiUsage } from '~~/server/utils/ai-usage'

/**
 * PUT /api/ai/sources/:sourceId
 * Body: { refreshIntervalMinutes?, onChangeBehavior?, name?, productName?, url?, clearExcludedRows? }
 *   或  { generateSummary: true, force? }（`C-316`，見最下面）
 *
 * 只動使用者可配置欄位；hash / etag / lastFetchedAt 等系統欄位不在這支處理
 * （例外：改 url 會一併重設比對基準、clearExcludedRows 會清掉試算表的內容指紋，見 updateSourceSettings）。
 * productName 改動後前端要接著打 POST /api/ai/sources/:id/reindex 重建該來源索引才生效。
 *
 * `clearExcludedRows: true`（`D-125`②，只有 Google 試算表）：在後台刪掉、之後不再收的那幾列重新收回來，
 * 下一次同步（每小時，或按「立即同步」）加回知識庫。不是試算表＝400。
 *
 * `generateSummary: true`（`C-316`）：整理「這份在講什麼」——最多 3 行、每行 30 字內。
 *   · 已經有了就直接回存著的那份（不再花錢）；`force: true` 才重整理。
 *   · ⛔ 這是單獨一個動作：同一個請求帶的其他欄位不處理（畫面打開一份資料時自動打，不該順手改到設定）。
 *   · AI 失敗不回 500：回 `{ summary: [], summaryAt: 0, summaryFailed: true }`，畫面照樣顯示條目，不整頁報錯。
 *   · 回 `{ summary: string[], summaryAt: number(ms) }`；這份沒有上線中的條目＝`{ summary: [], summaryAt: 0 }`（不打 AI）。
 * 為什麼不新開一支端點：多開一支 API 路由會讓不相干的 $fetch 型別報 TS2589（型別太深），併進既有端點就好。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const before = await getSource(db, sourceId, workspaceId)
  const body = await readBody(event).catch(() => ({}))

  if (body?.generateSummary === true) {
    if (!before) throw createError({ statusCode: 404, statusMessage: '找不到這份資料（可能已被刪除），請重新整理後再試' })
    return await generateSourceSummary(db, workspaceId, sourceId, before.data, body?.force === true)
  }

  // 收回來幾列要在改之前數（改完名單就是空的了）
  const reAddedRows = body?.clearExcludedRows === true ? (before?.data.gsheetExcludedTitles?.length ?? 0) : 0
  const result = await updateSourceSettings(db, workspaceId, sourceId, {
    refreshIntervalMinutes: body?.refreshIntervalMinutes,
    onChangeBehavior: body?.onChangeBehavior,
    name: body?.name,
    folderId: body?.folderId === null ? null : (typeof body?.folderId === 'string' ? body.folderId : undefined),
    productName: typeof body?.productName === 'string' ? body.productName : undefined,
    urlAutoApply: typeof body?.urlAutoApply === 'boolean' ? body.urlAutoApply : undefined,
    url: typeof body?.url === 'string' ? body.url : undefined,
    clearExcludedRows: body?.clearExcludedRows === true,
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'source not found' })

  /*
   * 稽核（`C-254`）。⭐ 這裡最要緊的兩格：
   * `productName` 改了會換掉整份資料歸屬的商品（答錯台的老毛病），
   * `url` 改了會連比對基準一起重設（下一次同步會把卡片整批換掉）。
   */
  const keep = ['name', 'productName', 'url', 'folderId', 'refreshIntervalMinutes', 'onChangeBehavior'] as const
  const diff = diffChangedFields(
    auditSnapshot(before?.data as Record<string, unknown> | undefined, { keep })!,
    auditSnapshot(result as unknown as Record<string, unknown>, { keep })!,
  )
  // 重新收回來的列（`D-125`②）只寫在備註：那是一串標題，放進前後對照會被截斷、也看不懂
  if (diff.changedKeys.length || reAddedRows) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'source.put',
      targetId: sourceId,
      before: diff.before,
      after: diff.after,
      note: String(before?.data.name ?? '')
        + (reAddedRows ? `：在後台刪掉的 ${reAddedRows} 列重新收回來，下一次同步會加回知識庫` : ''),
    }, db)
  }

  /*
   * 搬進商品分組（`C-320`）：這份沒填產品名、同組其他資料只有一種產品名 → 補上並當場重新學習
   *（規則與操作紀錄都在 fillProductNameFromGroup）。⛔ 不拿分組名當產品名、不蓋掉已經填好的。
   * ⛔ 一定要 await：Lambda 回應之後背景工作會被截斷。補到時最多約 9 秒（一份最多約 150 條）。
   * 同組有兩種以上產品名＝不補，回 names 讓畫面可以問「這份是哪一個」。
   */
  const movedFolder = body?.folderId !== undefined && (before?.data.folderId ?? null) !== (result.folderId ?? null)
  if (movedFolder) {
    // ⛔ 補名失敗不可以讓整支回 500（/code-review 第 3 條）：分組已經換好、操作紀錄已經寫了，
    // 回 500 的話畫面以為搬移失敗——加入視窗還會把剛建好、資料已經搬進去的分組當成空的刪掉。搬移照算成功，帶一句沒補成
    try {
      const fill = await fillProductNameFromGroup(db, workspaceId, sourceId, { uid })
      if (fill.filled) {
        return { ...fill.source, groupFill: { productName: fill.productName, indexed: fill.relearned.indexed, failed: fill.relearned.failed } }
      }
      if (fill.reason === 'ambiguous' && fill.names?.length) return { ...result, groupFill: { names: fill.names } }
    }
    catch (e) {
      console.warn(`[sources] ${sourceId} group product-name fill failed:`, (e as Error)?.message)
      return { ...result, groupFill: { error: true } }
    }
  }

  return result
})

// ── 「這份在講什麼」（`C-316`）───────────────────────────────────────

/** 每行上限（畫面三行、窄欄也放得下） */
const SUMMARY_LINE_MAX = 30
/** 拿幾條去整理：說明書 79 條全送太貴，前面這些已經看得出這份在講什麼 */
const SUMMARY_ITEM_LIMIT = 60
/** 每一條取標題＋內容開頭幾個字 */
const SUMMARY_ITEM_HEAD = 40
/** 整份送出去的字數上限（flash-lite 很便宜，但一份資料的摘要不需要更多） */
const SUMMARY_PROMPT_MAX = 4000

const SUMMARY_SYSTEM_INSTRUCTION = `你在幫店家整理客服知識庫。下面是「一份資料」整理出來的知識條目（每行是一條的標題＋內容開頭）。
請寫最多 3 行，讓店家一眼看出這份資料涵蓋哪些內容。

規則：
1. 每行 30 字以內，講一類內容，例：「過濾網與後進氣面板怎麼保養、怎麼裝」「故障排除：無法除濕、燈號說明」。
2. 只寫條目裡有的，不要自己補、不要評論。
3. 不要用項目符號、編號、表情符號；不要用「這份資料」「本文件」開頭。
4. 內容很少時寫 1～2 行就好。

輸出格式（嚴格 JSON）：{ "lines": ["string"] }`

/**
 * 模型回的那幾行收乾淨：去項目符號／編號、去空行、最多 3 行、每行最多 30 字（超過的截在 29 字＋「…」，看得出被截過）。
 * 字數用 Array.from 算（emoji、罕用字是兩個 UTF-16 單位，用 .length 會截到半個字）。
 */
function cleanSummaryLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const line = String(item ?? '')
      .replace(/\s+/g, ' ')
      // 編號後面不能緊接數字（/code-review 第 10 條）：「2.4GHz 無線」「3.5 吋螢幕」的「2.」「3.」是內容不是編號，拿掉就把事實改錯了
      .replace(/^\s*(?:[-*•・·‧▪●○◆◇■□]|\d+[.)、．](?!\d)|[（(]\d+[)）])\s*/u, '')
      .trim()
    if (!line) continue
    const chars = Array.from(line)
    out.push(chars.length > SUMMARY_LINE_MAX ? `${chars.slice(0, SUMMARY_LINE_MAX - 1).join('')}…` : line)
    if (out.length >= SOURCE_SUMMARY_MAX_LINES) break
  }
  return out
}

async function generateSourceSummary(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  sourceId: string,
  data: Parameters<typeof docToSourceSummary>[1],
  force: boolean,
): Promise<{ summary: string[], summaryAt: number, summaryFailed?: true }> {
  const existing = docToSourceSummary(sourceId, data)
  if (existing.summary.length && !force) return { summary: existing.summary, summaryAt: existing.summaryAt }

  // 只拿上線中的條目（AI 真的會拿來回答的）：「等你看過」的、停用的、沒學起來的不算這份「在講」的東西
  const items = (await listChunksBySource(db, workspaceId, sourceId))
    .filter(c => c.status === 'indexed')
  if (!items.length) return { summary: [], summaryAt: 0 }

  const lines: string[] = []
  let size = 0
  for (const c of items.slice(0, SUMMARY_ITEM_LIMIT)) {
    const head = c.content.replace(/^重點：.*$/m, '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_ITEM_HEAD)
    const line = `- ${c.title.trim()}${head ? `：${head}` : ''}`
    if (size + line.length > SUMMARY_PROMPT_MAX) break
    lines.push(line)
    size += line.length + 1
  }
  const prompt = [`[資料名稱] ${String(data.name ?? '').trim() || '（無）'}`, '[條目]', ...lines].join('\n')

  let summary: string[] = []
  try {
    // 圈進維運額度（同匯入、AI 整理）：畫面打開一份資料就會自動打，萬一被連打也有上限擋著；超過＝429，下面當失敗
    const { data: out, inputTokens, outputTokens } = await runWithLlmBudget(workspaceId, () => generateJson<{ lines?: unknown }>(prompt, {
      systemInstruction: SUMMARY_SYSTEM_INSTRUCTION,
      // 小任務用最便宜的那個（同反問澄清、轉真人摘要）；關掉 thinking，不然 thinking 會吃掉輸出額度把 JSON 截斷
      model: 'gemini-2.5-flash-lite',
      temperature: 0.2,
      maxOutputTokens: 300,
      thinkingBudget: 0,
    }))
    // 記帳記在「匯入／整理」那一格（同 AI 整理一下 normalize）：這是整理知識花的錢，不是回客人
    await recordAiUsage(workspaceId, {
      inputTokens,
      outputTokens,
      importInputTokens: inputTokens,
      importOutputTokens: outputTokens,
    }).catch(() => {})
    summary = cleanSummaryLines(out?.lines)
  }
  catch (e) {
    console.warn(`[sources] ${sourceId} summary failed:`, (e as Error)?.message)
    return { summary: [], summaryAt: 0, summaryFailed: true }
  }
  if (!summary.length) return { summary: [], summaryAt: 0, summaryFailed: true }

  // ⛔ 不動 updatedAt：資料清單照 updatedAt 排，整理一份摘要不該讓它跳到最上面
  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
    summary,
    summaryAt: FieldValue.serverTimestamp(),
  }).catch((e) => {
    // 存不進去（整理途中這份被刪掉了）：這一次照樣給畫面看，下次打開會再整理一次；⛔ 不為這個回 500
    console.warn(`[sources] ${sourceId} summary save failed:`, (e as Error)?.message)
  })
  return { summary, summaryAt: Date.now() }
}
