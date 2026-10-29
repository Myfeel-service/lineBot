import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { taipeiDateKey } from '~~/shared/taipei-day'

/**
 * 每個機器人模組「近 30 天幾位客人收到」（`C-425`）。
 *
 * **為什麼要有**：模組頁只看得到「哪裡連到它」，看不出客人到底有沒有在用——MYFEEL 17 個商品做了 48 個模組，
 * 2026-10-29 唯讀盤點近 30 天只有 16 個被點過，店家自己完全看不出來。
 *
 * **怎麼記**：模組因為客人的動作送出去的那一刻（按按鈕／圖文選單、打關鍵字、加好友、用戶輸入接下一個），
 * 在「這個帳號、這一天」那份文件上加一筆：送了幾次、送給了誰（LINE 編號，算幾位用）。
 * ⛔ 不能開頁時才去翻對話算：MYFEEL 30 天就要讀 1 萬 5 千則訊息，每開一次頁就一次（資料庫讀取已經是最大一筆開銷）。
 * ⛔ 推播、試發不記：那是店家推出去的，不是客人用到。
 *
 * **怎麼讀**：30 份日文件用 getAll 一次拿（30 次讀取），不用建索引。
 * ⚠️ 從上線那天才開始記：還不滿 30 天的時候回 `trackedSince`，畫面要講「從哪天起」，⛔ 不可以說成「近 30 天」。
 */
export const FLOW_USAGE_COLLECTION = 'flowUsageDaily'
export const FLOW_USAGE_WINDOW_DAYS = 30
/** 文件上的到期時間：留 40 天就夠算 30 天（之後設 TTL 自動清；沒設也只是一天一份小文件） */
const KEEP_DAYS = 40

function usageDocId(workspaceId: string, dayKey: string): string {
  return `${workspaceId}_${dayKey}`
}

/**
 * 記一筆。⛔ 永遠不丟錯：記帳失敗不可以影響客人收到回覆（呼叫端在回覆送出之後才叫）。
 * 失敗會留 log——少記一筆比擋住回覆好，但要查得到。
 */
export async function recordModuleSent(workspaceId: string, moduleId: string, lineUserId: string, now = new Date()): Promise<void> {
  const wid = String(workspaceId || '').trim()
  const mid = String(moduleId || '').trim()
  const uid = String(lineUserId || '').trim()
  if (!wid || !mid || !uid) return
  const dayKey = taipeiDateKey(now)
  try {
    await getDb().collection(FLOW_USAGE_COLLECTION).doc(usageDocId(wid, dayKey)).set({
      workspaceId: wid,
      day: dayKey,
      expireAt: Timestamp.fromMillis(now.getTime() + KEEP_DAYS * 86_400_000),
      // 巢狀物件＋merge：模組編號不經過欄位路徑字串解析（編號裡有底線、橫線都安全）
      modules: { [mid]: { sends: FieldValue.increment(1), users: FieldValue.arrayUnion(uid) } },
    }, { merge: true })
  }
  catch (e) {
    console.error('[flow-usage] record failed:', wid, mid, e)
  }
}

export interface FlowUsageSummary {
  /** 算的是哪幾天（台北日期，含頭尾） */
  from: string
  to: string
  /**
   * 最早有紀錄的那一天；比 `from` 晚＝還沒記滿 30 天，畫面要講「從哪天起」。
   * null＝這段期間一筆都沒有（剛上線，或真的沒有客人觸發任何模組）。
   */
  trackedSince: string | null
  /** 模組編號 → 幾位客人收到（不重複）、送了幾次 */
  modules: Record<string, { users: number, sends: number }>
}

export async function readFlowUsage(workspaceId: string, now = new Date()): Promise<FlowUsageSummary> {
  const wid = String(workspaceId || '').trim()
  // 今天往回 30 個台北日期（台灣沒有日光節約，一天固定 24 小時）
  const days = Array.from({ length: FLOW_USAGE_WINDOW_DAYS }, (_, i) =>
    taipeiDateKey(new Date(now.getTime() - (FLOW_USAGE_WINDOW_DAYS - 1 - i) * 86_400_000)))
  const db = getDb()
  const snaps = await db.getAll(...days.map(d => db.collection(FLOW_USAGE_COLLECTION).doc(usageDocId(wid, d))))

  const users = new Map<string, Set<string>>()
  const sends = new Map<string, number>()
  let trackedSince: string | null = null
  snaps.forEach((snap, i) => {
    if (!snap.exists) return
    trackedSince ??= days[i]!
    const modules = (snap.get('modules') ?? {}) as Record<string, { sends?: unknown, users?: unknown }>
    for (const [mid, row] of Object.entries(modules)) {
      const set = users.get(mid) ?? new Set<string>()
      if (Array.isArray(row?.users)) for (const u of row.users) set.add(String(u))
      users.set(mid, set)
      sends.set(mid, (sends.get(mid) ?? 0) + (Number(row?.sends) || 0))
    }
  })

  const modules: FlowUsageSummary['modules'] = {}
  for (const [mid, set] of users) modules[mid] = { users: set.size, sends: sends.get(mid) ?? 0 }
  return { from: days[0]!, to: days[days.length - 1]!, trackedSince, modules }
}
