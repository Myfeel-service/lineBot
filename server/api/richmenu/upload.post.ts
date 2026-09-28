import { validateUploadPayload } from '~~/server/utils/upload-validator'
import { writeAuditLog } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const { richMenuId, firestoreId, imageBase64, contentType } = body

  if (!richMenuId || !imageBase64) {
    throw createError({ statusCode: 400, statusMessage: 'richMenuId and imageBase64 are required' })
  }

  const { buffer: imageBuffer, contentType: normalizedContentType } = validateUploadPayload({
    base64Input: imageBase64,
    contentType,
    allowedCategories: ['image'],
  })

  /*
   * 🔴 反查歸屬（`G-93`），⛔ 一定要在傳到 LINE、存進 Storage **之前**：
   * 以前 body 帶的 `firestoreId` 前後都不比對 workspaceId，A 家的人把它換成 B 家某張選單的 id，
   * 就能把 B 家那張的圖換成自己的；B 下次沒重傳圖就按存檔，`[id].put.ts` 會抓這張圖發到 B 的 LINE。
   * 同一組的 `setDefault.post.ts`、`[id].put.ts` 早就有比對（`E-16`），只有這支漏了。
   *
   * 連 `richMenuId` 也要對得上：唯一的呼叫端是「建立新選單」（`richmenu.vue` 先打 create、
   * 再把 create 回來的 `richMenuId`＋`id` 原樣帶過來），兩者一定是同一張。改既有選單走的是
   * `[id].put.ts`，它自己在 LINE 重建、自己傳圖，不經過這支——所以這個比對不會擋到正常編輯。
   * ⛔ 不比對的話，自己家的 firestoreId 配上別的 richMenuId，會讓這張選單的紀錄指向一張不是它的圖。
   */
  if (firestoreId) {
    const menu = await getDoc<{ workspaceId?: string, richMenuId?: string }>('richmenus', String(firestoreId))
    if (!menu || menu.workspaceId !== workspaceId || menu.richMenuId !== richMenuId) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }
  }

  const lineImageType = normalizedContentType === 'image/jpeg' || normalizedContentType === 'image/jpg'
    ? 'image/jpeg' as const
    : 'image/png' as const
  await uploadRichMenuImage(richMenuId, imageBuffer, lineImageType, workspaceId)

  const storage = getStorage()
  const bucket = storage.bucket()
  const fileName = `richmenus/${richMenuId}.${normalizedContentType === 'image/jpeg' || normalizedContentType === 'image/jpg' ? 'jpg' : 'png'}`
  const file = bucket.file(fileName)
  await file.save(imageBuffer, { contentType: normalizedContentType })
  await file.makePublic()
  const imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`

  let aliasResult: { aliasId?: string; error?: string } = {}

  if (firestoreId) {
    await updateDoc('richmenus', firestoreId, { imageUrl })

    // Get or derive aliasId — pure alphanumeric, no hyphens (LINE requirement)
    const stored = await getDoc<any>('richmenus', firestoreId)
    const aliasId = stored?.aliasId ?? `rm${firestoreId.replace(/-/g, '').slice(0, 28)}`

    // Delete existing alias first (ignore error if not exists)
    try { await deleteRichMenuAlias(aliasId, workspaceId) } catch {}

    try {
      await createRichMenuAlias(richMenuId, aliasId, workspaceId)
      await updateDoc('richmenus', firestoreId, { aliasId })
      aliasResult = { aliasId }
    } catch (e: any) {
      const errMsg = e?.message ?? String(e)
      console.warn('[upload] Failed to create alias:', errMsg)
      aliasResult = { error: errMsg }
    }
  }

  /*
   * 稽核（`C-254`）：底圖就是客人真的會看到的那張圖，換了就是換了。
   * ⚠️ 別名建立失敗（`aliasResult.error`）代表選單之間的切換會失效——
   * 那是店家會拿來問「為什麼按了沒反應」的事，所以寫進備註，⛔ 不只記「換了圖」。
   */
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'richmenu.upload',
    ...(firestoreId ? { targetId: String(firestoreId) } : {}),
    note: aliasResult.error
      ? `⚠️ 圖換好了，但選單切換用的別名沒建起來：${aliasResult.error}`
      : '換了圖文選單的底圖',
  })

  return { imageUrl, alias: aliasResult }
})
