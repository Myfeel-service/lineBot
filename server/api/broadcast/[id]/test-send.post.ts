import { getDoc } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { renderModuleToLineMessages } from '~~/server/utils/handler'
import { renderBroadcastMessagesForSend } from '~~/server/utils/render-attributes'
import { assertSomeoneReceived, pushToTestRecipients, resolveTestRecipients } from '~~/server/utils/test-send'
import { extractBroadcastTriggerModuleId } from '~~/shared/broadcast-content'
import type { BroadcastDoc } from '~~/shared/types/tag-broadcast'

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

  // 收件人只收試發名單上的人、先查還是不是好友（規則跟模組「傳給我自己看」同一份：`server/utils/test-send.ts`）
  const body = await readBody<{ lineUserIds?: unknown, lineUserId?: unknown }>(event)
  const friends = await resolveTestRecipients(body, workspaceId, uid)

  if (!doc.messages?.length) {
    throw createError({ statusCode: 400, statusMessage: '這則推播還沒有訊息內容，先把內容填好再試發。' })
  }

  const runtimeConfig = useRuntimeConfig()
  const requestOrigin = String(runtimeConfig.clickTrackingBaseUrl || '').trim().replace(/\/$/, '')

  // ── 組出「正式發送時會送出去的那幾則」──────────────────────────────
  const triggerModuleId = extractBroadcastTriggerModuleId(doc.messages)
  /**
   * 每一位換上**他自己的**名字，跟正式發送同一支（`D-118` A：用了變數的推播一人一則送）。
   * ⛔ 試發收到的跟正式發送不一樣就白試了——以前試發收到原字 {{displayName}}、正式發送卻是空白。
   */
  let renderFor = (attributes: Record<string, string>) =>
    renderBroadcastMessagesForSend(doc.messages as Record<string, unknown>[], attributes)
  let moduleName = ''
  if (triggerModuleId) {
    const rendered = await renderModuleToLineMessages(triggerModuleId, { workspaceId, requestOrigin })
    if (!rendered || rendered.lineMessages.length === 0) {
      throw createError({
        statusCode: 409,
        statusMessage: '這則推播要送出的機器人模組已經不存在、被停用，或裡面一則訊息都沒有——正式發送也會失敗。請先把模組處理好。',
      })
    }
    renderFor = attributes => rendered.renderFor(attributes) as unknown as Record<string, unknown>[]
    moduleName = String((rendered.flow as { name?: string })?.name || '')
  }
  /** 則數每一位都一樣（換名字不會多出一則），回給畫面講「每人送了幾則」 */
  const messageCount = renderFor({}).length

  // 一位一位送：誰送到、誰沒送到要分得開（⛔ 一位失敗不可以讓其他人也算失敗）
  const sent = await pushToTestRecipients(friends, renderFor, workspaceId, '[broadcast/test-send]')
  const delivered = assertSomeoneReceived(sent)

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
      messagesCount: messageCount,
      ...(moduleName ? { moduleName } : {}),
    },
    note: `試發給 ${names.join('、')}${moduleName ? `（模組：${moduleName}）` : ''}`,
  })

  return {
    ok: true,
    messageCount,
    moduleName,
    sent,
  }
})
