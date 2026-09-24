import { getDb, getDoc } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { resolveAudienceUserIds } from '~~/server/utils/audience'
import { extractBroadcastTriggerModuleId } from '~~/shared/broadcast-content'
import type { BroadcastDoc, AudienceFilter } from '~~/shared/types/tag-broadcast'

/**
 * POST /api/broadcast/:id/validate
 * 發送前檢查，回傳預估資訊，不真正發送
 *
 * Response:
 * {
 *   valid: boolean
 *   errors: string[]
 *   estimatedCount: number     // 預估發送人數
 *   previewUserIds: string[]   // 前 5 筆預覽
 * }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const snap = await db.collection('broadcasts').doc(id).get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })

  const data = snap.data() as BroadcastDoc
  if (data.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }
  const errors: string[] = []

  // 檢查訊息內容
  if (!data.messages?.length) {
    errors.push('推播訊息不能為空')
  }

  /**
   * `C-247`：模組型推播要在**按下發送之前**確認那個模組還送得出東西。
   *
   * ⛔ 原本這裡只檢查「訊息不是空的、受眾算得出人」，所以模組被停用／刪掉／清空時，
   * 確認框照樣顯示「預估發送人數 842」一切正常，**按下去才整則失敗**（送出端 throw，
   * 而那時受眾快照已經寫進去、狀態已經是 processing）。排程推播踩到這個是半夜爆，
   * 隔天早上只看得到「失敗」兩個字。正式庫已經有一筆指向查不到模組的紀錄（`MR測試`）。
   *
   * ⚠️ 判斷「是不是模組型」用**送出端同一支函式**，不要照 `messages[0].type` 自己看。
   */
  const triggerModuleId = extractBroadcastTriggerModuleId(data.messages)
  if (triggerModuleId) {
    const flow = await getDoc<Record<string, unknown>>('flows', triggerModuleId)
    const flowName = String(flow?.name || '').trim()
    if (!flow || flow.workspaceId !== workspaceId) {
      errors.push('這則推播要送出的機器人模組已經不存在了（可能被刪掉），現在發出去會整則失敗。請改選一個還在的模組。')
    }
    else if (flow.isActive !== true) {
      // ⚠️ 送出端走的 `getFlowByModuleId` 要求 `isActive`，停用的模組拿回來是 null
      errors.push(`這則推播要送出的機器人模組「${flowName || triggerModuleId}」目前是停用狀態，現在發出去會整則失敗。請先到「機器人模組」把它啟用。`)
    }
    else if (!Array.isArray(flow.messages) || flow.messages.length === 0) {
      errors.push(`機器人模組「${flowName || triggerModuleId}」裡面一則訊息都沒有，發出去客人什麼都收不到。請先把內容編好。`)
    }
  }

  // 檢查狀態
  if (data.status === 'completed') {
    errors.push('此推播已發送完成，無法再次發送')
  }
  if (data.status === 'processing') {
    errors.push('此推播正在發送中')
  }

  // 解析受眾
  let resolvedUserIds: string[] = []
  try {
    if (data.audienceSource.type === 'all') {
      let query = db.collection('users').select() as FirebaseFirestore.Query
      query = query.where('workspaceId', '==', workspaceId)
      const usersSnap = await query.get()
      resolvedUserIds = usersSnap.docs.map((d) => d.id)
    }
    else if (data.audienceSource.type === 'tags' && data.audienceSource.tagIds?.length) {
      const filter: AudienceFilter = {
        conditions: [{ type: 'includeAny', tagIds: data.audienceSource.tagIds }],
        joinedAfter: null,
        joinedBefore: null,
        isBlocked: null,
      }
      resolvedUserIds = await resolveAudienceUserIds(filter, workspaceId)
    }
    else if (data.audienceSource.type === 'audience' && data.audienceSource.audienceId) {
      const audienceSnap = await db.collection('audiences').doc(data.audienceSource.audienceId).get()
      if (!audienceSnap.exists || String(audienceSnap.data()?.workspaceId || '') !== workspaceId) {
        errors.push('指定的受眾群組不存在')
      }
      else {
        resolvedUserIds = await resolveAudienceUserIds(audienceSnap.data()!.filter as AudienceFilter, workspaceId)
      }
    }
    else if (data.audienceSource.type === 'import') {
      resolvedUserIds = data.audienceSource.importedUserIds ?? []
    }
  }
  catch (err) {
    errors.push('受眾解析失敗，請稍後再試')
  }

  if (!resolvedUserIds.length && !errors.length) {
    errors.push('受眾人數為 0，無法發送')
  }

  return {
    valid: errors.length === 0,
    errors,
    estimatedCount: resolvedUserIds.length,
    previewUserIds: resolvedUserIds.slice(0, 5),
  }
})
