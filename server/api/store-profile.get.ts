import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { isStoreProfileReady } from '~~/shared/types/store-profile'

/**
 * GET /api/store-profile
 *
 * 這個工作區的店家輪廓（沒建過就回空輪廓，不是 404——呼叫端不用分兩種情況畫）。
 * `ready` 順手算好一起回：「MiniMe 認不認識這家店」的口徑只能有一個，
 * 前端自己再算一次就會有兩份會慢慢飄的判斷。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const profile = await getStoreProfile(workspaceId)
  return { profile, ready: isStoreProfileReady(profile) }
})
