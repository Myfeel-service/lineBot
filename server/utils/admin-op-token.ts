/**
 * 待確認操作的簽章憑證（`C-31` Phase 2）。
 *
 * 要解決的問題：提議在第一個請求產生、執行在第二個請求發生，中間隔著一個人按鈕的時間。
 * 後端必須能證明「這次要執行的，就是剛剛給他看過的那一件」，否則確認流只是裝飾。
 *
 * 做法：把 {工作區, 誰, 哪個操作, 參數, 當時的現況指紋, 到期時間} 簽成一段字串交給前端，
 * 按確定時原樣送回來驗。⛔不存 Firestore——它是跟著訊息走的短命東西，
 * 重整聊天室就該作廢（評估報告 §5.5）。
 *
 * 三道驗證，缺一個這流程就形同虛設：
 *   ① 簽章：改過參數的 token 一律拒絕（不能讓人把「停用 A」改成「停用 B」）。
 *   ② 綁人綁工作區：別人的 token 拿來用不了，換個工作區也不行。
 *   ③ 現況指紋：提議之後、按確定之前世界變了（別人剛改過同一個設定）→ 拒絕並請他重問。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AdminOpId } from '~~/shared/types/admin-ops'

export interface AdminOpTokenPayload {
  /** 工作區 */
  w: string
  /** 提議給誰的（Firebase uid） */
  u: string
  /** 哪個操作 */
  op: AdminOpId
  /** 收斂過的參數（⛔存的是正規化後的，不是模型原話）——執行時用這一份 */
  a: Record<string, unknown>
  /**
   * 模型當初送來的原始參數。
   *
   * 為什麼要另外存一份：正規化過的參數**餵不回 normalize**——例如勿擾時段，
   * 收斂完只剩 `{start,end}`，少了「這是服務時間還是勿擾時段」那一格。
   * 使用者說「剛剛那個改成早上十點」時，模型照著正規化結果重提就會缺欄位，
   * 於是它只好回頭問一次「你說的是服務時間還是勿擾時段？」——2026-09-16 實測踩到。
   * ⛔ 這一份只拿來當「上一個提議」的上下文，**絕不拿來執行**。
   */
  r?: Record<string, unknown>
  /** 提議當下的現況指紋：執行前再算一次，不一樣就拒絕 */
  g: string
  /** 到期時間（epoch ms） */
  e: number
}

/** 提議的有效期。夠一個人看完確認卡再決定，又短到「離開一下回來」就該重問 */
export const ADMIN_OP_TOKEN_TTL_MS = 10 * 60 * 1000

/**
 * 簽章金鑰：取既有的伺服器機密，⛔不新增環境變數（多一個要設的東西＝多一個上線會漏的東西）。
 * 兩個都沒有（本機開發）就用啟動時的隨機值——重啟即失效，對短命憑證來說可以接受。
 */
let cachedSecret = ''
function secret(): string {
  if (cachedSecret) return cachedSecret
  const cfg = useRuntimeConfig()
  cachedSecret = String(cfg.cronSecret || cfg.firebasePrivateKey || '').trim()
    || randomBytes(32).toString('hex')
  return cachedSecret
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url')
}

/** 等長比較，避免用字串比較洩漏簽章資訊 */
function sameSignature(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export function issueAdminOpToken(payload: Omit<AdminOpTokenPayload, 'e'>, now = Date.now()): string {
  const full: AdminOpTokenPayload = { ...payload, e: now + ADMIN_OP_TOKEN_TTL_MS }
  const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
  return `${body}.${sign(body)}`
}

export type AdminOpTokenCheck =
  | { ok: true, payload: AdminOpTokenPayload }
  /** 拒絕原因要分得開：過期是「再問一次就好」，簽章不符是「這不是我給的東西」 */
  | { ok: false, reason: 'malformed' | 'bad-signature' | 'expired' | 'wrong-user' }

export function verifyAdminOpToken(
  token: string,
  expect: { workspaceId: string, uid: string },
  now = Date.now(),
): AdminOpTokenCheck {
  const [body, sig] = String(token ?? '').split('.')
  if (!body || !sig) return { ok: false, reason: 'malformed' }
  if (!sameSignature(sign(body), sig)) return { ok: false, reason: 'bad-signature' }

  let payload: AdminOpTokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  }
  catch {
    return { ok: false, reason: 'malformed' }
  }

  // 簽章對、但不是給這個人／這個工作區的：一律拒絕。
  // （簽章沒綁對象的話，A 家的 token 就能在 B 家執行——那就是跨租戶寫入。）
  if (payload.w !== expect.workspaceId || payload.u !== expect.uid)
    return { ok: false, reason: 'wrong-user' }
  if (!(typeof payload.e === 'number') || payload.e <= now)
    return { ok: false, reason: 'expired' }

  return { ok: true, payload }
}
