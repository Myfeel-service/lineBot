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
