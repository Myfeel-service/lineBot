/**
 * 「從 Google 雲端硬碟挑一份試算表」（`C-299`）：挑完那一下，在店家的瀏覽器裡用他剛給的 `drive.file`
 * 授權，把那一份共用給系統帳號（檢視者）。之後同步照舊用系統帳號讀——跟是誰挑的無關、我們不存任何人的授權
 * （為什麼不存：`docs/KB-IMPORT-DECISIONS-FOLLOWUP-EVAL-20261012.md` 第五節）。
 *
 * 這裡只放純函式：Google 回的錯誤要翻成「店家下一步該做什麼」，而那是從 Google 的錯誤代碼猜的——
 * 跟 `gsheet-probe-status` 同一個理由，猜法要有測試釘住，免得哪天 Google 換說法，畫面叫人去做錯的事。
 */

/** 挑檔＋共用失敗的分類（照店家下一步要做什麼分，不是照 HTTP 碼分） */
export type DriveShareFailureKind =
  /** 他在這份沒有共用權（只是檢視者，或擁有者關了「編輯者可以變更權限」）→ 請擁有者來挑 */
  | 'cannot_share'
  /** 公司版 Google 擋了對外共用 → 他自己手動共用也一樣會被擋，給別條路 */
  | 'domain_blocked'
  /** Google 那邊暫時出狀況（太頻繁、伺服器錯、斷線）→ 同一份再共用一次 */
  | 'temporary'
  /**
   * 授權過期（挑檔視窗開太久才挑）→ 呼叫端把那把丟掉，請他按「再試一次」。
   * ⛔ 不在背景偷偷重拿：拿新的要跳 Google 視窗，不是他按按鈕開的會被瀏覽器當彈出廣告擋掉（2026-10-29 `/code-review`）
   */
  | 'expired'
  /** 猜不出來 → ⛔ 照實說，附 Google 原文 */
  | 'unknown'

export interface DriveShareFailure {
  kind: DriveShareFailureKind
  message: string
  /** Google 的原文（只在 unknown 時給畫面看，其他種類的原文就是 message 再講一次、還帶英文） */
  detail?: string
}

/** Google API 錯誤回應的形狀：{ error: { code, message, errors: [{ reason, message }] } } */
interface GoogleApiErrorBody {
  error?: {
    code?: number
    message?: string
    errors?: Array<{ reason?: string, message?: string }>
  }
}

/** 對外共用被公司政策擋下的幾種代碼（Drive v3 錯誤參考頁） */
const DOMAIN_BLOCK_REASONS = new Set(['shareOutNotPermitted', 'publishOutNotPermitted', 'shareInNotPermitted'])

/**
 * 把 Drive `permissions.create` 失敗翻成店家看得懂的一句話。
 * @param status HTTP 狀態碼（0＝連線失敗，沒拿到回應）
 * @param body Google 回的 JSON（解析失敗就傳 null）
 */
export function classifyDriveShareError(status: number, body: GoogleApiErrorBody | null): DriveShareFailure {
  const reasons = (body?.error?.errors ?? []).map(e => String(e.reason ?? ''))
  const raw = String(body?.error?.message ?? '').slice(0, 300)

  if (status === 401) return { kind: 'expired', message: 'Google 的授權過期了（挑檔視窗開太久）。按「再試一次」，會再跳一次 Google 的視窗。' }
  if (reasons.some(r => DOMAIN_BLOCK_REASONS.has(r)) || (status === 400 && /domain|organization|網域|機構/i.test(raw))) {
    return {
      kind: 'domain_blocked',
      message: '你們公司的 Google 帳號不允許把檔案共用到公司外面，手動共用也會被擋。請公司的 Google 管理員放行，或把試算表下載成 Excel 傳上來。',
    }
  }
  if (reasons.includes('insufficientFilePermissions') || (status === 403 && /permission/i.test(raw))) {
    return {
      kind: 'cannot_share',
      message: '這份只有擁有者能共用。請擁有者來挑一次，或請他照下面三步手動共用。',
    }
  }
  if (status === 0 || status === 429 || status >= 500 || reasons.some(r => /rateLimit|backendError|internalError/i.test(r))) {
    return { kind: 'temporary', message: 'Google 那邊暫時沒回應，請按「再試一次」。' }
  }
  return {
    kind: 'unknown',
    message: 'Google 沒讓這次共用成功。可以按「再試一次」，或照下面三步手動共用。',
    detail: raw || (status ? `HTTP ${status}` : undefined),
  }
}

/**
 * 「幫我開一份新的」開新表失敗時講什麼。Google 回錯誤的格式跟共用一樣，所以先用 classifyDriveShareError 分類，
 * ⛔ 但不能直接拿它的那句話：那幾句是講「共用」的——開新表被擋時說「這份只有擁有者能共用」，新表根本沒有擁有者的問題
 * （2026-10-29 `/code-review`）。
 */
export function createSheetFailureMessage(f: DriveShareFailure): string {
  if (f.kind === 'temporary') return 'Google 那邊暫時沒回應，請再按一次「幫我開一份新的」。'
  if (f.kind === 'expired') return 'Google 的授權過期了，請再按一次「幫我開一份新的」。'
  const why = f.detail ? `（Google 的說法：${f.detail}）` : ''
  return `Google 沒讓我們開新表${why}。可以再按一次，或自己在 Google 試算表開一份再回來挑。`
}

/**
 * 跳出 Google 登入／授權視窗時的錯誤（Google Identity Services 的 error_callback 或回應裡的 error）。
 * null＝他自己把視窗關掉了，安靜就好（⛔ 不要跳紅字：關掉視窗是「我不要了」，不是出錯）。
 */
export function classifyGoogleAuthError(type: string): string | null {
  if (type === 'popup_closed') return null
  if (type === 'popup_failed_to_open') return '瀏覽器擋住了 Google 的視窗，請再按一次；還是不行的話，請允許這個網站開新視窗。'
  if (type === 'access_denied' || type === 'scope_not_granted') return '沒有按「允許」，所以挑不了檔案。也可以照下面三步手動共用。'
  if (type === 'admin_policy_enforced' || type === 'org_internal') return '你們公司的 Google 帳號不允許使用外部的 App。可以照下面三步手動共用。'
  return 'Google 的視窗出了點問題。可以再按一次，或照下面三步手動共用。'
}

/** 挑到的那一份的網址：跟店家自己從網址列複製的長得一樣，後面判別、讀表、存檔都認得（見 GSHEET_PATTERN） */
export function googleSheetUrl(fileId: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/edit`
}
