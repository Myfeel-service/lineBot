import { getDoc } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { renderModuleToLineMessages } from '~~/server/utils/handler'
import { pushMessage } from '~~/server/utils/line'
import { extractBroadcastTriggerModuleId } from '~~/shared/broadcast-content'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import type { BroadcastDoc } from '~~/shared/types/tag-broadcast'

/** LINE 的 userId 一律是 U ＋ 32 位十六進位 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i

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
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const doc = await getDoc<BroadcastDoc>('broadcasts', id)
  if (!doc || doc.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }

  const body = await readBody<{ lineUserId?: string }>(event)
  const lineUserId = String(body?.lineUserId || '').trim()
  if (!LINE_USER_ID_RE.test(lineUserId)) {
    throw createError({
      statusCode: 400,
      statusMessage: '這不是一個 LINE 的使用者編號（要以大寫 U 開頭、後面 32 個字）。到「好友」頁點開一位好友、按「複製 ID」就拿得到。',
    })
  }

  /*
   * ⛔ 先確認他是不是這個官方帳號的好友：不是的話 LINE 會回一個看不懂的 400，
   * 而店家只會看到「發送失敗」三個字，完全不知道是 ID 貼錯還是系統壞了。
   */
  const friend = await getDoc<Record<string, unknown>>('users', lineUserFirestoreDocId(lineUserId, workspaceId))
  if (!friend) {
    throw createError({
      statusCode: 404,
      statusMessage: '這個編號不是這個官方帳號的好友（LINE 只讓我們發訊息給已加好友的人）。請確認 ID 是從這個帳號的「好友」頁複製的。',
    })
  }

  if (!doc.messages?.length) {
    throw createError({ statusCode: 400, statusMessage: '這則推播還沒有訊息內容，先把內容填好再試發。' })
  }

  const runtimeConfig = useRuntimeConfig()
  const requestOrigin = String(runtimeConfig.clickTrackingBaseUrl || '').trim().replace(/\/$/, '')

  // ── 組出「正式發送時會送出去的那幾則」──────────────────────────────
  const triggerModuleId = extractBroadcastTriggerModuleId(doc.messages)
  let messages = doc.messages as Record<string, unknown>[]
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

  try {
    await pushMessage(lineUserId, messages as never, workspaceId)
  }
  catch (e: unknown) {
    const detail = (e as { originalError?: { response?: { data?: { message?: string } } }; message?: string })
    const reason = detail?.originalError?.response?.data?.message || detail?.message || ''
    console.error('[broadcast/test-send] push failed:', reason || e)
    throw createError({
      statusCode: 502,
      statusMessage: `LINE 沒有收下這則試發訊息${reason ? `（${reason}）` : ''}。常見原因是對方封鎖了官方帳號。`,
    })
  }

  return {
    ok: true,
    messageCount: messages.length,
    moduleName,
    lineUserId,
    displayName: String((friend as { displayName?: string }).displayName || ''),
  }
})
