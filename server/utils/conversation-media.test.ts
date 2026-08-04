import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 這支測的是「存檔一次就不要再打 LINE」「拿不到就要說清楚是哪一種拿不到」
 * 以及 messageId 會被拿去組 Storage 路徑（必須擋掉異常值）這三件事。
 */

type FileStub = {
  getMetadata: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  getSignedUrl: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

const files = new Map<string, FileStub>()
const requestedPaths: string[] = []

function stubFile(path: string): FileStub {
  const existing = files.get(path)
  if (existing) return existing
  const notFound = Object.assign(new Error('No such object'), { code: 404 })
  const file: FileStub = {
    getMetadata: vi.fn(async () => { throw notFound }),
    save: vi.fn(async () => {}),
    getSignedUrl: vi.fn(async () => [`https://signed.example/${path}`]),
    delete: vi.fn(async () => {}),
  }
  files.set(path, file)
  return file
}

vi.mock('./firebase', () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (path: string) => {
        requestedPaths.push(path)
        return stubFile(path)
      },
    }),
  }),
}))

const fetchLineMessageContent = vi.fn()
vi.mock('./line', () => ({
  fetchLineMessageContent: (...args: unknown[]) => fetchLineMessageContent(...args),
}))

const {
  archiveConversationMedia,
  resolveConversationMediaUrl,
  deleteConversationMediaObjects,
  conversationMediaObjectPath,
  isMediaMessageType,
} = await import('./conversation-media')

const WID = 'ws-1'
const MSG_ID = '625758047842861329'
const PATH = `conversation-media/${WID}/${MSG_ID}`

beforeEach(() => {
  files.clear()
  requestedPaths.length = 0
  fetchLineMessageContent.mockReset()
})

describe('isMediaMessageType', () => {
  it('只認圖／影／音／檔，貼圖與文字不算（貼圖有現成的預覽網址）', () => {
    expect(isMediaMessageType('image')).toBe(true)
    expect(isMediaMessageType('video')).toBe(true)
    expect(isMediaMessageType('audio')).toBe(true)
    expect(isMediaMessageType('file')).toBe(true)
    expect(isMediaMessageType('sticker')).toBe(false)
    expect(isMediaMessageType('text')).toBe(false)
    expect(isMediaMessageType(undefined)).toBe(false)
  })
})

describe('archiveConversationMedia', () => {
  it('第一次會向 LINE 抓檔並存進 Storage', async () => {
    fetchLineMessageContent.mockResolvedValue({ ok: true, buffer: Buffer.from('jpegdata'), contentType: 'image/jpeg' })

    const res = await archiveConversationMedia({ workspaceId: WID, lineMessageId: MSG_ID, messageType: 'image' })

    expect(res).toEqual({ ok: true, path: PATH, contentType: 'image/jpeg', bytes: 8 })
    expect(fetchLineMessageContent).toHaveBeenCalledTimes(1)
    expect(files.get(PATH)!.save).toHaveBeenCalledTimes(1)
    expect(files.get(PATH)!.save.mock.calls[0]![1]).toMatchObject({ contentType: 'image/jpeg' })
  })

  it('已經存過就直接沿用，不再打 LINE（同一則訊息重看幾次都只抓一次）', async () => {
    const file = stubFile(PATH)
    file.getMetadata.mockResolvedValue([{ contentType: 'image/png', size: '2048' }])

    const res = await archiveConversationMedia({ workspaceId: WID, lineMessageId: MSG_ID, messageType: 'image' })

    expect(res).toEqual({ ok: true, path: PATH, contentType: 'image/png', bytes: 2048 })
    expect(fetchLineMessageContent).not.toHaveBeenCalled()
    expect(file.save).not.toHaveBeenCalled()
  })

  it('LINE 已刪檔（expired）不會寫出空檔案', async () => {
    fetchLineMessageContent.mockResolvedValue({ ok: false, reason: 'expired' })

    const res = await archiveConversationMedia({ workspaceId: WID, lineMessageId: MSG_ID, messageType: 'image' })

    expect(res).toEqual({ ok: false, state: 'expired', detail: undefined })
    expect(files.get(PATH)!.save).not.toHaveBeenCalled()
  })

  it('超過單檔上限回 too_large（上限依訊息型別帶給下載端）', async () => {
    fetchLineMessageContent.mockResolvedValue({ ok: false, reason: 'too_large' })

    const res = await archiveConversationMedia({ workspaceId: WID, lineMessageId: MSG_ID, messageType: 'video' })

    expect(res).toMatchObject({ ok: false, state: 'too_large' })
    expect(fetchLineMessageContent.mock.calls[0]![2]).toMatchObject({ maxBytes: expect.any(Number) })
  })

  it('messageId 含路徑字元一律拒絕，連 Storage 都不碰（避免組出別人的路徑）', async () => {
    for (const bad of ['../../secret', 'a/b', '', '  ']) {
      const res = await archiveConversationMedia({ workspaceId: WID, lineMessageId: bad, messageType: 'image' })
      expect(res).toMatchObject({ ok: false, state: 'error' })
    }
    expect(requestedPaths).toEqual([])
    expect(fetchLineMessageContent).not.toHaveBeenCalled()
  })

  it('不是媒體型別就不處理', async () => {
    const res = await archiveConversationMedia({ workspaceId: WID, lineMessageId: MSG_ID, messageType: 'text' })
    expect(res).toMatchObject({ ok: false, state: 'error' })
    expect(requestedPaths).toEqual([])
  })
})

