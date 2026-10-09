import { getDoc } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { renderModuleToLineMessages } from '~~/server/utils/handler'
import { renderBroadcastMessagesForSend } from '~~/server/utils/render-attributes'
import { pushMessage } from '~~/server/utils/line'
import { extractBroadcastTriggerModuleId } from '~~/shared/broadcast-content'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { allowedTestRecipientIds } from '~~/server/utils/broadcast-test-recipients'
import type { BroadcastDoc } from '~~/shared/types/tag-broadcast'

/** LINE 的 userId 一律是 U ＋ 32 位十六進位 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i
/** 一次最多發幾位：看稿的人通常 1–5 位（正式庫實測），上限只是擋手滑 */
const MAX_TEST_RECIPIENTS = 10

interface TestSendResult {
  lineUserId: string
  displayName: string
  ok: boolean
  /** 沒送到的原因（人看得懂的一句話） */
  error?: string
}

/**
 * POST /api/broadcast/:id/test-send —— 先發一則給自己看（`C-248`）。
 *
 * **為什麼要有**：推播是唯一「按下去就送給全部好友、收不回來」的功能，而在這支之前
 * **完全沒有試發**。唯讀盤點正式庫：43 則推播裡有 15 則是拿正式推播當試打用的
 * （名字帶「測試」或只送 1–3 人），那些紀錄會永遠留在推播列表與成效報表裡。
 *
 * ⭐ **內容走跟正式發送同一條路**（同一支 `extractBroadcastTriggerModuleId` 判斷、
 * 同一支 `renderModuleToLineMessages` 組裝）。⛔ 另外組一份的話，試發過了正式發送還是
 * 可能不一樣，那就白試了——這正是 `C-243` 修掉的那個病。
 *
 * ⛔ **不動任何帳**：不改推播狀態、不寫受眾快照、不寫 deliveries、不貼「發完的記號」、
 * 不佔 LINE 的彙總單位、不包點擊追蹤（包了的話試發的點擊會算進那則推播的成效）。
 * ⛔ **不綁方案**：`planAllowsBroadcast` 把「非全體」的受眾都歸類成 advanced，而輕量／入門
 * 是 basic ——那兩個方案的店家連「挑一個人送」都做不到。把「別發錯」做成加價功能是錯的。
 * ⛔ **不寫進客服對話**：正式推播也不寫，試發要跟正式發送長得一樣。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'broadcast.write')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const doc = await getDoc<BroadcastDoc>('broadcasts', id)
  if (!doc || doc.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }

  /*
   * `D-119` ⑥（2026-10-09）：一次可以勾好幾位，但**只能發給試發名單上的人**——
   * 自己綁好的手機、綁好的同事、常找來看稿的人。⛔ 名單一律由伺服器算，不信任前端傳來的。
   * （舊的單一 `lineUserId` 照收，一樣要在名單上）
   */
  const body = await readBody<{ lineUserIds?: unknown, lineUserId?: unknown }>(event)
  const requested = [
    ...(Array.isArray(body?.lineUserIds) ? body.lineUserIds : []),
    ...(body?.lineUserId ? [body.lineUserId] : []),
  ].map(v => String(v ?? '').trim())
  const lineUserIds = [...new Set(requested)]
  if (!lineUserIds.length) {
    throw createError({ statusCode: 400, statusMessage: '請至少勾一位要收試發的人。' })
  }
  if (lineUserIds.length > MAX_TEST_RECIPIENTS) {
    throw createError({ statusCode: 400, statusMessage: `一次最多試發給 ${MAX_TEST_RECIPIENTS} 位。` })
  }
  if (lineUserIds.some(v => !LINE_USER_ID_RE.test(v))) {
    throw createError({ statusCode: 400, statusMessage: '收件人裡有一個不是 LINE 帳號，請重新打開試發再勾一次。' })
  }
  const allowed = await allowedTestRecipientIds(workspaceId, uid)
  if (lineUserIds.some(v => !allowed.has(v))) {
    throw createError({
      statusCode: 403,
      statusMessage: '試發只能發給名單上的人：你自己、綁好手機的同事、常找來看稿的人。要發給別人，先把他加進「常找來看稿的人」。',
    })
  }

  /*
   * ⛔ 先確認每一位都還是這個官方帳號的好友：不是的話 LINE 會回一個看不懂的 400，
   * 而店家只會看到「發送失敗」三個字。名單上的人也可能後來封鎖或刪了好友。
   */
  const friends = await Promise.all(lineUserIds.map(async id => ({
    lineUserId: id,
    friend: await getDoc<Record<string, unknown>>('users', lineUserFirestoreDocId(id, workspaceId)),
  })))

  if (!doc.messages?.length) {
    throw createError({ statusCode: 400, statusMessage: '這則推播還沒有訊息內容，先把內容填好再試發。' })
  }

  const runtimeConfig = useRuntimeConfig()
  const requestOrigin = String(runtimeConfig.clickTrackingBaseUrl || '').trim().replace(/\/$/, '')

  // ── 組出「正式發送時會送出去的那幾則」──────────────────────────────
  const triggerModuleId = extractBroadcastTriggerModuleId(doc.messages)
  // 變數換成空白，跟正式發送同一支（⛔ 試發收到原字 {{displayName}}、正式發送卻是空白，就白試了）
  let messages = renderBroadcastMessagesForSend(doc.messages as Record<string, unknown>[])
  let moduleName = ''
  if (triggerModuleId) {
    const rendered = await renderModuleToLineMessages(triggerModuleId, { workspaceId, requestOrigin })
    if (!rendered || rendered.lineMessages.length === 0) {
      throw createError({
        statusCode: 409,
        statusMessage: '這則推播要送出的機器人模組已經不存在、被停用，或裡面一則訊息都沒有——正式發送也會失敗。請先把模組處理好。',
      })
    }
    messages = rendered.lineMessages as unknown as Record<string, unknown>[]
    moduleName = String((rendered.flow as { name?: string })?.name || '')
  }

  // 一位一位送：誰送到、誰沒送到要分得開（⛔ 一位失敗不可以讓其他人也算失敗）
  const sent: TestSendResult[] = []
  for (const { lineUserId, friend } of friends) {
    const displayName = String((friend as { displayName?: string } | null)?.displayName || '')
    if (!friend) {
      sent.push({ lineUserId, displayName, ok: false, error: '已經不是這個官方帳號的好友' })
      continue
    }
    // 名單只管「誰在名單上」（`allowedTestRecipientIds`），封鎖了的在這裡講、不送（試發框也不給勾）
    if ((friend as { isBlocked?: boolean }).isBlocked === true) {
      sent.push({ lineUserId, displayName, ok: false, error: '對方封鎖了官方帳號，收不到' })
      continue
    }
    try {
      await pushMessage(lineUserId, messages as never, workspaceId)
      sent.push({ lineUserId, displayName, ok: true })
    }
    catch (e: unknown) {
      const detail = (e as { originalError?: { response?: { data?: { message?: string } } }; message?: string })
      const reason = detail?.originalError?.response?.data?.message || detail?.message || ''
      console.error('[broadcast/test-send] push failed:', reason || e)
      sent.push({ lineUserId, displayName, ok: false, error: `LINE 沒有收下${reason ? `（${reason}）` : ''}，常見原因是對方封鎖了官方帳號` })
    }
  }

  const delivered = sent.filter(s => s.ok)
  if (!delivered.length) {
    const only = sent.length === 1 ? sent[0] : null
    throw createError({
      statusCode: only && only.error === '已經不是這個官方帳號的好友' ? 404 : 502,
      statusMessage: only
        ? `沒送到「${only.displayName || only.lineUserId}」：${only.error}。`
        : `一位都沒送到：${sent.map(s => `${s.displayName || s.lineUserId}（${s.error}）`).join('、')}。`,
    })
  }

  /*
   * 稽核（`C-254`）：試發**確實把訊息送進了真人的 LINE**，所以它是一次對外發送，要記。
   * ⛔ 記在送出之後、只記送到的人（送失敗就不該留下「發過了」的紀錄）。
   * ⚠️ 只記收件者的顯示名稱，⛔ 不記訊息內容（跟正式推播一致）。
   * `D-119`：一次可以好幾位，名字串成一行字存（⛔ 不存陣列：陣列在紀錄裡只會剩「幾項」）。
   */
  const names = delivered.map(s => s.displayName || s.lineUserId)
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'broadcast.testSend',
    targetId: id,
    after: {
      name: String(doc.name ?? ''),
      recipientNames: names.join('、'),
      recipientCount: names.length,
      messagesCount: messages.length,
      ...(moduleName ? { moduleName } : {}),
    },
    note: `試發給 ${names.join('、')}${moduleName ? `（模組：${moduleName}）` : ''}`,
  })

  return {
    ok: true,
    messageCount: messages.length,
    moduleName,
    sent,
  }
})
