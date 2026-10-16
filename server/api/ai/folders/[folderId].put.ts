import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { updateFolder } from '~~/server/utils/ai-knowledge-folders'
import { markGroupProductSyncPending, mergeProductGroupInto, syncGroupSourcesProduct } from '~~/server/utils/ai-knowledge-product-group'
import { confirmAlias, promoteCanonicalName } from '~~/server/utils/ai-product-alias'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { isUsableAlias } from '~~/shared/product-name-similarity'
import { sameProductGroupName } from '~~/shared/knowledge-product-group'

/**
 * PUT /api/ai/folders/:folderId
 * Body: { name?, general? }——至少帶一格；或 { mergeInto: 另一組 id }＝把這一組合進那一組（見下面）。
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
  const db = getDb()

  /*
   * 合成一組（`D-127` /code-review 第 9、10 條）：{ mergeInto: 留下那一組的 id }——這一組的資料全部搬過去、舊組名收成別名、刪掉這一組。
   * 伺服器照 folderId 查全部（畫面清單可能被截斷）；只改名字不學，回 relearnSourceIds 給畫面一份份學（同改組名）。
   * 併進既有端點、不另開一支（多開一支 API 路由會讓不相干的 $fetch 型別報 TS2589）
   */
  if (typeof body?.mergeInto === 'string' && body.mergeInto.trim()) {
    const merged = await mergeProductGroupInto(db, workspaceId, folderId, body.mergeInto.trim())
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'knowledgeFolder.delete',
      targetId: folderId,
      note: `「${merged.fromName}」跟「${merged.intoName}」是同一台：合成一組，搬了 ${merged.moved} 份`
        + (merged.aliasFrom ? `，舊組名收成客人的叫法` : ''),
    }, db)
    return { merged: true, ...merged }
  }

  const name = body?.name === undefined ? undefined : String(body.name ?? '').trim()
  const general = typeof body?.general === 'boolean' ? body.general : undefined
  // 帶了 name 卻是空的＝照舊擋（以前這支只收 name）；兩格都沒帶也擋
  if (name === '' || (name === undefined && general === undefined)) {
    throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })
  }

  const result = await updateFolder(db, workspaceId, folderId, { name, general })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'folder not found' })
  const { before, after } = result

  const renamed = before.name !== after.name
  const generalChanged = before.general !== after.general
  // 改完是商品分組：組名一定是正式名——它要是某條別名就先拿掉（/code-review 第 2 條：不然組名被收斂回舊名字，
  // 下面舊名字收成別名那一步也會因為兩邊收斂成同一個而什麼都不寫）
  if (!after.general && (renamed || generalChanged)) {
    await promoteCanonicalName(db, workspaceId, after.name).catch((e) => {
      console.warn(`[folders] ${folderId} 組名改成正式名失敗:`, (e as Error)?.message)
    })
  }
  // 商品分組改了名：舊名字收成別名（太短的不收：「鍋」這種會在不相干的句子裡命中，同 C-323 的規矩）
  let aliasFrom = ''
  if (renamed && !before.general && !after.general && before.name.trim() && !sameProductGroupName(before.name, after.name) && isUsableAlias(before.name)) {
    const changed = await confirmAlias(db, workspaceId, after.name, before.name).catch((e) => {
      console.warn(`[folders] ${folderId} 舊組名收成別名失敗:`, (e as Error)?.message)
      return false
    })
    if (changed) aliasFrom = before.name
  }
  /*
   * 底下每份換商品名。⛔ 失敗不回 500（/code-review 第 14 條）：組名、別名都已經寫進去了，回 500 畫面會說「儲存失敗」、
   * 他重按儲存時名字已經一樣、這一步再也不跑。照常回 200、帶 syncFailed——畫面講一句；
   * 分組上留記號，體檢把沒跟上的那幾份列進「還沒重新學」，按重新學習會先對齊組名再學（alignSourceProductWithGroup）
   */
  let relearnSourceIds: string[] = []
  let syncFailed = false
  if (renamed || generalChanged) {
    try {
      relearnSourceIds = await syncGroupSourcesProduct(db, workspaceId, folderId)
    }
    catch (e) {
      syncFailed = true
      console.warn(`[folders] ${folderId} 底下資料的商品名沒跟上:`, (e as Error)?.message)
      await markGroupProductSyncPending(db, folderId).catch(() => {})
    }
  }

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
  return { ...after, relearnSourceIds, aliasFrom, ...(syncFailed ? { syncFailed: true } : {}) }
})
