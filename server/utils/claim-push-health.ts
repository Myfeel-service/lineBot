/**
 * 活動推播「已回應」蓋章的健康狀態。
 *
 * 背景：活動／加好友推播送出後，系統要在會話上蓋一個「這場我回過了」的章
 * （enterModule 的 system_notice），否則會話會一直掛在「待處理」——客服每天看到一堆
 * 其實不用處理的待辦。實測這一步曾經安靜地壞掉：錯誤被 try/catch 吞掉只寫進伺服器日誌，
 * 後台完全看不出來（2026-08 抽查同一活動 40 筆，只有 11 筆蓋到章）。
 *
 * 所以蓋章失敗要留一個後台看得到的痕跡。設計成「每個工作區一筆狀態」而不是逐筆記在
 * leadClaim 上，是為了讓異常提醒中心只花一次點讀就能判斷（那支端點會被輪詢），
 * 而且下一次蓋章成功就自動清掉、紅點自己消失。
 *
 * 慣例同 cronState：一份文件內用 { [workspaceId]: {...} } 分租戶。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'

const STATE_COLLECTION = 'cronState'
const STATE_DOC = 'claim-push-mark'

/** 超過這個時間的失敗不再示警：已經過去的事就別一直掛紅點（修好後也不必手動清） */
export const CLAIM_PUSH_MARK_ALERT_WINDOW_MS = 7 * 24 * 3600_000

export interface ClaimPushMarkFailureState {
  failedAtMs: number
  count: number
  lastError: string
}

export async function recordClaimPushMarkFailure(
  db: Firestore,
  workspaceId: string,
  error: unknown,
): Promise<void> {
  const detail = String((error as Error)?.message ?? error ?? '').slice(0, 300)
  await db.collection(STATE_COLLECTION).doc(STATE_DOC).set({
    [workspaceId]: {
      failedAt: Timestamp.now(),
      // 連續失敗次數：偶發一筆與「整個活動都沒蓋到章」要能分得出來
      count: FieldValue.increment(1),
      lastError: detail,
    },
  }, { merge: true })
}

/** 蓋章成功 → 清掉該工作區的失敗狀態（紅點自己消失，不用人去按「已解決」） */
export async function clearClaimPushMarkFailure(db: Firestore, workspaceId: string): Promise<void> {
  await db.collection(STATE_COLLECTION).doc(STATE_DOC).set({
    [workspaceId]: FieldValue.delete(),
  }, { merge: true })
}

export async function readClaimPushMarkFailure(
  db: Firestore,
  workspaceId: string,
): Promise<ClaimPushMarkFailureState | null> {
  const snap = await db.collection(STATE_COLLECTION).doc(STATE_DOC).get()
  const raw = (snap.data() ?? {})[workspaceId] as
    { failedAt?: { toMillis?: () => number }; count?: number; lastError?: string } | undefined
  const failedAtMs = raw?.failedAt?.toMillis?.() ?? 0
  if (!failedAtMs) return null
  return {
    failedAtMs,
    count: Number(raw?.count ?? 1),
    lastError: String(raw?.lastError ?? ''),
  }
}
