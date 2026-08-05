import { FieldValue } from 'firebase-admin/firestore'
import type { Firestore, WriteBatch } from 'firebase-admin/firestore'

const SYSTEM_MODULE_DEFS = [
  { type: 'welcome' as const, name: '歡迎模組' },
  { type: 'live_agent' as const, name: '真人客服' },
] as const

/**
 * 系統模組的 flows doc id。**這是唯一的組法**——別在別處自己拼，也別拿
 * SYSTEM_MODULE_IDS（'sys_live_agent'）當 doc id 去查：那是「模組種類代號」，
 * 不是文件 id，查了永遠是 null（實測後果：店家在後台設的「真人客服」文案從來沒送出去過，
 * 客人一律收到程式裡的預設句）。
 */
export function systemModuleId(workspaceId: string, type: 'welcome' | 'live_agent') {
  return `${workspaceId}_${type}`
}

/** Add both system module docs to an existing batch (used during workspace creation). */
export function addSystemModulesToBatch(db: Firestore, batch: WriteBatch, workspaceId: string) {
  for (const def of SYSTEM_MODULE_DEFS) {
    const id = systemModuleId(workspaceId, def.type)
    batch.set(db.collection('flows').doc(id), {
      workspaceId,
      name: def.name,
      moduleType: def.type,
      isSystem: true,
      messages: [],
      isActive: true,
      createdAt: FieldValue.serverTimestamp(),
    })
  }
}

/** Idempotent: creates missing system modules for a workspace. Returns what was created. */
export async function seedWorkspaceSystemModules(db: Firestore, workspaceId: string) {
  const results: Array<{ id: string; created: boolean }> = []
  for (const def of SYSTEM_MODULE_DEFS) {
    const id = systemModuleId(workspaceId, def.type)
    const ref = db.collection('flows').doc(id)
    const snap = await ref.get()
    if (!snap.exists) {
      await ref.set({
        workspaceId,
        name: def.name,
        moduleType: def.type,
        isSystem: true,
        messages: [],
        isActive: true,
        createdAt: FieldValue.serverTimestamp(),
      })
      results.push({ id, created: true })
    }
    else {
      results.push({ id, created: false })
    }
  }
  return results
}
