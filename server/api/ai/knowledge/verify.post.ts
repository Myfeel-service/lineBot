import { requireCapability } from '~~/server/utils/workspace-auth'
import { answerWithAi } from '~~/server/utils/ai-answer'

/** 試答的時間上限：答題管線有自己的逾時，這裡是最後保險，超時回 null 不擋操作 */
const VERIFY_TIMEOUT_MS = 15_000

/**
 * POST /api/ai/knowledge/verify
 * Body: { query }
 *
 * 「這張卡存好之後，AI 現在答不答得出來？」——存檔後就地驗證用。
 *
 * 為什麼要有這支：以前建完卡只知道「存好了」，要確認 AI 真的會用得換頁去「測試對話」
 * 重打一次；而系統建議那條路（suggestions/accept）已經會自動試答並回報。同一件事
 * 兩種待遇，手動路徑白白多跨一頁。
 *
 * isTest：token 記到 test* 欄位、不計次數/率、不消耗額度，也不寫進轉真人事件流——
 * 驗證動作不該污染「真實客服表現」的統計。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'playground.use')
  const body = await readBody(event)
  const query = String(body?.query ?? '').trim()
  if (!query) throw createError({ statusCode: 400, statusMessage: '請提供要試問的句子' })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const out = await Promise.race([
      answerWithAi({ workspaceId, query, isTest: true, skipDisambiguation: true }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), VERIFY_TIMEOUT_MS) }),
    ])
    if (!out) return { timedOut: true, decision: '', confidence: 0, sources: [] as string[] }
    return {
      timedOut: false,
      decision: out.decision,
      confidence: Number(out.confidence ?? 0),
      // 只回標題:呼叫端要判斷的是「有沒有命中剛建的那張卡」
      sources: (out.sources ?? []).slice(0, 3).map(s => String(s.title ?? '')),
    }
  }
  finally {
    // 答題先回來時要清掉計時器，否則 Lambda 會為了掛著的 timer 多醒 15 秒
    if (timer) clearTimeout(timer)
  }
})
