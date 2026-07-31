import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { runAdminAgentChat, type AdminAgentTurn } from '~~/server/utils/ai-admin-agent'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { getDb } from '~~/server/utils/firebase'
import { FieldValue } from 'firebase-admin/firestore'

/**
 * Admin 查詢副駕(P1,唯讀)。viewer 以上都能問——它只查登入者本來就看得到的資料。
 * 鐵律落點:workspaceId/權限來自 session、每次互動寫審計紀錄、token 記入用量。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'viewer')
  const body = await readBody(event)

  const history: AdminAgentTurn[] = Array.isArray(body?.history)
    ? body.history
        .filter((t: any) => (t?.role === 'user' || t?.role === 'assistant') && typeof t?.text === 'string')
        .slice(-6)
    : []

  const db = getDb()
  const res = await runAdminAgentChat({ db, workspaceId, message: String(body?.message ?? ''), history })

  // 內部管理用量照記(與生成腳本同慣例)
  recordAiUsage(workspaceId, { inputTokens: res.inputTokens, outputTokens: res.outputTokens })
    .catch(e => console.error('[admin-agent] recordAiUsage error:', e))

  // 審計:誰、問了什麼、查了哪些工具、答了什麼(fire-and-forget,失敗不影響回答)
  db.collection('adminAgentLogs').add({
    workspaceId,
    uid,
    message: String(body?.message ?? '').slice(0, 1000),
    toolCalls: res.toolCalls,
    reply: res.reply.slice(0, 2000),
    createdAt: FieldValue.serverTimestamp(),
  }).catch(e => console.error('[admin-agent] audit log error:', e))

  return { reply: res.reply, toolCalls: res.toolCalls.map(t => t.tool) }
})
