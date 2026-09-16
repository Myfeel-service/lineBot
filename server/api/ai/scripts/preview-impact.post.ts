import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { SCRIPTS_COLLECTION } from '~~/server/utils/ai-scripts'
import { getAiSettings } from '~~/server/utils/ai-settings'
import {
  previewScriptToggleImpact,
  toReachabilityScriptsWithDisabled,
} from '~~/shared/types/ai-script-reachability'

/**
 * POST /api/ai/scripts/preview-impact —— 上下架之前，先算「按下去之後誰會變得輪不到、誰會活過來」。
 *
 * 為什麼：上下架至今**沒有任何確認**，開關一撥、存檔就對外生效；而它的影響往往不在這條流程
 * 身上，在**別條**身上（新開的這條可能把另一條的觸發詞整個包住）。這種蓋台客人不會回報——
 * 他們收到的是「別的回覆」不是「沒回覆」。
 *
 * ⛔ 判定不在這裡重寫：拿異常中心同一支分析器跑「改之前／改之後」再比對。
 * 流程編輯器與小幫手的確認卡吃同一份，兩邊講的影響一字不差。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'scripts.write')
  const body = await readBody(event)

  const scriptId = String(body?.scriptId ?? '').trim()
  if (!scriptId) throw createError({ statusCode: 400, statusMessage: '缺少要預覽的流程' })
  if (typeof body?.enabled !== 'boolean')
    throw createError({ statusCode: 400, statusMessage: '要指定是上架還是下架' })

  const db = getDb()
  const [snap, settings] = await Promise.all([
    db.collection(SCRIPTS_COLLECTION).where('workspaceId', '==', workspaceId).get(),
    getAiSettings(workspaceId, db).catch(() => null),
  ])
  const docs = snap.docs.map(d => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))

  // 這條流程要屬於這個工作區（查詢已經 where 過，這裡是「找不到就明說」）
  if (!docs.some(d => d.id === scriptId))
    throw createError({ statusCode: 404, statusMessage: '找不到這條流程' })

  const impact = previewScriptToggleImpact(
    toReachabilityScriptsWithDisabled(docs),
    { id: scriptId, enabled: body.enabled },
    { sensitiveTopics: settings?.sensitiveTopics ?? [] },
  )

  return {
    ...impact,
    /** 有沒有話要說：沒有影響時畫面就不必跳確認（⛔不要為了跳而跳，那會訓練人閉眼按確定） */
    hasImpact: !!impact.selfStillBlocked || impact.newlyBlocked.length > 0 || impact.newlyFreed.length > 0,
  }
})
