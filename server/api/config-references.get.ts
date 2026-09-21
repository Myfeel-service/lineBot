import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { scanConfigReferences } from '~~/server/utils/config-references'

/**
 * GET /api/config-references — 「這個東西被誰用了」（`C-209`）
 *
 * Query: `fresh=1` 跳過快取（存檔完回頭看時用，否則最多要等 60 秒）
 *
 * Response: { modules: { [moduleId]: ConfigRef[] }, tags: { [tagId]: ConfigRef[] }, failedKinds }
 *
 * 權限跟這區其他唯讀端點一致：`viewer` 可看（它回的是設定的名字與關係，不含客人資料）。
 *
 * ⛔ **`failedKinds` 不可以在這裡吞掉**：它就是「這次有幾類查不到」，
 *    畫面要靠它分辨「真的沒有人用」與「我這次沒查到」——兩者的下一步完全相反
 *    （前者可以放心停用，後者停用下去可能把正在服務客人的東西弄壞）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const fresh = String(getQuery(event).fresh ?? '') === '1'
  return await scanConfigReferences(getDb(), workspaceId, { skipCache: fresh })
})
