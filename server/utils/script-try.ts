/**
 * 自動回應頁右邊的「試試看」：這句話照正式回客人的規則會走哪一條（`D-138`）。
 *
 * 順序跟 handler 一樣：敏感情境 → 只丟訂單資料 → 問出貨時間（認得出商品）→ 關鍵字 → AI 判斷 → 交給 AI。
 * 編輯中還沒存的那條（可能關著）換進清單一起試：試的就是「改成這樣之後」會怎樣。
 * AI 判斷那一步真的會叫一次 flash-lite，記在「後台自用」、不扣店家的則數。
 *
 * ⛔ 掛在測試對話那支路由底下（`routeOnly`），不另開一支：多開 API 路由會讓不相干的 `$fetch`
 *    型別推導爆掉（TS2589，2026-10-21 這一輪實測又爆一次）。
 */
import { loadActiveScripts } from './ai-scripts'
import { normalizeScriptInput } from './ai-script-validation'
import { getAiSettings } from './ai-settings'
import { routeMessage } from './ai-answer'
import { recordAiUsage } from './ai-usage'
import { usageFromCalls, withAiCallMeter, type AiCallUsage } from './ai-usage-calls'
import { shipTimingGoesToAi } from './handler'
import { messageScripts, pickScriptByKeyword, routeCandidates } from './script-match'
import { detectSensitiveTopic } from '~~/shared/types/ai-knowledge'
import { isOrderInfoOnly } from '~~/shared/order-info-only'
import type { ScriptDoc, ScriptTryResult } from '~~/shared/types/ai-script'

type ScriptRow = ScriptDoc & { id: string }

export async function tryScriptRoute(workspaceId: string, rawText: unknown, rawDraft: unknown): Promise<ScriptTryResult> {
  const text = String(rawText ?? '').trim().slice(0, 500)
  const settings = await getAiSettings(workspaceId).catch(() => null)
  const aiReplies = settings?.enabled === true && settings.replyMode === 'auto'

  const topic = settings ? detectSensitiveTopic(text, settings.sensitiveTopics ?? []) : null
  if (topic) return { kind: 'sensitive', topic }
  if (aiReplies && isOrderInfoOnly(text)) return { kind: 'orderInfoAsk' }

  const draftBody = rawDraft && typeof rawDraft === 'object' ? rawDraft as { id?: unknown } : null
  const draftId = String(draftBody?.id ?? '').trim() || '__draft__'
  const draft = draftBody ? normalizeScriptInput(draftBody) : null
  const stored: ScriptRow[] = (await loadActiveScripts(workspaceId).catch(() => [])).filter(s => s.id !== draftId)
  const scripts: ScriptRow[] = messageScripts([
    ...stored,
    // 關著的也當開著試（畫面會講「開啟之後」），不然停用中的那條永遠試不出結果
    ...(draft ? [{ ...draft, enabled: true, id: draftId, workspaceId } as unknown as ScriptRow] : []),
  ]).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  if (!scripts.length) return { kind: 'ai', reason: 'none', aiReplies }

  if (await shipTimingGoesToAi(text, workspaceId, async () => []).catch(() => false))
    return { kind: 'ai', reason: 'ship', aiReplies }

  const isDraft = (id: string) => Boolean(draft) && id === draftId
  const byKeyword = pickScriptByKeyword(scripts, text)
  if (byKeyword) {
    const { script, keyword } = byKeyword
    return { kind: 'script', scriptId: script.id, name: script.name, via: 'keyword', keyword, isDraft: isDraft(script.id) }
  }

  const candidates = routeCandidates(scripts)
  if (candidates.length) {
    const calls: AiCallUsage[] = []
    const route = await withAiCallMeter(calls, () => routeMessage(text, candidates)).catch(() => null)
    if (calls.length) void recordAiUsage(workspaceId, usageFromCalls('test', calls))
    const hit = route?.scriptId ? scripts.find(s => s.id === route.scriptId) : null
    if (hit) return { kind: 'script', scriptId: hit.id, name: hit.name, via: 'meaning', keyword: '', isDraft: isDraft(hit.id) }
  }
  return { kind: 'ai', reason: 'none', aiReplies }
}
