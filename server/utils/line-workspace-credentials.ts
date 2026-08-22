import { getDb } from './firebase'
import type { LineWorkspaceDoc } from '~~/shared/line-workspace'

export type ResolvedLineCredentials = {
  channelAccessToken: string
  channelSecret: string
  /** 活動 CTA 等可選用 */
  defaultLiffId: string
  /**
   * 這個工作區綁的是哪個 LINE 官方帳號（LINE 側的 bot userId）。
   * 存憑證時順手記下來的快取值，只用來回答「有沒有別的工作區綁著同一個帳號」——
   * 有它就不必為了比對再去打一次 LINE。舊資料可能沒有，空字串代表還沒問過。
   */
  lineBotUserId: string
}

const TTL_MS = 60 * 1000

const cacheByWorkspace = new Map<string, ResolvedLineCredentials & { expiresAt: number }>()
let workspaceCredentialListCache: Array<{ workspaceId: string; credentials: ResolvedLineCredentials }> | null = null
let workspaceCredentialListExpiresAt = 0

export function invalidateLineWorkspaceCredentialsCache() {
  cacheByWorkspace.clear()
  workspaceCredentialListCache = null
  workspaceCredentialListExpiresAt = 0
}

/**
 * 讀取 LINE Messaging 憑證：僅使用指定 workspace，不再 fallback 到 `workspaces/default`。
 * 結果短暫快取，避免每則 webhook 都打 Firestore。
 */
export async function getLineWorkspaceCredentials(workspaceId: string): Promise<ResolvedLineCredentials> {
  const requestedWorkspaceId = String(workspaceId || '').trim()
  if (!requestedWorkspaceId) {
    throw new Error('workspaceId is required for LINE workspace credentials')
  }
  const now = Date.now()
  const cacheKey = requestedWorkspaceId
  const cached = cacheByWorkspace.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return {
      channelAccessToken: cached.channelAccessToken,
      channelSecret: cached.channelSecret,
      defaultLiffId: cached.defaultLiffId,
      lineBotUserId: cached.lineBotUserId,
    }
  }

  const fromRequested: Partial<ResolvedLineCredentials> = {}
  try {
    const db = getDb()
    const requestedSnap = await db.collection('workspaces').doc(requestedWorkspaceId).get()
    if (requestedSnap.exists) {
      const d = requestedSnap.data() as LineWorkspaceDoc
      fromRequested.channelAccessToken = String(d?.channelAccessToken ?? '').trim()
      fromRequested.channelSecret = String(d?.channelSecret ?? '').trim()
      fromRequested.defaultLiffId = String(d?.defaultLiffId ?? '').trim()
      fromRequested.lineBotUserId = String(d?.lineBotUserId ?? '').trim()
    }

  }
  catch (e) {
    console.warn('[line-workspace] read workspace credentials failed:', e)
  }

  const resolved: ResolvedLineCredentials = {
    channelAccessToken: fromRequested.channelAccessToken || '',
    channelSecret: fromRequested.channelSecret || '',
    defaultLiffId: fromRequested.defaultLiffId || '',
    lineBotUserId: fromRequested.lineBotUserId || '',
  }
  cacheByWorkspace.set(cacheKey, { ...resolved, expiresAt: now + TTL_MS })
  return resolved
}

/**
 * 用 LIFF 的 Login channel id 反查租戶（`defaultLiffId` 的格式是 `{loginChannelId}-{suffix}`）。
 *
 * 為什麼不沿用 listWorkspaceLineCredentials：那支會把**整個 workspaces 集合**讀進記憶體
 * （連 channel secret／access token 都一起），而呼叫它的 /api/liff/config 是**不需要登入**的
 * 端點——任何人拿一組亂編的 liffClientId 反覆打，就能讓每個執行個體每分鐘重掃一次全表
 * （查不到的回應刻意不設快取標頭）。這裡改成用前綴範圍查詢，最多讀 2 筆。
 *
 * 取 2 筆而不是 1 筆：兩個租戶共用同一個 Login channel 時要看得出「撞號了」，呼叫端才有
 * 辦法維持「撞號就拒絕猜」（猜錯會把客人送去別的 Login channel 登入，貼標貼到不存在的人身上）。
 * `-` 的下一個字元是 `.`，所以 [`{id}-`, `{id}.`) 正好是「以這個 channel id 為前綴」那一段，
 * 不會把 `12345-xxx` 誤算成 `1234` 的。單欄位範圍查詢用的是自動索引，不必另外建。
 */
export async function findWorkspacesByLiffChannelId(
  liffClientId: string,
): Promise<Array<{ workspaceId: string; credentials: ResolvedLineCredentials }>> {
  const id = String(liffClientId || '').trim()
  if (!/^\d+$/.test(id)) return []

  const snap = await getDb().collection('workspaces')
    .where('defaultLiffId', '>=', `${id}-`)
    .where('defaultLiffId', '<', `${id}.`)
    .limit(2)
    .get()

  const now = Date.now()
  return snap.docs.map((doc) => {
    const d = doc.data() as LineWorkspaceDoc
    const credentials: ResolvedLineCredentials = {
      channelAccessToken: String(d?.channelAccessToken ?? '').trim(),
      channelSecret: String(d?.channelSecret ?? '').trim(),
      defaultLiffId: String(d?.defaultLiffId ?? '').trim(),
      lineBotUserId: String(d?.lineBotUserId ?? '').trim(),
    }
    cacheByWorkspace.set(doc.id, { ...credentials, expiresAt: now + TTL_MS })
    return { workspaceId: doc.id, credentials }
  })
}

/**
 * 列出所有已設定 LINE 憑證的 workspace（供 webhook／token 驗證時比對）。
 */
export async function listWorkspaceLineCredentials(): Promise<Array<{ workspaceId: string; credentials: ResolvedLineCredentials }>> {
  const now = Date.now()
  if (workspaceCredentialListCache && workspaceCredentialListExpiresAt > now) {
    return workspaceCredentialListCache
  }

  const db = getDb()
  const snap = await db.collection('workspaces').get()
  const rows: Array<{ workspaceId: string; credentials: ResolvedLineCredentials }> = []

  for (const doc of snap.docs) {
    const d = doc.data() as LineWorkspaceDoc
    const credentials: ResolvedLineCredentials = {
      channelAccessToken: String(d?.channelAccessToken ?? '').trim(),
      channelSecret: String(d?.channelSecret ?? '').trim(),
      defaultLiffId: String(d?.defaultLiffId ?? '').trim(),
      lineBotUserId: String(d?.lineBotUserId ?? '').trim(),
    }
    // ⛔ 判空只看真正的憑證三欄：lineBotUserId 只是比對用的快取值，
    //    有它但沒憑證的文件對 webhook 驗證沒有用，不該被算成「有設定」
    if (!credentials.channelAccessToken && !credentials.channelSecret && !credentials.defaultLiffId) continue
    rows.push({ workspaceId: doc.id, credentials })
    cacheByWorkspace.set(doc.id, { ...credentials, expiresAt: now + TTL_MS })
  }

  workspaceCredentialListCache = rows
  workspaceCredentialListExpiresAt = now + TTL_MS
  return rows
}
