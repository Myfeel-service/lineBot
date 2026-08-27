import { FieldValue } from 'firebase-admin/firestore'
import type { DocumentReference } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { SCRIPTS_COLLECTION, invalidateScriptsCache } from '~~/server/utils/ai-scripts'
import { invalidateScriptHealthCache } from '~~/server/utils/script-health'
import {
  invalidateBrokenModuleRefsCache,
  replaceModuleRefs,
  scanModuleGraph,
} from '~~/server/utils/broken-module-refs'
import type { BrokenModuleRepointResult } from '~~/shared/types/alert-fix'

/**
 * POST /api/admin/broken-module-fix
 *
 * 「按鈕指到已刪除／已停用模組」的兩個確定性修法（C-87，引導劇本按確認後才打）：
 *
 *   { action: 'reenable', moduleId }
 *     模組還在只是停用 → 重新啟用它。一筆寫入，四種引用（選單／模組／流程／活動）同時復活。
 *
 *   { action: 'repoint', fromModuleId, toModuleId }
 *     模組已刪除（或使用者選擇不復活停用的那個）→ 把指向它的引用整批改指到另一個**啟用中**的模組。
 *
 * ⛔ 三道守門（2026-08-27 code review 補上，缺一不可）：
 *   1. **`from` 必須真的有壞掉的引用**：只驗 `to` 的話，這支就是「把任何模組的所有引用整批
 *      改掉」的通用改寫器——沒有預覽、沒有還原，原本指向哪只剩稽核紀錄裡那一行。
 *   2. **`to` 必須是本工作區啟用中的模組**（伺服器端自己再查一次，不信前端傳來的 ID）。
 *   3. **圖文選單不代改**：選單按鈕的資料是發佈時燒進 LINE 的，只改資料庫、線上那顆按鈕
 *      照樣送舊 ID——靜默改庫會製造「系統說修好了、客人按了還是沒反應」的假修復。
 *      回傳 `richmenus`（還指著舊模組的選單名單），由劇本引導去選單頁改完重新發佈。
 *
 * 寫入走 **WriteBatch**：一次 commit、要嘛全成要嘛全不成，不會留下「一半改了、一半沒改」
 * 的狀態；快取失效放 `finally`，即使 commit 丟錯也不會讓熱路徑抱著舊腳本跑五分鐘。
 * 零 LLM。
 */

