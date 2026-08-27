import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { scanModuleGraph } from '~~/server/utils/broken-module-refs'
import type { BrokenModuleFixState } from '~~/shared/types/alert-fix'

/**
 * GET /api/admin/broken-module-fix
 *
 * 「按鈕指到已刪除／已停用模組」引導劇本（C-87）的現況查詢：
 *   refs    —— 壞掉的引用（與異常中心**同一個偵測**，附上被指模組的名稱）
 *   modules —— 啟用中的模組白名單（劇本的「改指到哪」只准從這裡挑，⛔不收自由輸入的 ID）
 *
 * 兩份資料來自**同一次掃描**（scanModuleGraph）：分兩支查詢曾讓兩者對不上——
 * 名稱那趟帶著 limit(200)，模組多的工作區會出現「異常說它壞了，卻挑不到要指過去的模組」。
 * skipCache：這支只在有人開劇本修東西時被打，修完回頭驗證要看得到剛剛的結果。
 */
export default defineEventHandler(async (event): Promise<BrokenModuleFixState> => {
  // 與異常註冊表同一把尺：brokenModuleButton 是 settings 級（動的是選單／模組這類門面設定）
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const scan = await scanModuleGraph(getDb(), workspaceId, { skipCache: true })

  const nameById = new Map(scan.modules.map(m => [m.id, m]))
  return {
    // 停用的模組還在、查得到名字（「模組『X』只是停用了」比裸 ID 好懂）；刪掉的查不到就不硬掰
    refs: scan.refs.map(r => ({ ...r, moduleName: nameById.get(r.moduleId)?.name ?? '' })),
    modules: scan.modules.filter(m => m.isActive).map(m => ({ id: m.id, name: m.name })),
  }
})
