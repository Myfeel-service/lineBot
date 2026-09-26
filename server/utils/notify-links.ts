/**
 * LINE 通知裡的短網址（`D-103`⑦／`C-270`，2026-09-27）。
 *
 * 為什麼要短網址：LINE 文字訊息會把網址整串印出來。直接放
 * `…/admin/{36 字的帳號編號}/conversations?userId={33 字}` 在手機上要佔五六行，
 * 把真正要讀的內容擠下去。短網址 `/c/xxxxxxx` 一行放得下。
 *
 * ⚠️ 為什麼一定要轉去外部瀏覽器：後台是 Google 彈窗登入（`useAuth.ts`），Google 不讓
 *    LINE 內建瀏覽器這種 WebView 登入。LINE 認得網址上的 `openExternalBrowser=1`，看到就改用
 *    手機的 Safari／Chrome 開。⛔ 不把這個參數直接印在訊息裡（又變長）：轉址端看到是 LINE
 *    內建瀏覽器，才把自己加上參數再轉一次（`resolveNotifyRedirect`）。
 *
 * 存放：`notifyLinks/{code}`＝{ workspaceId, path, createdAt }。一則通知一筆（不是一人一筆）。
 * 90 天後由排程清掉（`cleanupExpiredNotifyLinks`）；過期或打錯的碼一律導去後台首頁，⛔ 不顯示錯誤頁。
 * 安全：碼只換得到一個**後台路徑**，那一頁本來就要登入、要是那個帳號的成員才看得到。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'

export const NOTIFY_LINKS_COLLECTION = 'notifyLinks'
export const NOTIFY_LINK_TTL_MS = 90 * 86_400_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const CODE_LENGTH = 7
const CODE_RE = /^[A-Za-z0-9]{7}$/

/**
 * 通知裡要不要放連結：開關打開（`NOTIFY_LINKS_ENABLED=true`）而且有對外網址原點才放。
 * ⚠️ 2026-09-27 預設關：後台還沒有手機版，手機上點開對話頁只剩 150px 寬（見 nuxt.config 的說明）。
 */
export function notifyLinksEnabled(): boolean {
  try {
    const c = useRuntimeConfig()
    return c.notifyLinksEnabled === true && Boolean(String(c.appBaseUrl || '').trim())
  }
  catch {
    return false
  }
}

/** 對外網址原點（無尾斜線）；開關沒開或沒設就回空字串＝通知不放連結、退回「請至後台…」 */
export function notifyLinkBaseUrl(): string {
  if (!notifyLinksEnabled()) return ''
  try {
    return String(useRuntimeConfig().appBaseUrl || '').trim().replace(/\/$/, '')
  }
  catch {
    return ''
  }
}

export function conversationPath(workspaceId: string, customerLineUserId: string): string {
  return `/admin/${workspaceId}/conversations?userId=${encodeURIComponent(customerLineUserId)}`
}

export function conversationsListPath(workspaceId: string): string {
  return `/admin/${workspaceId}/conversations`
}

export function adminHomePath(workspaceId: string): string {
  return `/admin/${workspaceId}`
}

function randomCode(): string {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return out
}

/**
 * 產一條短網址。回 `undefined`＝沒有對外網址原點（本機）→ 呼叫端就不放連結。
 * 寫入失敗時退回完整網址：長一點，但點得開（⛔ 不因為短網址壞了就讓整則通知沒有連結）。
 */
export async function createNotifyLink(workspaceId: string, path: string, db: Firestore = getDb()): Promise<string | undefined> {
  const base = notifyLinkBaseUrl()
  if (!base || !workspaceId || !path.startsWith('/admin/')) return undefined
  for (let i = 0; i < 3; i++) {
    const code = randomCode()
    try {
      // create＝碼已存在就失敗，不會蓋掉別人的
      await db.collection(NOTIFY_LINKS_COLLECTION).doc(code).create({ workspaceId, path, createdAt: Date.now() })
      return `${base}/c/${code}`
    }
    catch (err) {
      if (Number((err as { code?: unknown })?.code) === 6) continue // ALREADY_EXISTS：換一組
      console.warn('[notify-links] create failed:', workspaceId, err)
      break
    }
  }
  return `${base}${path}`
}

export function isValidNotifyLinkCode(code: string): boolean {
  return CODE_RE.test(String(code || ''))
}

/** LINE 內建瀏覽器的 User-Agent 帶「Line/版本號」 */
export function isLineInAppBrowser(userAgent: string): boolean {
  return /\bLine\/\d/i.test(String(userAgent || ''))
}

/**
 * 轉址去哪（純函式，方便測）：
 * - LINE 內建瀏覽器、還沒帶參數 → 轉回自己並加上 `openExternalBrowser=1`（LINE 會改用外部瀏覽器開）
 * - 其他 → 轉去記下的後台路徑；碼不對、過期、路徑不是後台 → 後台首頁
 */
export function resolveNotifyRedirect(input: {
  code: string
  userAgent: string
  hasExternalParam: boolean
  doc: { path?: unknown, createdAt?: unknown } | null
  nowMs: number
}): string {
  if (isLineInAppBrowser(input.userAgent) && !input.hasExternalParam)
    return `/c/${input.code}?openExternalBrowser=1`
  const path = typeof input.doc?.path === 'string' ? input.doc.path : ''
  const createdAt = Number(input.doc?.createdAt ?? 0)
  if (!path.startsWith('/admin/') || path.startsWith('//') || !createdAt || input.nowMs - createdAt > NOTIFY_LINK_TTL_MS)
    return '/admin'
  return path
}

/** 排程清掉 90 天前的短網址（每輪最多 500 筆，剩下的下一輪再清） */
export async function cleanupExpiredNotifyLinks(db: Firestore = getDb()): Promise<{ deleted: number }> {
  const snap = await db.collection(NOTIFY_LINKS_COLLECTION)
    .where('createdAt', '<', Date.now() - NOTIFY_LINK_TTL_MS)
    .limit(500)
    .get()
  if (snap.empty) return { deleted: 0 }
  const batch = db.batch()
  snap.docs.forEach(d => batch.delete(d.ref))
  await batch.commit()
  return { deleted: snap.size }
}
