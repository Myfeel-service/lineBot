import { FieldValue } from 'firebase-admin/firestore'
import type { Firestore, WriteBatch } from 'firebase-admin/firestore'

/**
 * ⛔ **「歡迎模組」2026-09-21 拿掉了（`D-23` 拍板）**，這裡刻意只剩一個。
 *
 * 為什麼：那顆系統模組**沒有任何執行路徑**——`systemModuleId(..., 'welcome')` 在 `server/`
 * 從來沒有被讀過（只有 `live_agent` 在轉真人時會讀）。加好友歡迎走的是
 * 「自動回應 → 客人加好友時」的腳本（08-22 `C-56`）。於是它是個**死胡同**：
 * 導覽叫人把內容編進去、編完等客人加好友，**什麼都不會發生，畫面上零線索**。
 * 正式庫查證時 MYFEEL 那顆是空的（0 則訊息），所以拿掉零損失。
 *
 * ⛔ 不要為了「相容」把它加回來：真正的入口是 `shared/follow-welcome.ts` 那一列。
 */
const SYSTEM_MODULE_DEFS = [
  { type: 'live_agent' as const, name: '真人客服' },
] as const

/**
 * 現在還會自動補建的系統模組種類。
 * ⛔ 判斷「缺了哪一個要補建」一律用這個，**不要用清單的排序陣列**——
 *    那份為了讓舊資料還排得對，`welcome` 仍然留著，拿它來判斷會變成永遠補建一顆死模組。
 */
export const ACTIVE_SYSTEM_MODULE_TYPES = SYSTEM_MODULE_DEFS.map(d => d.type)

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
