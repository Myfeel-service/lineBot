import { getStorage } from './firebase'
import { fetchLineMessageContent } from './line'

/**
 * 客人傳來的圖／影／音／檔，webhook 只會給一個 messageId + contentProvider: line——
 * 沒有任何可直接顯示的網址。原始檔要另外用 Get content API 抓，而且 LINE 只暫存一段時間，
 * 過期就永久拿不回來。所以抓到就存進 Storage 當長期存檔，後台一律看存檔（簽名網址）。
 *
 * 存檔路徑刻意只用 workspaceId + LINE messageId：
 * 同一則訊息不管重送幾次、從哪支端點來，落點都一樣（天然冪等，不需要額外欄位記狀態）。
 */
export const MEDIA_MESSAGE_TYPES = ['image', 'video', 'audio', 'file'] as const
export type MediaMessageType = typeof MEDIA_MESSAGE_TYPES[number]

export function isMediaMessageType(type: unknown): type is MediaMessageType {
  return (MEDIA_MESSAGE_TYPES as readonly string[]).includes(String(type || ''))
}

/** 單檔上限：超過就不存檔（後台會顯示「檔案太大無法預覽」，客服仍看得到有這則訊息） */
const MAX_BYTES_BY_TYPE: Record<MediaMessageType, number> = {
  image: 15 * 1024 * 1024,
  audio: 30 * 1024 * 1024,
  file: 30 * 1024 * 1024,
  video: 30 * 1024 * 1024,
}

/** 簽名網址有效期：夠一個客服班次看完，又不會被外流後長期可讀 */
const SIGNED_URL_TTL_MS = 6 * 60 * 60 * 1000

/** LINE messageId 是數字字串；擋掉異常值以免被拿去組出別的 Storage 路徑 */
function isSafeMessageId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

export function conversationMediaObjectPath(workspaceId: string, lineMessageId: string): string {
  return `conversation-media/${workspaceId}/${lineMessageId}`
}

export type ConversationMediaState = 'ready' | 'expired' | 'not_ready' | 'too_large' | 'error'

export type ConversationMediaResult =
  | { state: 'ready'; url: string; contentType: string; bytes: number }
  | { state: Exclude<ConversationMediaState, 'ready'>; detail?: string }

type ArchiveResult =
  | { ok: true; path: string; contentType: string; bytes: number }
  | { ok: false; state: Exclude<ConversationMediaState, 'ready'>; detail?: string }

function isNotFound(err: unknown): boolean {
  return Number((err as { code?: unknown })?.code) === 404
}

/**
 * 確保這則訊息的原始檔已存進 Storage（已存在就直接沿用，不會重抓 LINE）。
 * 收訊當下（webhook）與後台開啟對話時都走這支。
 */
export async function archiveConversationMedia(opts: {
  workspaceId: string
  lineMessageId: string
  messageType: string
}): Promise<ArchiveResult> {
  const workspaceId = String(opts.workspaceId || '').trim()
  const lineMessageId = String(opts.lineMessageId || '').trim()
  if (!workspaceId) return { ok: false, state: 'error', detail: 'workspaceId is required' }
  if (!isSafeMessageId(lineMessageId)) return { ok: false, state: 'error', detail: 'invalid messageId' }
  if (!isMediaMessageType(opts.messageType)) return { ok: false, state: 'error', detail: 'not a media message' }

  const path = conversationMediaObjectPath(workspaceId, lineMessageId)
  const file = getStorage().bucket().file(path)

  try {
    const [meta] = await file.getMetadata()
    return {
      ok: true,
      path,
      contentType: String(meta.contentType || 'application/octet-stream'),
      bytes: Number(meta.size || 0),
    }
  }
  catch (err) {
    if (!isNotFound(err)) {
      console.warn('[conv-media] getMetadata failed:', err instanceof Error ? err.message : err)
    }
  }

  const fetched = await fetchLineMessageContent(lineMessageId, workspaceId, {
    maxBytes: MAX_BYTES_BY_TYPE[opts.messageType],
  })
  if (!fetched.ok) {
    if (fetched.reason === 'error') {
      console.warn('[conv-media] fetch content failed:', lineMessageId, fetched.detail)
    }
    return { ok: false, state: fetched.reason, detail: fetched.detail }
  }

  try {
    await file.save(fetched.buffer, {
      contentType: fetched.contentType,
      resumable: false,
      metadata: { cacheControl: 'private, max-age=3600' },
    })
  }
  catch (err) {
    // 存檔失敗不要往外炸成 500：後台顯示「載入失敗，重新整理再試」比整頁報錯好，
    // 而且下次進來還會再試一次（save 是全有全無，不會留下半個檔案）。
    console.error('[conv-media] save failed:', path, err instanceof Error ? err.message : err)
    return { ok: false, state: 'error', detail: 'save failed' }
  }
  return { ok: true, path, contentType: fetched.contentType, bytes: fetched.buffer.length }
}

/** 存檔（必要時）＋簽出短效唯讀網址，供後台 <img> / <video> 直接讀 */
export async function resolveConversationMediaUrl(opts: {
  workspaceId: string
  lineMessageId: string
  messageType: string
}): Promise<ConversationMediaResult> {
  const archived = await archiveConversationMedia(opts)
  if (!archived.ok) return { state: archived.state, detail: archived.detail }

  try {
    const [url] = await getStorage().bucket().file(archived.path).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
    })
    return { state: 'ready', url, contentType: archived.contentType, bytes: archived.bytes }
  }
  catch (err) {
    console.error('[conv-media] getSignedUrl failed:', err instanceof Error ? err.message : err)
    return { state: 'error', detail: 'sign failed' }
  }
}

/**
 * 刪掉這些訊息對應的存檔（訊息過保留期被清掉時一起清，否則 Storage 會永遠只增不減）。
 * 失敗不擋：存檔留著只是浪費空間，比清理流程整批中斷好。
 */
export async function deleteConversationMediaObjects(
  items: Array<{ workspaceId: string; lineMessageId: string }>,
): Promise<number> {
  const paths = new Set<string>()
  for (const item of items) {
    const workspaceId = String(item.workspaceId || '').trim()
    const lineMessageId = String(item.lineMessageId || '').trim()
    if (!workspaceId || !isSafeMessageId(lineMessageId)) continue
    paths.add(conversationMediaObjectPath(workspaceId, lineMessageId))
  }
  if (!paths.size) return 0

  const bucket = getStorage().bucket()
  const all = [...paths]
  let deleted = 0
  // 一批最多刪 20 個：保留期清理一次可能掃到數百則訊息，全部同時發刪除請求太粗暴
  for (let i = 0; i < all.length; i += 20) {
    await Promise.all(all.slice(i, i + 20).map(async (path) => {
      try {
        await bucket.file(path).delete()
        deleted += 1
      }
      catch (err) {
        if (!isNotFound(err)) {
          console.warn('[conv-media] delete failed:', path, err instanceof Error ? err.message : err)
        }
      }
    }))
  }
  return deleted
}
