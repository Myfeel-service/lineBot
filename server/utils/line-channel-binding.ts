import type { Firestore } from 'firebase-admin/firestore'
import { fetchLineBotInfo } from './line-webhook-remote'
import { capMapSize } from './bounded-cache'

/**
 * 「這個 LINE 官方帳號已經被別的工作區綁走了」偵測。
 *
 * ── 為什麼需要（2026-08-19 老闆實測挖出來的）──────────────────────────────
 * 同一個 LINE 頻道可以同時被兩個工作區存起來，而 webhook 進來時是拿**全部工作區**的
 * channel secret 逐一比對簽章——正確的那把在誰身上，訊息就整批進誰家。被搶走的那一邊
 * 一則都收不到，可是自己的檢查會全綠（憑證有存、拿它去問 LINE 也答得出來），
 * 使用者永遠不會知道自己在對著空氣說話。
 *
 * ── 怎麼認出「同一個頻道」──────────────────────────────────────────────
 * 比 token 字串沒用（同一個頻道可以發很多把、也可以重發），比 channel secret 只擋得住
 * 「整組貼兩次」。真正的身分是 LINE 那邊的 **bot userId**：拿 token 去問 `/bot/info`，
 * 同一個頻道無論發幾把鑰匙都回同一個 userId。
 *
 * 所以流程是：問到 userId → 存進 workspace 文件（`lineBotUserId`）→ 之後用單欄位查詢
 * 就能問「還有誰綁著同一個頻道」，不必為了比對再去打 LINE 一輪。
 *
 * ⛔ 不要改成「每次比對都逐一打 LINE 問每個工作區」：那是 O(租戶數) 次外部呼叫，
 *    存一次憑證要等好幾秒，租戶一多就直接爆掉。
 */

/** workspaces 文件上快取的頻道身分欄位 */
export const LINE_BOT_USER_ID_FIELD = 'lineBotUserId'

/** token → botUserId 的短期快取（同一把鑰匙在存檔流程裡會被問到兩三次） */
const BOT_ID_TTL_MS = 5 * 60_000
const BOT_ID_CACHE_MAX = 200
const botIdCache = new Map<string, { userId: string, expires: number }>()

export type ChannelIdentity =
  /** 問到了：這把鑰匙屬於這個官方帳號 */
  | { kind: 'ok', botUserId: string, displayName: string, basicId: string }
  /** LINE 明說不認得這把鑰匙 */
  | { kind: 'invalid' }
  /** 這次問不到（我們連不出去、LINE 忙）——⛔ 不等於沒問題，呼叫端要照「查不到」處理 */
  | { kind: 'unknown' }

/**
 * 拿一把 Channel Access Token 問 LINE「這是哪個官方帳號」。
 *
 * 三態誠實：LINE 明確拒絕（401/403）才回 invalid；我們自己出不去、LINE 5xx／429
 * 一律 unknown。⛔ 不可以把 unknown 當成 invalid——那會在 LINE 抖一下的時候
 * 擋住客戶存自己的憑證。
 */
export async function resolveChannelIdentity(channelAccessToken: string): Promise<ChannelIdentity> {
  const token = String(channelAccessToken || '').trim()
  if (!token) return { kind: 'unknown' }

  const cached = botIdCache.get(token)
  if (cached && cached.expires > Date.now())
    return { kind: 'ok', botUserId: cached.userId, displayName: '', basicId: '' }

  let res: Awaited<ReturnType<typeof fetchLineBotInfo>>
  try {
    res = await fetchLineBotInfo(token)
  }
  catch {
    return { kind: 'unknown' }
  }

  if (!res.ok)
    return (res.status === 401 || res.status === 403) ? { kind: 'invalid' } : { kind: 'unknown' }

  const botUserId = String(res.data.userId || '').trim()
  // LINE 回 200 但沒給 userId（理論上不會）：沒有身分就無從比對，當成問不到
  if (!botUserId) return { kind: 'unknown' }

  botIdCache.set(token, { userId: botUserId, expires: Date.now() + BOT_ID_TTL_MS })
  capMapSize(botIdCache, BOT_ID_CACHE_MAX)
  return { kind: 'ok', botUserId, displayName: res.data.displayName, basicId: res.data.basicId }
}

export type ChannelConflict = {
  workspaceId: string
  /** 對方工作區的名字，講給人聽用（查不到就退回 id） */
  name: string
}