/** 單一批次上限（Firestore 硬上限 500，留餘裕）；超過就分批，分批時原子性只在批內 */
const BATCH_LIMIT = 400

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'admin')
  const body = await readBody(event).catch(() => ({}))
  const action = String(body?.action ?? '').trim()
  const db = getDb()

  if (action === 'reenable') {
    const moduleId = String(body?.moduleId ?? '').trim()
    if (!moduleId) throw createError({ statusCode: 400, statusMessage: 'moduleId required' })
    const ref = db.collection('flows').doc(moduleId)
    const snap = await ref.get()
    if (!snap.exists || (snap.data() as Record<string, unknown>).workspaceId !== workspaceId)
      throw createError({ statusCode: 404, statusMessage: '找不到這個模組（可能已被刪除）' })
    const name = String((snap.data() as Record<string, unknown>).name ?? '(未命名模組)')
    // 冪等：已經是啟用就不寫（重按不算錯）
    if ((snap.data() as Record<string, unknown>).isActive !== true) {
      await ref.update({ isActive: true, updatedAt: FieldValue.serverTimestamp() })
      await writeAuditLog({
        workspaceId,
        uid,
        actor: 'human',
        action: 'alert-fix/broken-module-reenable',
        before: { isActive: false },
        after: { isActive: true },
        note: `重新啟用模組「${name}」`,
      }, db)
    }
    invalidateBrokenModuleRefsCache(workspaceId)
    return { ok: true, moduleName: name }
  }

  if (action === 'repoint') {
    const from = String(body?.fromModuleId ?? '').trim()
    const to = String(body?.toModuleId ?? '').trim()
    if (!from || !to) throw createError({ statusCode: 400, statusMessage: 'fromModuleId 與 toModuleId 都要帶' })
    if (from === to) throw createError({ statusCode: 400, statusMessage: '新舊模組不能是同一個' })

    // ── 守門①：from 必須真的有壞掉的引用（skipCache＝拿現在的實況，不吃五分鐘快取）──
    const scan = await scanModuleGraph(db, workspaceId, { skipCache: true })
    const brokenRefs = scan.refs.filter(r => r.moduleId === from)
    if (!brokenRefs.length) {
      throw createError({
        statusCode: 409,
        statusMessage: '這個模組現在沒有任何壞掉的引用（可能有人剛處理過），請重新檢查一次再修。',
      })
    }

    // ── 守門②：to 必須是本工作區啟用中的模組（用同一次掃描的結果，不再多查一趟）──
    const target = scan.modules.find(m => m.id === to)
    if (!target?.isActive)
      throw createError({ statusCode: 400, statusMessage: '要指過去的模組不存在或未啟用，請重新選擇' })
    const toName = target.name

    const [scriptsSnap, campaignsSnap, flowsSnap] = await Promise.all([
      db.collection(SCRIPTS_COLLECTION).where('workspaceId', '==', workspaceId).get(),
      // ⛔不用 where('moduleId','==',from)：偵測端是 trim 過再比的，等值查詢比不到
      // 「'abc ' 帶尾空白」那種資料 → 偵測說它壞了、代改卻永遠改不到，驗證會一直失敗
      db.collection('leadCampaigns').where('workspaceId', '==', workspaceId).get(),
      db.collection('flows').where('workspaceId', '==', workspaceId).get(),
    ])

    const writes: { ref: DocumentReference; data: Record<string, unknown> }[] = []
    let scripts = 0
    let campaigns = 0
    let flows = 0
    let hiddenDisabled = 0

    // 客服流程的「機器人模組」步驟。停用中的流程也一起改（之後被打開不該又冒出同一顆壞按鈕），
    // 但它們不在使用者看到的清單上 → 算進 hiddenDisabled 分開回報，不混進 scripts
    for (const d of scriptsSnap.docs) {
      const data = d.data() as Record<string, unknown>
      if (!Array.isArray(data.nodes)) continue
      const r = replaceModuleRefs(data.nodes, from, to)
      if (!r.changed) continue
      writes.push({ ref: d.ref, data: { nodes: r.value, updatedAt: FieldValue.serverTimestamp() } })
      if (data.enabled === false) hiddenDisabled++
      else scripts++
    }

    // 活動（moduleId 是頂層欄位；trim 後比對，理由見上面的查詢註解）
    for (const d of campaignsSnap.docs) {
      const data = d.data() as Record<string, unknown>
      if (String(data.moduleId ?? '').trim() !== from) continue
      writes.push({ ref: d.ref, data: { moduleId: to, updatedAt: FieldValue.serverTimestamp() } })
      if (data.isActive === false) hiddenDisabled++
      else campaigns++
    }

    // 別的模組的圖文訊息裡指向它的按鈕（深走訪，兩種形態都認）
    for (const d of flowsSnap.docs) {
      if (d.id === from) continue
      const data = d.data() as Record<string, unknown>
      const r = replaceModuleRefs(data.messages, from, to)
      if (!r.changed) continue
      writes.push({ ref: d.ref, data: { messages: r.value, updatedAt: FieldValue.serverTimestamp() } })
      if (data.isActive === false) hiddenDisabled++
      else flows++
    }

    // 圖文選單只盤點不改（守門③）：名單直接取自剛剛那次掃描，不再重讀 richmenus
    const richmenus = [...new Set(
      brokenRefs.filter(r => r.sourceKind === 'richmenu').map(r => r.sourceLabel),
    )]

    try {
      for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
        const batch = db.batch()
        for (const w of writes.slice(i, i + BATCH_LIMIT)) batch.update(w.ref, w.data)
        await batch.commit()
      }
    }
    finally {
      // 失效一定要跑，即使 commit 丟錯：部分批次可能已經進去了，熱路徑抱著舊腳本
      // 跑五分鐘的話，資料庫已修好、客人按了還是沒反應
      invalidateScriptsCache(workspaceId)
      invalidateScriptHealthCache(workspaceId)
      invalidateBrokenModuleRefsCache(workspaceId)
    }

    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'alert-fix/broken-module-repoint',
      before: { moduleId: from },
      after: { moduleId: to },
      note: `壞按鈕改指向「${toName}」：流程 ${scripts}、活動 ${campaigns}、模組訊息 ${flows}`
        + (hiddenDisabled ? `、停用中設定 ${hiddenDisabled}` : '')
        + (richmenus.length ? `；選單 ${richmenus.length} 個待手動重發佈` : ''),
    }, db)

    return { ok: true, toName, scripts, campaigns, flows, hiddenDisabled, richmenus } satisfies BrokenModuleRepointResult
  }

  throw createError({ statusCode: 400, statusMessage: `未知的動作：${action.slice(0, 40)}` })
})
