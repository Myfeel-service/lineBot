import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import type { messagingApi } from '@line/bot-sdk'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const { name, size, areas, chatBarText, selected, setAsDefault } = body

  const richMenuPayload: messagingApi.RichMenuRequest = {
    size: size ?? { width: 2500, height: 843 },
    selected: selected ?? true,
    name,
    chatBarText: chatBarText ?? '選單',
    areas,
  }

  let richMenuId: string
  try {
    richMenuId = await createRichMenu(richMenuPayload, workspaceId)
  } catch (err: any) {
    let lineDetail = ''
    try {
      const resp = err.cause ?? err.originalError?.response
      if (resp?.json) lineDetail = JSON.stringify(await resp.json())
    } catch {}
    throw createError({ statusCode: 400, statusMessage: lineDetail || err.message || 'Unknown LINE error' })
  }

  if (setAsDefault) {
    await setDefaultRichMenu(richMenuId, workspaceId)
    const db = getDb()
    const prev = await db
      .collection('richmenus')
      .where('workspaceId', '==', workspaceId)
      .where('isDefault', '==', true)
      .get()
    const batch = db.batch()
    prev.docs.forEach((d) => batch.update(d.ref, { isDefault: false }))
    await batch.commit()
  }

  const id = uuidv4()
  // aliasId: max 32 chars, alphanumeric only (no hyphens) — LINE requirement
  // rm + first 28 chars of UUID (without hyphens) = 30 chars total, safe
  const aliasId = `rm${id.replace(/-/g, '').slice(0, 28)}`

  // Alias is created AFTER image upload in upload.post.ts, not here
  // (LINE requires image to be present before alias can be created)

  const doc = await createDoc('richmenus', id, {
    name,
    richMenuId,
    aliasId,
    size: size ?? { width: 2500, height: 843 },
    areas,
    chatBarText: chatBarText ?? '選單',
    imageUrl: '',
    isDefault: setAsDefault ?? false,
    workspaceId,
    createdAt: FieldValue.serverTimestamp(),
  })

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  return doc
})
