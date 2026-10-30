import type { H3Event } from 'h3'
import { requireCapability } from './workspace-auth'
import { writeAuditLog } from './audit-log'
import { assertValidFlowMessages } from './flow-validator'
import { renderFlowMessagesForSend } from './handler'
import { assertSomeoneReceived, pushToTestRecipients, resolveTestRecipients } from './test-send'

/**
 * 機器人模組「傳給我自己看」（`C-426`）。路由借 `server/api/flow/create.post.ts`（POST `?part=test-send`，不另開——路由型別已經貼著上限）。
 *
 * **為什麼要有**：卡片長相、圖片比例、網址點不點得開，只有手機上看得準；推播能先試發、模組不行
 * （`C-415` 為了看一張卡，得另外建測試模組＋關鍵字規則）。
 *
 * ⭐ 送的是**畫面上那一份（還沒存檔也行）**——跟推播試發相反：推播草稿存了也還沒送出，
 * 模組一存檔就直接對客人生效，「先存再試」等於先上線再看。所以內容由前端帶來，
 * ⛔ 但照樣走存檔那一套檢查（`assertValidFlowMessages`）：存不了的也不送，不然手機上看到的是存不進去的東西。
 * ⭐ 組裝跟正式回覆同一支（`renderFlowMessagesForSend`），⛔ 不另外組一份。
 *
 * ⛔ 收件人規則跟推播試發同一份（`server/utils/test-send.ts`）：只發給試發名單上的人。
 * ⛔ 不帶貼標連結（看稿的同事點了不該被貼標籤）、不寫進客服對話、不記成模組被點了幾次。
 * ⛔ 不綁方案：「先看一眼」不該是加價功能（同 `C-248`）。
 */
export async function flowTestSend(event: H3Event) {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')

  const body = await readBody<{ messages?: unknown, lineUserIds?: unknown, lineUserId?: unknown, name?: unknown, flowId?: unknown, product?: unknown }>(event)
  const friends = await resolveTestRecipients(body, workspaceId, uid)

  const messages = body?.messages
  assertValidFlowMessages(messages)

  const runtimeConfig = useRuntimeConfig()
  const requestOrigin = String(runtimeConfig.clickTrackingBaseUrl || '').trim().replace(/\/$/, '')
  // `C-437`：商品資訊範本試發的是畫面上「預覽商品」那一個（`來源id:商品id`；商品清單照帳號讀，別人的對不到）
  const product = typeof body?.product === 'string' ? body.product.slice(0, 120) : undefined
  const { renderFor } = await renderFlowMessagesForSend(messages, { workspaceId, requestOrigin, product })
  /** 則數每一位都一樣（換名字不會多出一則），回給畫面講「每人送了幾則」 */
  const messageCount = renderFor({}).length
  if (!messageCount) {
    throw createError({ statusCode: 400, statusMessage: '這個模組組不出任何一則訊息，先把內容填好再傳。' })
  }

  const sent = await pushToTestRecipients(friends, attributes => renderFor(attributes), workspaceId, '[flow/test-send]')
  const delivered = assertSomeoneReceived(sent)

  /*
   * 稽核（`C-254`）：確實把訊息送進了真人的 LINE，是一次對外發送，要記。
   * ⛔ 記在送出之後、只記送到的人；⛔ 不記訊息內容（跟推播試發一致）。
   */
  const moduleName = String(body?.name ?? '').trim().slice(0, 200)
  const names = delivered.map(s => s.displayName || s.lineUserId)
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'flow.testSend',
    targetId: typeof body?.flowId === 'string' ? body.flowId : '',
    after: {
      name: moduleName,
      recipientNames: names.join('、'),
      recipientCount: names.length,
      messagesCount: messageCount,
    },
    note: `試發模組「${moduleName || '（還沒取名）'}」給 ${names.join('、')}`,
  })

  return { ok: true, messageCount, sent }
}