describe('resolveConversationMediaUrl', () => {
  it('存檔成功後簽出唯讀短效網址', async () => {
    fetchLineMessageContent.mockResolvedValue({ ok: true, buffer: Buffer.from('x'), contentType: 'image/jpeg' })

    const res = await resolveConversationMediaUrl({ workspaceId: WID, lineMessageId: MSG_ID, messageType: 'image' })

    expect(res).toMatchObject({ state: 'ready', url: `https://signed.example/${PATH}`, contentType: 'image/jpeg' })
    const signArgs = files.get(PATH)!.getSignedUrl.mock.calls[0]![0]
    expect(signArgs).toMatchObject({ version: 'v4', action: 'read' })
    expect(Number(signArgs.expires)).toBeGreaterThan(Date.now())
  })

  it('拿不到檔案就把原因原封不動往上傳，讓後台能顯示對應說明', async () => {
    fetchLineMessageContent.mockResolvedValue({ ok: false, reason: 'not_ready' })

    const res = await resolveConversationMediaUrl({ workspaceId: WID, lineMessageId: MSG_ID, messageType: 'video' })

    expect(res).toMatchObject({ state: 'not_ready' })
  })
})

describe('deleteConversationMediaObjects', () => {
  it('照 workspace + messageId 組路徑刪除，重複的只刪一次', async () => {
    const res = await deleteConversationMediaObjects([
      { workspaceId: WID, lineMessageId: MSG_ID },
      { workspaceId: WID, lineMessageId: MSG_ID },
      { workspaceId: WID, lineMessageId: '../oops' },
    ])

    expect(res).toBe(1)
    expect(files.get(PATH)!.delete).toHaveBeenCalledTimes(1)
    expect(requestedPaths).toEqual([PATH])
  })

  it('檔案本來就不存在（404）不算失敗', async () => {
    const file = stubFile(PATH)
    file.delete.mockRejectedValue(Object.assign(new Error('nope'), { code: 404 }))

    const res = await deleteConversationMediaObjects([{ workspaceId: WID, lineMessageId: MSG_ID }])

    expect(res).toBe(0)
  })
})

describe('conversationMediaObjectPath', () => {
  it('路徑帶 workspaceId，租戶之間不會撞檔', () => {
    expect(conversationMediaObjectPath('ws-a', '1')).toBe('conversation-media/ws-a/1')
    expect(conversationMediaObjectPath('ws-b', '1')).toBe('conversation-media/ws-b/1')
  })
})
