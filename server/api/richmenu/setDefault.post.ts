import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const { richMenuId, firestoreId } = body

  if (!richMenuId) {
    throw createError({ statusCode: 400, statusMessage: 'richMenuId is required' })
  }

  const db = getDb()

  // 一律反查歸屬(E-16):不論前端有沒有帶 firestoreId,這顆 LINE 選單都必須屬於
  // 這個工作區才准設為預設。之前只帶 richMenuId 就跳過驗證＝理論上可以把別家的
  // 選單設成自己帳號的預設。順帶修掉舊行為的資料缺口:只帶 richMenuId 時
  // isDefault 旗標不會被寫,列表看不出哪顆是預設。
  let menuDocId = typeof firestoreId === 'string' && firestoreId ? firestoreId : ''
  let menuName = ''
  if (menuDocId) {
    const menu = await getDoc<{ workspaceId?: string; richMenuId?: string; name?: string }>('richmenus', menuDocId)
    if (!menu || menu.workspaceId !== workspaceId) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }
    menuName = menu.name ?? ''
  }
  else {
    const snap = await db
      .collection('richmenus')
      .where('workspaceId', '==', workspaceId)
      .where('richMenuId', '==', richMenuId)
      .limit(1)
      .get()
    if (snap.empty) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }
    menuDocId = snap.docs[0]!.id
    menuName = (snap.docs[0]!.data() as any)?.name ?? ''
  }

  await setDefaultRichMenu(richMenuId, workspaceId)

  const prev = await db
    .collection('richmenus')
    .where('workspaceId', '==', workspaceId)
    .where('isDefault', '==', true)
    .get()
  const batch = db.batch()
  prev.docs.forEach((d) => batch.update(d.ref, { isDefault: false }))
  await batch.commit()

  await updateDoc('richmenus', menuDocId, { isDefault: true })

  // 稽核(C-31 Phase 0):「設為預設」全體好友的選單即時換掉,屬於要留紀錄的那種操作
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'richmenu/setDefault',
    before: { defaultMenus: prev.docs.map(d => (d.data() as any)?.name ?? d.id) },
    after: { defaultMenu: menuName || menuDocId, richMenuId },
  }, db)

  return { success: true }
})
