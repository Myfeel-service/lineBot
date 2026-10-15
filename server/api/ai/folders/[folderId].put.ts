import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { updateFolder } from '~~/server/utils/ai-knowledge-folders'
import { syncGroupSourcesProduct } from '~~/server/utils/ai-knowledge-product-group'
import { confirmAlias } from '~~/server/utils/ai-product-alias'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { isUsableAlias } from '~~/shared/product-name-similarity'
import { sameProductGroupName } from '~~/shared/knowledge-product-group'

/**
 * PUT /api/ai/folders/:folderId
 * Body: { name?, general? }——至少帶一格。
 *
 * `general`（`C-320`）：true＝「通用」分組（FAQ、公告、價目表這種不是講單一商品的），false＝商品分組。
 *
 * `D-127` 分組就是商品——改完之後：
 *  · 底下每份資料的商品名跟著改成組名（改成通用＝清掉），回 `relearnSourceIds`：畫面要一份份打
 *    POST /api/ai/sources/:id/reindex 重新學習（一組可能好幾百條，這個請求學不完）
 *  · 商品分組改名：舊名字收成新名字的別名（回 `aliasFrom`）——學完之前卡片上還是舊名字、
 *    客人也可能照舊那樣叫，有別名就照樣認得是這一台；不要的話在「客人還會怎麼叫它」按 × 拿掉
 *  · 改成跟別的商品分組同名＝400（updateFolder 擋）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'folders.write')
  const folderId = String(getRouterParam(event, 'folderId') ?? '').trim()
  if (!folderId) throw createError({ statusCode: 400, statusMessage: 'folderId required' })

  const body = await readBody(event).catch(() => ({}))
  const name = body?.name === undefined ? undefined : String(body.name ?? '').trim()
  const general = typeof body?.general === 'boolean' ? body.general : undefined
  // 帶了 name 卻是空的＝照舊擋（以前這支只收 name）；兩格都沒帶也擋
  if (name === '' || (name === undefined && general === undefined)) {
    throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })
  }

  const db = getDb()
  const result = await updateFolder(db, workspaceId, folderId, { name, general })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'folder not found' })
  const { before, after } = result

  const renamed = before.name !== after.name
  const generalChanged = before.general !== after.general
  // 商品分組改了名：舊名字收成別名（太短的不收：「鍋」這種會在不相干的句子裡命中，同 C-323 的規矩）
  let aliasFrom = ''
  if (renamed && !before.general && !after.general && before.name.trim() && !sameProductGroupName(before.name, after.name) && isUsableAlias(before.name)) {
    const changed = await confirmAlias(db, workspaceId, after.name, before.name).catch((e) => {
      console.warn(`[folders] ${folderId} 舊組名收成別名失敗:`, (e as Error)?.message)
      return false
    })
    if (changed) aliasFrom = before.name
  }
  const relearnSourceIds = renamed || generalChanged ? await syncGroupSourcesProduct(db, workspaceId, folderId) : []

  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledgeFolder.put',
    targetId: folderId,
    after: { name: after.name },
    // 「通用」這一格、商品名跟著改的份數寫在備註：操作紀錄的欄位名對照表沒有它們，放進前後對照只會顯示英文 key
    ...(generalChanged || relearnSourceIds.length || aliasFrom
      ? {
          note: [
            generalChanged ? `「${after.name}」改成${after.general ? '通用（不是講單一商品）' : '商品分組'}` : '',
            relearnSourceIds.length ? `底下 ${relearnSourceIds.length} 份資料的商品名跟著改成「${after.general ? '（不是講單一商品）' : after.name}」` : '',
            aliasFrom ? `舊名字「${aliasFrom}」收成客人的叫法` : '',
          ].filter(Boolean).join('；'),
        }
      : {}),
  }, db)
  return { ...after, relearnSourceIds, aliasFrom }
})
