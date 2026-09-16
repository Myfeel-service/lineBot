import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { can } from '~~/shared/permissions'
import { ADMIN_OP_LABELS } from '~~/shared/types/admin-ops'
import { AdminOpUserError, getAdminOp } from '~~/server/utils/admin-ops'
import { verifyAdminOpToken } from '~~/server/utils/admin-op-token'
import { hitAgentRateLimit } from '~~/server/utils/agent-rate-limit'
import { recordAiUsage } from '~~/server/utils/ai-usage'

/**
 * POST /api/admin/agent/confirm —— 小幫手代辦的**唯一執行入口**（`C-31` Phase 2）。
 *
 * 聊天那支端點只會產生「提議」；真的動到設定只發生在這裡，而且必須帶著提議時簽發的憑證。
 * 四道關卡缺一不可：
 *   ① 憑證驗得過（沒被改過、沒過期、是發給這個人這個工作區的）
 *   ② 呼叫者的角色真的有這個操作的權限（⛔不信憑證裡寫的，重新比對）
 *   ③ 現況指紋還一樣（提議之後有人動過同一個設定 → 不執行，請他重問一次）
 *   ④ 執行一次就結束：失敗不自動重試（重試寫入是明文禁止的）
 *
 * 執行成功會寫 `auditLogs`（`actor='agent'`）——那是「AI 動過手」唯一查得到的地方。
 */
export default defineEventHandler(async (event) => {
  // 端點這道只是最低消：真正的門檻是下面逐 op 比對 capability
  const { workspaceId, uid, role } = await requireWorkspaceAccess(event, 'viewer')

  const { limited, retryAfterMs } = hitAgentRateLimit(`${workspaceId}:${uid}:confirm`)
  if (limited) {
    throw createError({
      statusCode: 429,
      statusMessage: `動作有點快，休息 ${Math.ceil(retryAfterMs / 1000)} 秒再試。`,
    })
  }

  const body = await readBody(event)
  const checked = verifyAdminOpToken(String(body?.token ?? ''), { workspaceId, uid })
  if (!checked.ok) {
    // 四種拒絕的下一步不一樣，講清楚是哪一種（「請重試」對過期跟被竄改是完全不同的意思）
    const msg: Record<typeof checked.reason, string> = {
      'expired': '這個提議已經過期了（超過 10 分鐘）。請再跟小幫手說一次要改什麼。',
      'wrong-user': '這個提議不是給你的帳號或這個官方帳號的，不能執行。',
      'bad-signature': '這筆確認資料對不上，為了安全不執行。請重新跟小幫手說一次。',
      'malformed': '這筆確認資料不完整，沒有執行任何動作。請重新跟小幫手說一次。',
    }
    throw createError({ statusCode: checked.reason === 'expired' ? 410 : 400, statusMessage: msg[checked.reason] })
  }

  const payload = checked.payload
  const db = getDb()

  try {
    const { opId, op } = getAdminOp(payload.op)

    // ⛔ 權限重驗：憑證是提議當下簽的，這中間權限可能被調降過
    if (!can(role, op.capability)) {
      throw createError({
        statusCode: 403,
        statusMessage: `這個帳號的權限不能做「${ADMIN_OP_LABELS[opId]}」。`,
      })
    }

    // 轉發呼叫者憑證：走既有端點的 op（例如建流程）由那支端點自己驗權限與內容
    const ctx = { db, workspaceId, uid, authHeader: getHeader(event, 'authorization') }
    // 現況指紋：提議後到按下確定之間，別人可能剛改過同一個東西。
    // 拿舊世界的判斷去寫新世界＝安靜地覆蓋掉別人的修改。
    const guard = await op.fingerprint(ctx, payload.a)
    if (guard !== payload.g) {
      throw createError({
        statusCode: 409,
        statusMessage: '這段期間有人改過同一個設定，所以我沒有動手。請再問我一次，我會用最新的狀況重新確認。',
      })
    }

    const result = await op.execute(ctx, payload.a)
    // 真的做成幾次（與 chat 端點的「提議幾次」成對，用來看它提得準不準）
    if (result.ok) {
      recordAiUsage(workspaceId, { agentExecuted: 1 }, db)
        .catch(e => console.error('[admin-agent/confirm] recordAiUsage error:', e))
    }
    return { opId, label: ADMIN_OP_LABELS[opId], ...result }
  }
  catch (e: any) {
    // 參數／目標類的問題（例如那條流程剛好被刪了）：講白話，不吐 stack
    if (e instanceof AdminOpUserError)
      throw createError({ statusCode: 400, statusMessage: e.message })
    if (e?.statusCode) throw e
    console.error('[admin-agent/confirm] execute failed:', payload.op, e)
    throw createError({
      statusCode: 500,
      statusMessage: '執行的時候出了狀況。請到對應頁面確認一下現在的設定，再決定要不要重來一次。',
    })
  }
})
