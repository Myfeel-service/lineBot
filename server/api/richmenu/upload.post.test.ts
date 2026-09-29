import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 圖文選單換圖（`G-93`）：body 帶的 `firestoreId` 一定要是**自己家**、而且就是這張
 * `richMenuId` 的那一筆。以前不比對，A 家的人能把 B 家選單的圖換掉，B 下次存檔就發到 B 的 LINE。
 * ⛔ 擋下來的時候，LINE 與 Storage 一個都不能動（副作用發生之後才擋＝已經換掉了）。
 */

vi.mock('~~/server/utils/upload-validator', () => ({
  validateUploadPayload: vi.fn(() => ({ buffer: Buffer.from('img'), contentType: 'image/png' })),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

const menus: Record<string, { workspaceId: string, richMenuId: string, aliasId?: string }> = {
  mine: { workspaceId: 'wsA', richMenuId: 'rich-mine', aliasId: 'rmmine' },
  theirs: { workspaceId: 'wsB', richMenuId: 'rich-theirs', aliasId: 'rmtheirs' },
}
let body: Record<string, unknown> = {}
const uploadRichMenuImage = vi.fn(async () => {})
const fileSave = vi.fn(async () => {})
const updateDoc = vi.fn(async () => {})

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))
vi.stubGlobal('requireCapability', vi.fn(async () => ({ workspaceId: 'wsA', uid: 'u1' })))
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('getDoc', vi.fn(async (_c: string, id: string) => menus[id] ?? null))
vi.stubGlobal('updateDoc', updateDoc)
vi.stubGlobal('uploadRichMenuImage', uploadRichMenuImage)
vi.stubGlobal('deleteRichMenuAlias', vi.fn(async () => {}))
vi.stubGlobal('createRichMenuAlias', vi.fn(async () => {}))
vi.stubGlobal('getStorage', () => ({
  bucket: () => ({ name: 'bkt', file: () => ({ save: fileSave, makePublic: async () => {} }) }),
}))

const { default: handler } = await import('./upload.post')
const call = () => (handler as (e: unknown) => Promise<{ imageUrl: string }>)({})

beforeEach(() => {
  uploadRichMenuImage.mockClear()
  fileSave.mockClear()
  updateDoc.mockClear()
})

describe('POST /api/richmenu/upload', () => {
  it('自己家、richMenuId 對得上 → 照常上傳並記下圖', async () => {
    body = { richMenuId: 'rich-mine', firestoreId: 'mine', imageBase64: 'aW1n', contentType: 'image/png' }
    await expect(call()).resolves.toMatchObject({ imageUrl: 'https://storage.googleapis.com/bkt/richmenus/rich-mine.png' })
    expect(uploadRichMenuImage).toHaveBeenCalledTimes(1)
    expect(updateDoc).toHaveBeenCalledWith('richmenus', 'mine', { imageUrl: expect.any(String) })
  })

  it('🔴 別家的 firestoreId → 404，LINE、Storage、Firestore 都沒動', async () => {
    body = { richMenuId: 'rich-mine', firestoreId: 'theirs', imageBase64: 'aW1n', contentType: 'image/png' }
    await expect(call()).rejects.toMatchObject({ statusCode: 404 })
    expect(uploadRichMenuImage).not.toHaveBeenCalled()
    expect(fileSave).not.toHaveBeenCalled()
    expect(updateDoc).not.toHaveBeenCalled()
  })

  it('⛔ 自己家的 firestoreId 配上不是它的 richMenuId → 404（紀錄會指向一張不是它的圖）', async () => {
    body = { richMenuId: 'rich-theirs', firestoreId: 'mine', imageBase64: 'aW1n', contentType: 'image/png' }
    await expect(call()).rejects.toMatchObject({ statusCode: 404 })
    expect(uploadRichMenuImage).not.toHaveBeenCalled()
    expect(updateDoc).not.toHaveBeenCalled()
  })

  it('不存在的 firestoreId → 404', async () => {
    body = { richMenuId: 'rich-mine', firestoreId: 'nope', imageBase64: 'aW1n', contentType: 'image/png' }
    await expect(call()).rejects.toMatchObject({ statusCode: 404 })
    expect(uploadRichMenuImage).not.toHaveBeenCalled()
  })
})
