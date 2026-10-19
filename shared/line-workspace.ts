/**
 * Firestore `workspaces/{id}` 文件（預設 id：`default`）
 * 用於單一部署先存一組 LINE OA，之後可擴充多 workspace。
 */
export type LineWorkspaceDoc = {
  name?: string
  channelAccessToken?: string
  channelSecret?: string
  /** 活動未填 liffId 時可 fallback（選填） */
  defaultLiffId?: string
  /**
   * 這組憑證屬於哪個 LINE 官方帳號（LINE 側的 bot userId）。存憑證時順手問 LINE 記下來，
   * 用途只有一個：回答「有沒有別的工作區也接著同一個官方帳號」——兩邊都接的話，
   * 客人訊息只會進到 webhook 簽章先對上的那一邊，另一邊看起來一切正常卻一則都收不到。
   * 舊資料沒有這個欄位是正常的，第一次檢查時會補上。
   */
  lineBotUserId?: string
  /** 所屬組織 ID（選填；未設定時為獨立 workspace） */
  organizationId?: string
  updatedAt?: unknown
}

export const DEFAULT_LINE_WORKSPACE_ID = 'default'

/**
 * 「清除已儲存的憑證」之前要打一次帳號名稱（`D-35`，2026-10-20 老闆照建議重新打開那顆鈕）。
 * 清掉之後這個帳號就收不到、也回不了客人的 LINE 訊息——打名字是確認「清的是這一個」，不是手滑。
 * 前端（對話框的檢查）與後端（端點再驗一次）同一支，⛔ 別各寫一份。
 * 比對：前後空白不算、其他一字不差（大小寫也算——名字是店家自己取的，照他看到的打）。
 * 帳號沒取過名字時，名字就是帳號 id（跟帳號清單、頁首顯示的同一個值）。
 */
export function clearCredentialsNameMatches(typed: unknown, accountName: string): boolean {
  const want = String(accountName ?? '').trim()
  return !!want && String(typed ?? '').trim() === want
}

/**
 * Firestore `users/*`、`conversations/*` 主鍵（與 migrate-add-workspaceId、sync-from-line 一致）。
 * @param lineUserId LINE `source.userId`（或已是 `default_U…` 主鍵時原樣回傳）
 */
export function lineUserFirestoreDocId(
  lineUserId: string,
  workspaceId: string = DEFAULT_LINE_WORKSPACE_ID,
): string {
  const prefix = `${workspaceId}_`
  if (lineUserId.startsWith(prefix)) return lineUserId
  return `${workspaceId}_${lineUserId}`
}

/** 由 users / conversations 主鍵還原 LINE userId */
export function lineUserIdFromFirestoreDocId(
  docId: string,
  workspaceId: string = DEFAULT_LINE_WORKSPACE_ID,
): string {
  const prefix = `${workspaceId}_`
  if (docId.startsWith(prefix)) return docId.slice(prefix.length)
  return docId
}
