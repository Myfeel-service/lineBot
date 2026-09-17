import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { runAdminAgentChat, type AdminAgentTurn } from '~~/server/utils/ai-admin-agent'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { runWithLlmBudget } from '~~/server/utils/gemini'
import { hitAgentRateLimit } from '~~/server/utils/agent-rate-limit'
import { verifyAdminOpToken } from '~~/server/utils/admin-op-token'
import { getDb } from '~~/server/utils/firebase'
import { FieldValue } from 'firebase-admin/firestore'

/**
 * Admin 查詢副駕(P1,唯讀)。viewer 以上都能問——它只查登入者本來就看得到的資料。
 * 鐵律落點:workspaceId/權限來自 session、每次互動寫審計紀錄、token 記入用量。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid, role } = await requireWorkspaceAccess(event, 'viewer')
  const body = await readBody(event)

  const history: AdminAgentTurn[] = Array.isArray(body?.history)
    ? body.history
        .filter((t: any) => (t?.role === 'user' || t?.role === 'assistant') && typeof t?.text === 'string')
        .slice(-6)
    : []

  // 節流：一句話會打 1~5 次模型,按住送出鍵連發就是連續燒錢。
  // 擋的是手滑型浪費,真正的上限是下面的額度境域(跨實例、看真實用量)。
  const { limited, retryAfterMs } = hitAgentRateLimit(`${workspaceId}:${uid}`)
  if (limited) {
    throw createError({
      statusCode: 429,
      statusMessage: `問得有點快，休息 ${Math.ceil(retryAfterMs / 1000)} 秒再問一次。`,
    })
  }

  // 上一個提議:只採信**驗得過簽章**的憑證(前端原樣送回來的那一串)。
  // ⛔ 不接受前端自己描述「我上次提議了什麼」——那等於開一個可以偽造上下文的後門。
  const lastChecked = body?.lastToken ? verifyAdminOpToken(String(body.lastToken), { workspaceId, uid }) : null
  // ⛔ 接續要餵**原話**那一份:收斂後的參數餵不回去(勿擾時段少了「哪一種時間」那一格),
  //    模型照著重提就缺欄位,結果是它回頭再問一次使用者同樣的問題。
  const lastProposal = lastChecked?.ok
    ? { opId: lastChecked.payload.op, args: lastChecked.payload.r ?? lastChecked.payload.a }
    : undefined

  const db = getDb()
  // 包進額度境域:這支端點原本**完全沒有**費用閘門——gemini.ts 的守門是「境域內才查」,
  // 沒包等於不查,月用量爆掉時知識庫那些維運工作會被擋、小幫手卻照跑。
  const res = await runWithLlmBudget(workspaceId, () => runAdminAgentChat({
    db,
    workspaceId,
    role, // 每個工具執行前比對自己的 requires 門檻(端點這道 viewer 只是最低消)
    uid, // 提議的確認憑證綁死給誰:別人拿到那串也執行不了
    lastProposal, // 「第二題改成問電話」這種接續要求要接得住
    message: String(body?.message ?? ''),
    history,
    // 轉發呼叫者憑證:get_current_alerts / get_setup_status 打自家 API 時沿用同一套權限
    authHeader: getHeader(event, 'authorization'),
  }))

  // 內部管理用量照記,但要記進**後台自用**那桶(test*)而不是真客人那桶:
  // 小幫手是我們自己在後台用的,把它算進「回答客人」會讓每則客人成本虛高,
  // 拿那個數字去推單位經濟就會被誤導(2026-08-10 稽核發現)。
  // 次數也一起記:成本進了哪一桶,對應的次數就要進同一桶,否則「每次多少錢」又會算錯。
  recordAiUsage(workspaceId, {
    testInputTokens: res.inputTokens,
    testOutputTokens: res.outputTokens,
    testInvocations: 1,
    // 提議了幾次(還沒做)。跟 confirm 端點記的「真的執行幾次」成對,
    // 兩者相減就看得出「它提了但沒人按確定」——那是它在亂提議的唯一訊號。
    // ⛔ **修改同一個提議不算新提議**:使用者說「改成早上九點」時模型會重提一次,
    //    照算的話調兩次再確認就變成「提議 3 次、確定 1 次」,那個數字會被正常使用灌爆。
    ...(res.pendingOp && res.pendingOp.opId !== lastProposal?.opId ? { agentProposed: 1 } : {}),
  }).catch(e => console.error('[admin-agent] recordAiUsage error:', e))

  // 審計:誰、問了什麼、查了哪些工具、答了什麼(fire-and-forget,失敗不影響回答)
  db.collection('adminAgentLogs').add({
    workspaceId,
    uid,
    message: String(body?.message ?? '').slice(0, 1000),
    toolCalls: res.toolCalls,
    reply: res.reply.slice(0, 2000),
    // 提議了什麼(還沒執行)。真的做了會另外進 auditLogs,兩者分開才看得出「提了幾次、成了幾次」
    ...(res.pendingOp ? { proposedOp: res.pendingOp.opId } : {}),
    createdAt: FieldValue.serverTimestamp(),
  }).catch(e => console.error('[admin-agent] audit log error:', e))

  // messages＝結構化卡片（站內帶路連結，白名單生成）；前端用 AgentMessageRenderer 渲染
  // pendingOp＝待確認的操作（⛔此刻還沒有任何東西被改）
  return {
    reply: res.reply,
    toolCalls: res.toolCalls.map(t => t.tool),
    messages: res.messages,
    ...(res.pendingOp ? { pendingOp: res.pendingOp } : {}),
    // 使用者收回了上一個提議 → 畫面要把那張還留在上面、還按得下去的卡標成已取消
    ...(res.cancelPrevious ? { cancelPrevious: true } : {}),
  }
})
