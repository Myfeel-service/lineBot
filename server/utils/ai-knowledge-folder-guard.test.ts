import { describe, expect, it, vi } from 'vitest'

/**
 * 知識庫資料夾歸屬（`G-98`，2026-09-29 權限盤點）：填了不存在／別家的資料夾，
 * 那份資料在側欄會整份消失（資料還在、AI 也照樣在用）。
 */
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { resolveKnowledgeFolderId } = await import('./ai-knowledge-folder-guard')

const FOLDERS: Record<string, Record<string, unknown>> = {
  fMine: { workspaceId: 'ws1', name: '產品說明' },
  fTheirs: { workspaceId: 'ws2', name: '別家的' },
}
let reads = 0
const db = {
  collection: () => ({
    doc: (id: string) => ({ get: async () => { reads++; return { exists: !!FOLDERS[id], data: () => FOLDERS[id] } } }),
  }),
} as never

describe('resolveKnowledgeFolderId', () => {
  it('沒帶／空字串／null → 未分類，不讀資料庫', async () => {
    reads = 0
    expect(await resolveKnowledgeFolderId(db, 'ws1', undefined)).toBeNull()
    expect(await resolveKnowledgeFolderId(db, 'ws1', null)).toBeNull()
    expect(await resolveKnowledgeFolderId(db, 'ws1', '  ')).toBeNull()
    expect(await resolveKnowledgeFolderId(db, 'ws1', 123)).toBeNull()
    expect(reads).toBe(0)
  })

  it('自己的資料夾 → 照放', async () => {
    expect(await resolveKnowledgeFolderId(db, 'ws1', 'fMine')).toBe('fMine')
  })

  it('🔴 別家的、不存在的、亂填的 → 一律 404，而且講同一句話（不透露別家有這個資料夾）', async () => {
    const errs = await Promise.all(['fTheirs', 'gone', 'a/b'].map(id =>
      resolveKnowledgeFolderId(db, 'ws1', id).catch(e => e)))
    for (const e of errs) expect(e).toMatchObject({ statusCode: 404 })
    expect(new Set(errs.map(e => e.statusMessage)).size).toBe(1)
  })
})
