import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 原檔留存與下載（`C-296`③）。
 * ⛔ 下載網址只發給「這份資料自己資料夾底下」的路徑——資料庫裡的路徑被竄改或寫錯，
 *    也不可以變成讀別家檔案的鑰匙。
 */

const saved: Array<{ path: string, bytes: number, contentType: string }> = []
const deletedPrefixes: string[] = []
vi.mock('./firebase', () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (path: string) => ({
        save: async (buf: Buffer, o: { contentType: string }) => { saved.push({ path, bytes: buf.length, contentType: o.contentType }) },
        getSignedUrl: async (o: { action: string, responseDisposition: string }) => [`https://signed.example/${path}?a=${o.action}&d=${encodeURIComponent(o.responseDisposition)}`],
      }),
      deleteFiles: async (o: { prefix: string }) => { deletedPrefixes.push(o.prefix) },
    }),
  }),
}))
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { keepOriginalFile, signedOriginalFileUrl, sourceFilePrefix } = await import('./knowledge-source-files')

beforeEach(() => {
  saved.length = 0
  deletedPrefixes.length = 0
})

describe('keepOriginalFile', () => {
  it('先清掉這份資料舊的原檔（副檔名可能不同）再存新的', async () => {
    const kept = await keepOriginalFile({
      workspaceId: 'ws1', sourceId: 's1', readBytes: async () => Buffer.from('12345'), ext: 'DOCX', fileName: '說明書.docx', contentType: 'application/x-docx',
    })
    expect(deletedPrefixes).toEqual(['knowledge-files/ws1/s1/'])
    expect(saved).toEqual([{ path: 'knowledge-files/ws1/s1/original.docx', bytes: 5, contentType: 'application/x-docx' }])
    expect(kept).toEqual({ filePath: 'knowledge-files/ws1/s1/original.docx', fileName: '說明書.docx', fileSize: 5, fileContentType: 'application/x-docx' })
  })
  it('讀不到原檔 → 回 null、什麼都不刪（留存失敗不可以順手把舊的也弄丟）', async () => {
    const kept = await keepOriginalFile({
      workspaceId: 'ws1', sourceId: 's1', readBytes: async () => { throw new Error('gone') }, ext: 'pdf', fileName: 'a.pdf', contentType: 'application/pdf',
    })
    expect(kept).toBeNull()
    expect(deletedPrefixes).toEqual([])
  })
})

describe('signedOriginalFileUrl', () => {
  it('自己資料夾底下 → 發「存成附件」的網址，中文檔名照 RFC 5987 編碼', async () => {
    const url = await signedOriginalFileUrl('ws1', 's1', `${sourceFilePrefix('ws1', 's1')}original.pdf`, 'W1 說明書.pdf')
    expect(url).toContain('a=read')
    expect(decodeURIComponent(url)).toContain(`filename*=UTF-8''${encodeURIComponent('W1 說明書.pdf')}`)
  })
  it('⛔ 路徑不在這份資料的資料夾底下（別家、別份、或帶 ..）→ 404', async () => {
    await expect(signedOriginalFileUrl('ws1', 's1', 'knowledge-files/ws2/s9/original.pdf', 'x.pdf')).rejects.toMatchObject({ statusCode: 404 })
    await expect(signedOriginalFileUrl('ws1', 's1', 'knowledge-files/ws1/s2/original.pdf', 'x.pdf')).rejects.toMatchObject({ statusCode: 404 })
    await expect(signedOriginalFileUrl('ws1', 's1', 'knowledge-files/ws1/s1/../../ws2/s9/original.pdf', 'x.pdf')).rejects.toMatchObject({ statusCode: 404 })
  })
})
