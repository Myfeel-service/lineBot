import {
  assertValidFlowMessages,
  assertValidFlowName,
} from '~~/server/utils/flow-validator'
import { getDb, getDoc } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'
import { assertPlanAllows } from '~~/server/utils/billing'
import { writeAuditLog, auditSnapshot, diffChangedFields } from '~~/server/utils/audit-log'
import { planAllowsScripting } from '~~/shared/billing/plans'
import { attachSheetSnapshots } from '~~/server/utils/sheet-field-hydrate'
import { configureSheetCatalogs } from '~~/server/utils/sheet-catalog'
import { changedMessageNumbers, messageNumbersText } from '~~/server/utils/flow-message-changes'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  // 方案功能閘門（D-69 拍板④）：流程自動化是入門方案起才有的權益，以前只印在方案表上。
  await assertPlanAllows(workspaceId, planAllowsScripting, '這個方案不含流程自動化功能，請升級方案後再使用')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const existing = await getDoc<Record<string, unknown> & { isSystem?: boolean; workspaceId?: string }>('flows', id)
  if (!existing) throw createError({ statusCode: 404, statusMessage: '找不到此模組' })
  if (existing.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此模組' })
  }

  const body = await readBody(event)
  // moduleType 刻意不從 body 取：模組類型不再可改（2026-09-21 拿掉後台選單）。
  // 舊版前端若還帶著這個欄位，這裡靜靜忽略即可——它本來就沒有正確的用法。
  const { name, messages, isActive, folderId } = body

  const updates: Record<string, unknown> = {}
  if (name !== undefined) updates.name = assertValidFlowName(name)
  if (messages !== undefined) {
    assertValidFlowMessages(messages)
    // `C-423`：用了「試算表的一格」的，記下每一格當下的內容（送出時換不到才用）
    updates.messages = await attachSheetSnapshots(messages, workspaceId)
  }
  if (isActive !== undefined) updates.isActive = isActive
  // 系統模組不分組（永遠在頂端）；只有 regular flow 可以指定 folderId
  if (folderId !== undefined && !existing.isSystem) {
    updates.folderId = folderId === null ? null : (typeof folderId === 'string' ? folderId : null)
  }
  await updateDoc('flows', id, updates)

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  // `C-436`：照試算表排的商品目錄——記下這份試算表有目錄在用、替勾進目錄的商品建標籤（失敗不擋存檔）
  if (Array.isArray(updates.messages)) await configureSheetCatalogs(getDb(), workspaceId, updates.messages as any[])

  // 稽核（`C-254`）：`isActive` 就是店家口中的「流程開關」——關掉的話客人按按鈕會沒反應。
  // ⛔ 只比摘要層（訊息內容不整包存，會被截斷）；沒有變就不寫。
  const summarize = (d: Record<string, unknown>) =>
    auditSnapshot(d, { keep: ['name', 'isActive', 'folderId'], count: ['messages'] })!
  const diff = diffChangedFields(summarize(existing), summarize({ ...existing, ...updates }))
  // `C-411`：則數沒變、只改了字／按鈕／圖——以前上面四格都一樣＝一筆都不寫，改壞了查不到誰改的。
  // 只記改了哪幾則（⛔ 不存內容）；這一格不在還原改得回的欄位裡，那筆會照實講「沒辦法一鍵還原」
  const edited = messages !== undefined ? changedMessageNumbers(existing.messages, messages) : []
  if (diff.changedKeys.length || edited.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'flow.put',
      targetId: id,
      before: edited.length ? { ...diff.before, messagesEdited: '原本的內容' } : diff.before,
      after: edited.length ? { ...diff.after, messagesEdited: `${messageNumbersText(edited)}改過了` } : diff.after,
      note: String(existing.name ?? ''),
    })
  }

  return { id, ...updates }
})
