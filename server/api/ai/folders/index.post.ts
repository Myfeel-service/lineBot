import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { createFolder } from '~~/server/utils/ai-knowledge-folders'
import { promoteCanonicalName } from '~~/server/utils/ai-product-alias'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/folders
 * Body: { name: string, general?: boolean }
 *
 * `general: true`（`C-320`）：建成「通用」分組（不是講單一商品的資料放這裡）。沒帶＝商品分組，跟以前一樣。
 * `D-127`：商品分組已經有同名的（只差空白、符號、大小寫）＝不另建，回那一組並帶 `existed: true`。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'folders.write')
  const body = await readBody(event).catch(() => ({}))
  const name = String(body?.name ?? '').trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })

  const db = getDb()
  const folder = await createFolder(db, workspaceId, name, { general: body?.general === true })
  // `D-127`：已經有同一台的商品分組＝回那一組（existed: true），沒有新建、不記「建了一組」
  if (folder.existed) return folder
  // 新的商品分組：組名一定是正式名——它要是某條別名就拿掉（/code-review 第 2 條：不然放進來的資料建索引時會被收斂回舊名字）
  if (!folder.general) {
    await promoteCanonicalName(db, workspaceId, folder.name).catch((e) => {
      console.warn(`[folders] ${folder.id} 組名改成正式名失敗:`, (e as Error)?.message)
    })
  }
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledgeFolder.create',
    targetId: folder.id,
    after: { name: folder.name },
    ...(folder.general ? { note: `「${folder.name}」是通用（不是講單一商品）` } : {}),
  }, db)
  return folder
})