/**
 * 除了 `exceptWorkspaceId` 以外，還有誰綁著同一個 bot userId。
 *
 * 單欄位等值查詢＝自動索引，不必另外建。取 3 筆就夠：要講的話是「已經被別人綁走」，
 * 不是列出全部。
 */
export async function findOtherWorkspacesOnChannel(
  db: Firestore,
  botUserId: string,
  exceptWorkspaceId: string,
): Promise<ChannelConflict[]> {
  const id = String(botUserId || '').trim()
  if (!id) return []

  const snap = await db.collection('workspaces')
    .where(LINE_BOT_USER_ID_FIELD, '==', id)
    .limit(3)
    .get()

  return snap.docs
    .filter(doc => doc.id !== exceptWorkspaceId)
    .map(doc => ({ workspaceId: doc.id, name: String((doc.data() as { name?: string })?.name ?? '').trim() || doc.id }))
}

/**
 * 把「這個工作區綁的是哪個頻道」記在 workspace 文件上。
 *
 * 存起來的是 LINE 給的公開識別碼（bot userId），不是憑證本身——它只用來回答
 * 「有沒有人綁同一個頻道」。寫入失敗不影響主流程（下次存檔或下次檢查會再補），
 * 所以這裡吞掉錯誤，只留一行 log。
 */
export async function rememberChannelBinding(
  db: Firestore,
  workspaceId: string,
  botUserId: string,
): Promise<void> {
  const id = String(botUserId || '').trim()
  if (!workspaceId || !id) return
  try {
    await db.collection('workspaces').doc(workspaceId).set({ [LINE_BOT_USER_ID_FIELD]: id }, { merge: true })
  }
  catch (e) {
    console.warn('[line-channel] 記錄頻道身分失敗:', String((e as Error)?.message ?? e).slice(0, 120))
  }
}

/**
 * 存檔前的把關：這把鑰匙的頻道是不是已經被別的工作區綁走了。
 *
 * 回傳 `conflicts` 非空＝該擋。⛔ 問不到身分時一律放行（`identity.kind !== 'ok'`）：
 * 我方連不出去是我方的問題，不能拿來擋客戶存自己的憑證——擋錯的代價是他今天無法上線，
 * 漏擋的代價是一個可以事後偵測、也真的有警示在盯的狀態。
 */
export async function checkChannelBindingConflict(
  db: Firestore,
  workspaceId: string,
  channelAccessToken: string,
): Promise<{ identity: ChannelIdentity, conflicts: ChannelConflict[] }> {
  const identity = await resolveChannelIdentity(channelAccessToken)
  if (identity.kind !== 'ok') return { identity, conflicts: [] }
  const conflicts = await findOtherWorkspacesOnChannel(db, identity.botUserId, workspaceId)
  return { identity, conflicts }
}

/**
 * 這個工作區綁的是哪個官方帳號——已經記過就直接用，沒記過才去問 LINE 一次並補記。
 *
 * 給輪詢型的檢查用：穩定狀態下**一次外部呼叫都不會有**（憑證讀取本來就有 60 秒快取，
 * 身分跟著一起帶回來）。回 null＝還沒接 LINE，或這次問不到。
 */
export async function getOrLearnChannelBotUserId(
  db: Firestore,
  workspaceId: string,
  credentials: { channelAccessToken: string, lineBotUserId: string },
): Promise<string | null> {
  const known = String(credentials.lineBotUserId || '').trim()
  if (known) return known
  const token = String(credentials.channelAccessToken || '').trim()
  if (!token) return null

  const identity = await resolveChannelIdentity(token)
  if (identity.kind !== 'ok') return null
  await rememberChannelBinding(db, workspaceId, identity.botUserId)
  return identity.botUserId
}

/** 擋下來時給使用者看的話：只講後果與怎麼辦，不講欄位名 */
export function channelConflictMessage(conflicts: ChannelConflict[]): string {
  const who = conflicts.map(c => `「${c.name}」`).join('、')
  return `這個 LINE 官方帳號已經被 ${who} 接走了。`
    + '同一個官方帳號只能接在一個地方——兩邊都接的話，客人的訊息會全部進到先接的那一邊，'
    + '這裡一則都收不到，而且畫面上看起來一切正常。'
    + '請先到那個帳號把 LINE 連接清掉，或改用另一個 LINE 官方帳號的憑證。'
}
