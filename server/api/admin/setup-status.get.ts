import type { SetupItemStatus, SetupStatusItem, SetupStatusResponse } from '~~/shared/types/setup'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { loadActiveScripts } from '~~/server/utils/ai-scripts'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/**
 * GET /api/admin/setup-status?workspaceId=...
 *
 * 依真實資料訊號判定每個設定能力是否完成，給前端的教學 agent 做「主動告知哪裡沒做完」。
 * 每個訊號各自 try/catch：單一查詢失敗只會讓該項變成 unknown，不會讓整支端點壞掉，
 * 也不會把「查不到」誤報成「沒做」。
 */

/** 把一個布林判定包成 done/incomplete；丟錯則降級為 unknown（狀態未知，不等於沒做） */
async function resolve(check: () => Promise<boolean>): Promise<SetupItemStatus> {
  try {
    return (await check()) ? 'done' : 'incomplete'
  }
  catch {
    return 'unknown'
  }
}

export default defineEventHandler(async (event): Promise<SetupStatusResponse> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const wid = String(workspaceId || '').trim()
  if (!wid)
    throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const db = getDb()

  // lineConnected / liffReady 共用同一次文件讀取（兩個訊號、一次 read）
  const workspaceSnap = db.collection('workspaces').doc(wid).get()

  const [lineConnected, liffReady, aiEnabled, knowledgeReady, scriptReady, firstMessageReceived] = await Promise.all([
    // 已接 LINE：Token / Secret 都有（與組織頁的儲存條件、org 總覽同一個定義）。
    // 預設 LIFF 2026-08-07 拍板拆成獨立加分項 liffReady——多數新客戶第一天用不到，
    // 缺它不該讓人永遠掛在「LINE 未接通」。
    resolve(async () => {
      const snap = await workspaceSnap
      const w = snap.exists ? (snap.data() as Record<string, unknown>) : null
      return (
        !!String(w?.channelAccessToken ?? '').trim()
        && !!String(w?.channelSecret ?? '').trim()
      )
    }),
    // 已設定預設 LIFF（活動頁 / 綁定頁入口）
    resolve(async () => {
      const snap = await workspaceSnap
      const w = snap.exists ? (snap.data() as Record<string, unknown>) : null
      return !!String(w?.defaultLiffId ?? '').trim()
    }),
    // 已開 AI 自動回覆
    resolve(async () => {
      const s = await getAiSettings(wid, db)
      return s.enabled === true
    }),
    // 知識庫有內容：存在任一筆此 workspace 的知識片段（單欄位查詢，免複合索引）
    resolve(async () => {
      const snap = await db
        .collection(KNOWLEDGE_CHUNKS_COLLECTION)
        .where('workspaceId', '==', wid)
        .limit(1)
        .get()
      return !snap.empty
    }),
    // 有啟用中的客服腳本：沿用既有 loadActiveScripts（已過濾 enabled）
    resolve(async () => {
      const scripts = await loadActiveScripts(wid, db)
      return scripts.length > 0
    }),
    // 曾收到客人訊息：lastPeerActivityAt 只在「客人真的傳了訊息」時寫入
    // （加好友的 customer_action 是 traceOnly，不會蓋這個欄位——加了好友沒開口不算）。
    // 單欄位 equality 查詢免索引；掃前 20 筆對話在記憶體判定即可：
    // 有在營運的帳號前幾筆一定有人講過話，全新帳號本來就只有零星幾筆。
    resolve(async () => {
      const snap = await db
        .collection('conversations')
        .where('workspaceId', '==', wid)
        .limit(20)
        .get()
      return snap.docs.some(d => d.data()?.lastPeerActivityAt != null)
    }),
  ])

  const items: SetupStatusItem[] = [
    { id: 'lineConnected', status: lineConnected },
    { id: 'liffReady', status: liffReady },
    { id: 'aiEnabled', status: aiEnabled },
    { id: 'knowledgeReady', status: knowledgeReady },
    { id: 'scriptReady', status: scriptReady },
    { id: 'firstMessageReceived', status: firstMessageReceived },
  ]

  return { workspaceId: wid, items }
})
