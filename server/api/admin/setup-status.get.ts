import type { Firestore } from 'firebase-admin/firestore'
import type { SetupItemStatus, SetupStatusItem, SetupStatusResponse } from '~~/shared/types/setup'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { countUsableChunks } from '~~/server/utils/ai-knowledge-quota'
import { loadActiveScripts } from '~~/server/utils/ai-scripts'
import { hasReceivedPeerMessage } from '~~/server/utils/conversation-peer-activity'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { checkLineWebhook } from '~~/server/utils/workspace-alerts'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { isStoreProfileReady } from '~~/shared/types/store-profile'

/**
 * GET /api/admin/setup-status?workspaceId=...[&only=knowledge]
 *
 * 依真實資料訊號判定每個設定能力是否完成，給前端的教學 agent 做「主動告知哪裡沒做完」。
 * 每個訊號各自 try/catch：單一查詢失敗只會讓該項變成 unknown，不會讓整支端點壞掉，
 * 也不會把「查不到」誤報成「沒做」。
 *
 * `knowledge`（`C-308`⑦）：知識庫現在有幾條——`live`＝AI 回客人真的用得到的（已學好的卡，`countUsableChunks`；
 * ⛔ 2026-10-17 前用的是方案空間那把尺，停用／到期／失敗的也算進去，全部停用照樣打勾）、
 * `drafts`＝還在「等你看過」的；null＝這次查不到（⛔ 不可以當成 0）。
 * AI 設定頁「知識庫有內容（目前 N 條）」、小幫手「帶你放進第一份知識」都讀這一份，
 * 跟開通清單的「建立知識庫」打勾是**同一個數字**（以前三處各自加總資料的條數，連等你看過都算進去）。
 * `only=knowledge`：只要這一項（不去問 LINE、不讀其他設定）。
 */
export interface SetupKnowledgeCounts {
  live: number
  drafts: number
}

/** 把一個布林判定包成 done/incomplete；丟錯則降級為 unknown（狀態未知，不等於沒做） */
async function resolve(check: () => Promise<boolean>): Promise<SetupItemStatus> {
  try {
    return (await check()) ? 'done' : 'incomplete'
  }
  catch {
    return 'unknown'
  }
}

/**
 * 「等你看過」幾條：一個 count() 聚合（兩個等值條件，跟 countWorkspaceChunks 用的同一種查詢）。
 * ⚠️ 回收桶裡的草稿不會重複算：軟刪除會把 status 改成 disabled（見 countWorkspaceChunks 的說明）。
 */
async function loadKnowledgeCounts(wid: string, db: Firestore): Promise<SetupKnowledgeCounts> {
  const [live, drafts] = await Promise.all([
    countUsableChunks(wid, db),
    db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
      .where('workspaceId', '==', wid)
      .where('status', '==', 'draft')
      .count()
      .get()
      .then(a => a.data().count),
  ])
  return { live, drafts }
}

export default defineEventHandler(async (event): Promise<SetupStatusResponse & { knowledge: SetupKnowledgeCounts | null }> => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')
  const wid = String(workspaceId || '').trim()
  if (!wid)
    throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const db = getDb()
  // 一次查、兩處用（knowledgeReady 的打勾與回傳的 knowledge）；查不到 → 打勾那項 unknown、knowledge 給 null
  const knowledgeCounts = loadKnowledgeCounts(wid, db)
  const knowledgeOrNull = knowledgeCounts.catch(() => null)

  if (String(getQuery(event).only ?? '') === 'knowledge') {
    const knowledge = await knowledgeOrNull
    const status: SetupItemStatus = !knowledge ? 'unknown' : knowledge.live > 0 ? 'done' : 'incomplete'
    return { workspaceId: wid, items: [{ id: 'knowledgeReady', status }], knowledge }
  }

  // lineConnected / liffReady 共用同一次文件讀取（兩個訊號、一次 read）
  const workspaceSnap = db.collection('workspaces').doc(wid).get()

  const [lineConnected, liffReady, aiEnabled, knowledgeReady, scriptReady, profileReady, firstMessageReceived] = await Promise.all([
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
    // 知識庫有內容＝**AI 真的拿得到的**至少一條（`C-308`⑦，2026-10-13）。
    // ⛔ 以前是「這個帳號有任何一條」——開帳整理出來還在「等你看過」的、回收桶裡的都算，
    //    新帳號一條都還沒採用，開通清單就勾了「建立知識庫」、小幫手也不再說知識庫是空的，打開 AI 一題都答不出來。
    // 「拿得到」＝已學好的卡（countUsableChunks，跟回客人的檢索同一個條件）。
    // ⛔ 2026-10-17 前用方案空間那把尺（countWorkspaceChunks）：停用、到期下架、處理失敗的也算，
    //    全部停用或全部失敗照樣打勾——同一個「打開 AI 一題都答不出來」的洞，換了個入口。
    resolve(async () => (await knowledgeCounts).live > 0),
    // 有啟用中的客服腳本：沿用既有 loadActiveScripts（已過濾 enabled）
    resolve(async () => {
      const scripts = await loadActiveScripts(wid, db)
      return scripts.length > 0
    }),
    // MiniMe 認識這家店了沒（`D-85`）。
    // ⛔ 口徑不是「有沒有 storeProfiles 這份文件」——AI 讀網站也會建出文件，
    //    用存在與否判定等於商家一題沒答也算認識，就緒度就會說謊（`D-23` 那次
    //    `scriptReady` 七條全綠卻沒有一條是加好友，是同一種假綠燈）。
    //    真正的口徑寫在 `isStoreProfileReady`：五題裡商家**親自**答了三題以上。
    resolve(async () => {
      const profile = await getStoreProfile(wid, db)
      return isStoreProfileReady(profile)
    }),
    // 曾收到客人訊息：lastPeerActivityAt 只在「客人真的傳了訊息」時寫入
    // （加好友的 customer_action 是 traceOnly，不會蓋這個欄位——加了好友沒開口不算）。
    // 口徑與開通引導的見證時刻共用 findLatestPeerActiveConversation，別在這裡各寫一份。
    resolve(() => hasReceivedPeerMessage(db, wid)),
  ])

  const items: SetupStatusItem[] = [
    { id: 'lineConnected', status: lineConnected },
    { id: 'liffReady', status: liffReady },
    { id: 'aiEnabled', status: aiEnabled },
    { id: 'knowledgeReady', status: knowledgeReady },
    { id: 'scriptReady', status: scriptReady },
    { id: 'profileReady', status: profileReady },
    { id: 'firstMessageReceived', status: firstMessageReceived },
  ]

  return { workspaceId: wid, items, knowledge: await knowledgeOrNull }
})
