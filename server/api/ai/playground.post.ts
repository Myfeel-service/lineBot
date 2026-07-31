import { requireCapability } from '~~/server/utils/workspace-auth'
import { answerWithAi, routeMessage, type AiChatTurn, type RouteResult } from '~~/server/utils/ai-answer'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { loadActiveScripts } from '~~/server/utils/ai-scripts'
import { matchesScriptKeywords, type ScriptDoc, type ScriptTriggerNode } from '~~/shared/types/ai-script'

/**
 * POST /api/ai/playground
 * Body: { query: string, history?: AiChatTurn[], skipDisambiguation?: boolean, isFollowup?: boolean }
 *
 * 跟 /answer 一樣，但帶 debug=true：會多回傳 debugPrompt 給管理員看到實際送給 LLM 的 prompt。
 * 並且**先模擬正式 LINE 的腳本觸發**：若這句會命中某條腳本，回報 scriptTrigger 且不跑 AI
 *   （正式對話中腳本優先於 AI 保底）。playground 不模擬腳本後續的多輪問答、也不含自動回覆規則。
 * history 讓 playground 跟正式 LINE 一樣支援多輪追問（追問補救檢索 + 脈絡帶入 prompt）。
 * skipDisambiguation / isFollowup 讓前端模擬「客人點按鈕後的下一輪」— 避免再次觸發反問澄清。
 * 不影響正式對話（不寫 conversation 紀錄；usage 仍會記，這部分跟正式呼叫共用）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'playground.use')
  const body = await readBody(event)
  const query = String(body?.query ?? '').trim()
  if (!query) throw createError({ statusCode: 400, statusMessage: '請輸入 query' })

  // history 來自前端、不可信：只收 role 合法、text 有內容的項目，並截最近 6 則
  const history: AiChatTurn[] = Array.isArray(body?.history)
    ? body.history
        .map((t: any) => ({
          role: t?.role === 'bot' ? 'bot' as const : 'user' as const,
          text: String(t?.text ?? '').trim(),
        }))
        .filter((t: AiChatTurn) => t.text)
        .slice(-6)
    : []

  // ── 先模擬腳本觸發（與正式 LINE 同一套：關鍵字快速通道 → 統一意圖路由）──
  // 只判「會不會觸發」，不真的啟動 / 持久化 activeScript。
  const scripts = await loadActiveScripts(workspaceId).catch(() => [])
  let triggered: (ScriptDoc & { id: string }) | null = scripts.find(s => matchesScriptKeywords(s, query)) ?? null
  let route: RouteResult | null = null
  if (!triggered && scripts.length) {
    const hints = scripts.map(s => ({ id: s.id, name: s.name, hints: triggerHintsOf(s) }))
    route = await routeMessage(query, hints, history).catch(() => null)
    if (route) {
      // 路由也是一次 LLM 呼叫、真的花了錢 → 記帳；但這是 playground 測試，導到 test* 欄位（不併真客人成本）
      recordAiUsage(workspaceId, { testInputTokens: route.inputTokens, testOutputTokens: route.outputTokens })
        .catch(() => {})
    }
    const routedScriptId = route?.scriptId ?? null
    if (routedScriptId) triggered = scripts.find(s => s.id === routedScriptId) ?? null
  }
  if (triggered) {
    const root = triggered.nodes.find(n => n.id === triggered!.rootNodeId) as ScriptTriggerNode | undefined
    return {
      decision: 'skipped' as const,
      answer: '',
      confidence: 0,
      sources: [],
      handoffReason: null,
      scriptTrigger: {
        name: triggered.name,
        mode: (root?.matchMode ?? 'keyword') as 'keyword' | 'semantic',
      },
    }
  }

  return answerWithAi({
    workspaceId,
    query,
    history,
    debug: true,
    // 測試呼叫：只記 token（真花了錢），不記次數/率、不消耗額度——用量監控頁的品質指標只反映真實客服。
    isTest: true,
    skipDisambiguation: body?.skipDisambiguation === true,
    isFollowup: body?.isFollowup === true,
    // 反問前的原始問題（前端模擬客人點按鈕時帶上，與正式 LINE handler 同行為）
    followupOf: typeof body?.followupOf === 'string' ? body.followupOf.trim().slice(0, 200) : undefined,
    // 意圖路由已分類過就重用（與正式流程一致，省一次 flash-lite）；token 上面已記，內部會歸零
    precomputedIntent: route ?? undefined,
  })
})

/** 腳本觸發情境提示（關鍵字 + 語意範例）給意圖路由參考 */
function triggerHintsOf(script: ScriptDoc & { id: string }): string[] {
  const root = script.nodes.find(n => n.id === script.rootNodeId)
  if (root?.type !== 'trigger') return []
  return [...new Set([...(root.keywords ?? []), ...(root.examples ?? [])].map(s => String(s).trim()).filter(Boolean))]
}
