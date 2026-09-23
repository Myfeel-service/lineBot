import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { setMarketingSkip } from '~~/server/utils/marketing-skips'
import { TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'

/**
 * POST /api/marketing-calendar/skip   Body: `{ festivalId, skip }`
 *
 * 把某一檔建議收起來（或放回來）（`C-236`）。
 *
 * ⛔ **只收起畫面，不刪任何東西**：節日本身、推播、標籤都不動。
 *   而且 `festivalId` 本來就含年份（`midautumn-2026`），所以**明年那一檔會自己回來**。
 * ⛔ 認不得的 `festivalId` 一律擋下來：不然打錯字會在資料庫裡留下永遠清不掉的殘渣。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const body = await readBody(event).catch(() => ({})) as { festivalId?: string, skip?: boolean }
  const festivalId = String(body?.festivalId ?? '').trim()
  if (!TAIWAN_FESTIVALS.some(f => f.id === festivalId)) {
    throw createError({ statusCode: 400, statusMessage: '找不到這個檔期' })
  }

  const skips = await setMarketingSkip(getDb(), workspaceId, festivalId, body?.skip !== false)
  return { skips }
})
