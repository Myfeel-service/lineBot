import type { DocumentReference } from 'firebase-admin/firestore'
import { nextScannerHealth, readScannerHealth } from '~~/shared/scanner-health'

/**
 * 把「這台掃描器這輪炸了」記在它自己的狀態文件上（`C-68` 的治本）。
 *
 * 規則與資料形狀見 shared/scanner-health.ts。這裡只做寫入那一段：
 * 先讀回目前的 health 才寫，是為了保住 `failingSinceMs`（第一次連續失敗的時間）——
 * 不讀的話每次失敗都會把它刷成「現在」，「壞多久了」永遠是 0 分鐘，異常永遠不會觸發。
 *
 * ⛔ 記錄失敗這件事本身失敗了，**不能再往外丟**：呼叫端已經在 catch 裡了，
 *    在那裡拋例外會讓整支排程的迴圈中斷（一個工作區壞掉拖垮其他人）。
 */
export async function recordScannerFailure(ref: DocumentReference, error: unknown): Promise<void> {
  try {
    const snap = await ref.get()
    const current = readScannerHealth(snap.data() as Record<string, unknown> | undefined)
    const next = nextScannerHealth(current, { ok: false, error })
    if (next) await ref.set({ health: next }, { merge: true })
  }
  catch (e) {
    console.warn('[scanner-health] 記錄失敗狀態時又失敗了:', e)
  }
}
