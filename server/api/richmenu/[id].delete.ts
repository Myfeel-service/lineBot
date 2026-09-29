import { requireCapability } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'
import { writeAuditLog } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const menu = await getDoc<{ richMenuId: string; aliasId?: string; workspaceId?: string; name?: string; isDefault?: boolean; areas?: unknown[] }>('richmenus', id)
  if (!menu || menu.workspaceId !== workspaceId) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  // 先刪除圖文選單別名（釋出 alias ID）
  if (menu.aliasId) {
    try {
      await deleteRichMenuAlias(menu.aliasId, workspaceId)
    } catch (e) {
      console.warn('[richmenu/delete] Failed to delete alias:', e)
    }
  }

  // 從 LINE 刪除圖文選單。
  // ⚠️ 失敗照樣往下走（我們這邊的紀錄要清掉，否則畫面會一直留著一筆點不開的），
  // ⛔ 但**不可以回報成「刪好了」**——呼叫端會照著那句話跟店家說「已經收回去了」，
  //    而 LINE 上其實還留著一張。這裡如實回傳，讓呼叫端自己決定怎麼講。
  let lineDeleted = true
  try {
    await deleteLineRichMenu(menu.richMenuId, workspaceId)
  } catch (e) {
    lineDeleted = false
    console.warn('[richmenu/delete] LINE delete failed:', e)
  }

  await deleteDoc('richmenus', id)

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  // 稽核（`C-254`）。⚠️ `lineDeleted=false` 代表我們這邊清掉了、LINE 上那張還在，
  // 這件事**一定要寫進紀錄**——否則之後「客人手機上怎麼還有一張」會完全查無源頭
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'richmenu.delete',
    targetId: id,
    before: {
      name: String(menu.name ?? ''),
      isDefault: menu.isDefault === true,
      areasCount: Array.isArray(menu.areas) ? menu.areas.length : 0,
    },
    note: lineDeleted ? String(menu.name ?? '') : `${String(menu.name ?? '')}（⚠️ LINE 上那一張沒刪成功，可能還在客人手機上）`,
  })

  return { success: true, lineDeleted }
})
