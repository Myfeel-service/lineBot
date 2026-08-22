import type { SetupItemStatus, SetupStatusItem, SetupStatusResponse } from '~~/shared/types/setup'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { loadActiveScripts } from '~~/server/utils/ai-scripts'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { checkLineWebhook } from '~~/server/utils/workspace-alerts'

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
    // 已接 LINE。
    //
    // ── 2026-08-21 老闆拍板改口徑（`D-15`(b)）───────────────────────────────
    // 舊定義是「Token / Secret 兩個欄位都有值」，於是**憑證貼了但 LINE 後台根本沒設
    // 收訊網址**的帳號會被判成已完成：開通引導的入口就此消失，小幫手還會照著這個訊號
    // 說「客人的訊息進得來」——講的是一件沒人驗過的事。
    // 新定義＝真的去問 LINE：網址有設、開關有開，才算接上。
    //
    // ⚠️ 「網址不一致」仍算完成：那代表 LINE 填的是別的網址（多半是舊網域），訊息
    //    目前照樣進得來，只是遲早會斷——那是另一顆紅色警示（lineWebhookUrlMismatch）
    //    在講的事，不該讓這個帳號回到「還沒接上 LINE」的狀態。
    // ⚠️ 問不到 LINE（我方連不出去、LINE 忙）→ 丟錯讓它變 unknown，畫面誠實說
    //    「這次查不到」。⛔ 不可以退回舊的「有欄位就算接上」——那正是要修掉的謊。
    // 成本：checkLineWebhook 與右下角小幫手共用同一份 5 分鐘快取，不會多打 LINE。
    // 預設 LIFF 2026-08-07 拍板拆成獨立加分項 liffReady——多數新客戶第一天用不到，
    // 缺它不該讓人永遠掛在「LINE 未接通」。
    resolve(async () => {
      const snap = await workspaceSnap
      const w = snap.exists ? (snap.data() as Record<string, unknown>) : null
      const hasCredentials = !!String(w?.channelAccessToken ?? '').trim()
        && !!String(w?.channelSecret ?? '').trim()
      // 憑證都還沒貼＝這一步就是還沒做，不必去問 LINE
      if (!hasCredentials) return false
      const check = await checkLineWebhook(wid, false)
      return check.kind === 'ok' || check.kind === 'mismatch'
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
