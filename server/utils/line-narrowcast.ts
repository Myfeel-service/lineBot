import * as line from '@line/bot-sdk'
import { HTTPFetchError } from '@line/bot-sdk'
import { getLineWorkspaceCredentials } from './line-workspace-credentials'

/**
 * LINE「先上傳名單、再發給名單」（narrowcast）與名單（audience）那幾支（`D-154`②③）。
 * 流程與為什麼見 broadcast-narrowcast.ts；這裡只包 LINE 的呼叫。
 *
 * 2026-10-28 用測試帳號實測過的事：
 * - 上傳名單時 LINE 就比對編號，一個有效的都沒有會當場 400（`UPLOAD_AUDIENCE_GROUP_NO_VALID_AUDIENCE_IDS`）。
 * - `isIfaAudience` 一定要明講 false，不帶會 400。
 * - 一個人的名單也要 87 秒才變成 READY（官方文件：送之前要等 READY）。
 */

type Clients = {
  token: string
  messaging: line.messagingApi.MessagingApiClient
  audience: line.manageAudience.ManageAudienceClient
  audienceBlob: line.manageAudience.ManageAudienceBlobClient
}
const _clients = new Map<string, Clients>()

async function clientsFor(workspaceId: string): Promise<Clients> {
  const wid = String(workspaceId || '').trim()
  if (!wid) throw new Error('workspaceId is required')
  const { channelAccessToken } = await getLineWorkspaceCredentials(wid)
  const token = String(channelAccessToken || '').trim()
  if (!token) throw new Error('LINE channel access token is not set')
  const cur = _clients.get(wid)
  if (cur && cur.token === token) return cur
  const next: Clients = {
    token,
    messaging: new line.messagingApi.MessagingApiClient({ channelAccessToken: token }),
    audience: new line.manageAudience.ManageAudienceClient({ channelAccessToken: token }),
    audienceBlob: new line.manageAudience.ManageAudienceBlobClient({ channelAccessToken: token }),
  }
  _clients.set(wid, next)
  return next
}

/** LINE 錯誤講成一行（給 log 與「為什麼改用一般方式送」） */
export function lineErrorText(e: unknown): string {
  if (e instanceof HTTPFetchError) return `${e.status} ${String(e.body || e.message).slice(0, 200)}`.trim()
  return String((e as Error)?.message ?? e).slice(0, 200)
}

/** 上傳一份名單（一行一個 LINE 編號，走檔案上傳：一次最多 150 萬人，不用分批） */
export async function uploadAudience(workspaceId: string, lineUserIds: string[], description: string): Promise<number> {
  const { audienceBlob } = await clientsFor(workspaceId)
  const file = new Blob([lineUserIds.join('\n')], { type: 'text/plain' })
  // 名單說明 LINE 限 120 字
  const res = await audienceBlob.createAudienceForUploadingUserIds(file, description.slice(0, 120), false)
  const id = Number(res.audienceGroupId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('LINE 沒有回名單編號')
  return id
}

export type AudienceReadiness = 'ready' | 'pending' | 'failed'

/** 名單準備好了沒（READY＝可以送；FAILED／EXPIRED／INACTIVE＝不能用了） */
export async function audienceReadiness(workspaceId: string, audienceGroupId: number): Promise<{ readiness: AudienceReadiness; detail: string }> {
  const { audience } = await clientsFor(workspaceId)
  const d = await audience.getAudienceData(audienceGroupId)
  const g = d.audienceGroup
  const status = String(g?.status ?? '')
  const detail = `${status}${g?.failedType ? `/${g.failedType}` : ''} count=${g?.audienceCount ?? '?'}`
  if (status === 'READY') return { readiness: 'ready', detail }
  if (status === 'IN_PROGRESS' || status === 'ACTIVATING') return { readiness: 'pending', detail }
  return { readiness: 'failed', detail }
}

/** 請 LINE 把某一則 narrowcast「看過的人」或「點過連結的人」圈成名單（發完 60 天內） */
export async function createRetargetAudience(
  workspaceId: string,
  kind: 'impression' | 'click',
  requestId: string,
  description: string,
): Promise<number> {
  const { audience } = await clientsFor(workspaceId)
  const desc = description.slice(0, 120)
  const res = kind === 'impression'
    ? await audience.createImpBasedAudienceGroup({ requestId, description: desc })
    : await audience.createClickBasedAudienceGroup({ requestId, description: desc })
  const id = Number(res.audienceGroupId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('LINE 沒有回名單編號')
  return id
}

/**
 * 送出。回 LINE 給的這一則編號（之後查進度、查打開數、圈名單都要它）。
 *
 * ⭐ 一定要帶重送編號：同一個編號 LINE 只收一次，再叫一次會回 409 並在標頭告訴我們當初收下的那一則
 *   （`x-line-accepted-request-id`）——所以「叫了 LINE、還沒記下來就斷掉」下一輪再叫一次也不會重複送。
 */
export async function sendNarrowcast(
  workspaceId: string,
  messages: line.messagingApi.Message[],
  recipient: Record<string, unknown>,
  retryKey: string,
): Promise<string> {
  const { messaging } = await clientsFor(workspaceId)
  try {
    const res = await messaging.narrowcastWithHttpInfo(
      { messages, recipient: recipient as unknown as line.messagingApi.Recipient },
      retryKey,
    )
    const requestId = res.httpResponse.headers.get('x-line-request-id')
    if (!requestId) throw new Error('LINE 收下了，但沒有回這一則的編號')
    return requestId
  }
  catch (e) {
    if (e instanceof HTTPFetchError && e.status === 409) {
      const accepted = e.headers?.get?.('x-line-accepted-request-id')
      if (accepted) return accepted
    }
    throw e
  }
}

export interface NarrowcastProgress {
  phase: 'waiting' | 'sending' | 'succeeded' | 'failed'
  successCount: number | null
  failureCount: number | null
  targetCount: number | null
  errorCode: number | null
  failedDescription: string | null
}

export async function narrowcastProgress(workspaceId: string, requestId: string): Promise<NarrowcastProgress> {
  const { messaging } = await clientsFor(workspaceId)
  const p = await messaging.getNarrowcastProgress(requestId)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    phase: String(p.phase) as NarrowcastProgress['phase'],
    successCount: num(p.successCount),
    failureCount: num(p.failureCount),
    targetCount: num(p.targetCount),
    errorCode: num(p.errorCode),
    failedDescription: p.failedDescription ? String(p.failedDescription) : null,
  }
}

/** 刪掉一份名單（用不到的、建了卻沒送成的）。失敗只記 log：LINE 180 天後自己會收掉 */
export async function deleteAudience(workspaceId: string, audienceGroupId: number): Promise<void> {
  try {
    const { audience } = await clientsFor(workspaceId)
    await audience.deleteAudienceGroup(audienceGroupId)
  }
  catch (e) {
    console.warn('[line-narrowcast] 刪名單失敗（不影響推播）:', audienceGroupId, lineErrorText(e))
  }
}
