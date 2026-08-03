import type { messagingApi } from '@line/bot-sdk'
import { validateUploadPayload } from '~~/server/utils/upload-validator'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const firestoreId = getRouterParam(event, 'id')
  if (!firestoreId) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const body = await readBody(event)
  const { name, size, areas, chatBarText, selected, setAsDefault, imageBase64, contentType } = body

  // Get existing doc to get the old richMenuId and old imageUrl
  const oldDoc = await getDoc<any>('richmenus', firestoreId)
  if (!oldDoc || oldDoc.workspaceId !== workspaceId) throw createError({ statusCode: 404, statusMessage: '找不到圖文選單' })

  // Use stored aliasId or derive — max 32 chars, alphanumeric only (LINE requirement)
  const aliasId = oldDoc.aliasId ?? `rm${firestoreId.replace(/-/g, '').slice(0, 28)}`

  // 1. 在 LINE 建立新圖文選單
  const richMenuPayload: messagingApi.RichMenuRequest = {
    size: size ?? { width: 2500, height: 843 },
    selected: selected ?? true,
    name,
    chatBarText: chatBarText ?? '選單',
    areas,
  }

  let newRichMenuId: string
  try {
    newRichMenuId = await createRichMenu(richMenuPayload, workspaceId)
  } catch (err: any) {
    // Try to read LINE's actual error body from the Response cause
    let lineDetail = ''
    try {
      const resp = err.cause ?? err.originalError?.response
      if (resp && typeof resp.json === 'function') {
        const body = await resp.json()
        lineDetail = JSON.stringify(body)
      }
    } catch {}
    console.error('[richmenu/put] LINE createRichMenu error:', lineDetail || err.message)
    throw createError({ statusCode: 400, statusMessage: lineDetail || err.message || 'Unknown LINE error' })
  }


  // 2. 上傳圖片至新圖文選單
  let imageBuffer: Buffer
  let finalContentType = contentType ?? 'image/png'

  if (imageBase64) {
    const validated = validateUploadPayload({
      base64Input: imageBase64,
      contentType: finalContentType,
      allowedCategories: ['image'],
    })
    imageBuffer = validated.buffer
    finalContentType = validated.contentType
  } else if (oldDoc.imageUrl) {
    try {
      const response = await fetch(oldDoc.imageUrl)
      const arrayBuffer = await response.arrayBuffer()
      imageBuffer = Buffer.from(arrayBuffer)
      finalContentType = response.headers.get('content-type') || 'image/png'
    } catch (e) {
      await deleteLineRichMenu(newRichMenuId, workspaceId)
      throw createError({ statusCode: 500, statusMessage: 'Failed to fetch existing image from storage' })
    }
  } else {
    await deleteLineRichMenu(newRichMenuId, workspaceId)
    throw createError({ statusCode: 400, statusMessage: 'No image provided and no existing image found' })
  }

  await uploadRichMenuImage(newRichMenuId, imageBuffer, finalContentType, workspaceId)

  // 3. Update Alias to point to the NEW richMenuId（刪除別名後重建同 aliasId）
  // 若此步失敗仍繼續刪舊選單，會造成別名指向已刪除的 richMenuId，richmenuswitch 全面失效。
  try {
    await updateRichMenuAlias(newRichMenuId, aliasId, workspaceId)
  }
  catch (e) {
    console.error('[richmenu/put] Failed to update alias:', e)
    try {
      await deleteLineRichMenu(newRichMenuId, workspaceId)
    }
    catch (delErr) {
      console.warn('[richmenu/put] rollback: could not delete new LINE rich menu:', delErr)
    }
    const msg = e instanceof Error ? e.message : String(e)
    throw createError({ statusCode: 502, statusMessage: `更新圖文選單別名失敗，已中止變更：${msg}` })
  }

  // 4. Handle default setting
  if (setAsDefault) {
    await setDefaultRichMenu(newRichMenuId, workspaceId)
    const db = getDb()
    const prev = await db
      .collection('richmenus')
      .where('workspaceId', '==', workspaceId)
      .where('isDefault', '==', true)
      .get()
    const batch = db.batch()
    prev.docs.forEach((d) => {
      if (d.id !== firestoreId) batch.update(d.ref, { isDefault: false })
    })
    await batch.commit()
  }

  // 5. 從 LINE 刪除舊圖文選單
  if (oldDoc.richMenuId) {
    try {
      await deleteLineRichMenu(oldDoc.richMenuId, workspaceId)
    } catch (e) {
      console.warn('[richmenu] 無法刪除舊的 LINE 圖文選單:', e)
    }
  }

  // 6. Update Firestore record
  let finalImageUrl = oldDoc.imageUrl
  if (imageBase64) {
    const storage = getStorage()
    const bucket = storage.bucket()
    const ext = finalContentType.includes('jpeg') ? 'jpg' : 'png'
    const fileName = `richmenus/${newRichMenuId}.${ext}`
    const file = bucket.file(fileName)
    await file.save(imageBuffer, { contentType: finalContentType })
    await file.makePublic()
    finalImageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`
  }

  await updateDoc('richmenus', firestoreId, {
    richMenuId: newRichMenuId,
    aliasId,
    name,
    size: size ?? { width: 2500, height: 843 },
    chatBarText: chatBarText ?? '選單',
    areas,
    isDefault: setAsDefault ?? false,
    imageUrl: finalImageUrl,
  })

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  return { success: true, richMenuId: newRichMenuId, aliasId, imageUrl: finalImageUrl }
})
