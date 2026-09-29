import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import {
  normalizeSupportPreset,
  validateSupportPreset,
} from '~~/shared/support-preset'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { assertWorkspaceTagIds } from '~~/server/utils/workspace-tag-ids'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'presets.write')
  const rawBody = await readBody(event)
  const body = normalizeSupportPreset(rawBody)
  const errorMessage = validateSupportPreset(body)
  if (errorMessage) {
    throw createError({ statusCode: 400, statusMessage: errorMessage })
  }

  const id = uuidv4()
  const moduleId = body.action.type === 'module' ? body.action.moduleId : ''
  const db = getDb()
  // G-98：預存上設定的貼標只能是這個帳號自己的標籤（存的當下就擋，不要等客服按送出才靜靜少貼）
  await assertWorkspaceTagIds(db, workspaceId, body.tagging.addTagIds, 'support-preset/create')
  await db.collection('supportPresets').doc(id).set({
    name: body.name,
    action: body.action,
    moduleId,
    isActive: body.isActive,
    tagging: body.tagging,
    workspaceId,
    createdAt: FieldValue.serverTimestamp(),
  })

  // 稽核（`C-254`）：常用語是客服一按就送到客人眼前的東西
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'supportPreset.create',
    targetId: id,
    after: { name: body.name, isActive: body.isActive, type: body.action.type },
  }, db)

  return {
    id,
    name: body.name,
    action: body.action,
    moduleId,
    isActive: body.isActive,
    tagging: body.tagging,
  }
})
