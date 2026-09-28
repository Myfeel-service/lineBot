/**
 * 標籤歸屬過濾（`G-98`，2026-09-29 權限盤點）：貼標、存客服預存共用的那一道。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertWorkspaceTagIds, clearTagOwnerCache, filterWorkspaceTagIds, tagNamesForAudit } from './workspace-tag-ids'

// Nitro 的 auto-import 在 vitest 裡沒有
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const WS = 'ws1'

function fakeDb(tags: Record<string, Record<string, unknown>>) {
  const getAllSizes: number[] = []
  const db: any = {
    collection: (col: string) => ({
      doc: (id: string) => {
        // 跟真的 Firestore 一樣：不合法的 id 在建 ref 時就炸（驗「先擋掉」真的有擋）
        if (id.includes('/')) throw new Error(`invalid doc id ${id}`)
        return { col, id }
      },
    }),
    getAll: async (...refs: Array<{ id: string }>) => {
      getAllSizes.push(refs.length)
      return refs.map(r => ({ id: r.id, exists: tags[r.id] != null, data: () => tags[r.id] }))
    },
  }
  return { db, getAllSizes }
}

beforeEach(() => {
  clearTagOwnerCache()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('filterWorkspaceTagIds', () => {
  it('自家的留下、別家的與不存在的丟掉，原因分得出來', async () => {
    const { db } = fakeDb({
      a: { workspaceId: WS, name: 'VIP' },
      b: { workspaceId: 'ws2', name: '別家' },
    })
    const r = await filterWorkspaceTagIds(db, WS, ['a', 'b', 'c'])
    expect(r.kept).toEqual(['a'])
    expect(r.dropped).toEqual([
      { tagId: 'b', reason: 'other_workspace' },
      { tagId: 'c', reason: 'not_found' },
    ])
    // 名字只給自家的（寫稽核摘要用）；⛔ 別家的名字不可以跑出來
    expect(r.names).toEqual({ a: 'VIP' })
  })

  it('🔴 含 / 之類不合法的 id 先擋掉，不會讓整支端點炸成 500', async () => {
    const { db } = fakeDb({ a: { workspaceId: WS } })
    const r = await filterWorkspaceTagIds(db, WS, ['a', 'x/y', '', '__x__', '..'])
    expect(r.kept).toEqual(['a'])
    expect(r.dropped.map(d => d.reason)).toEqual(['invalid', 'invalid', 'invalid', 'invalid'])
  })

  it('去重、照輸入順序；不是陣列就當空的', async () => {
    const { db } = fakeDb({ a: { workspaceId: WS }, b: { workspaceId: WS } })
    expect((await filterWorkspaceTagIds(db, WS, ['b', 'a', 'b'])).kept).toEqual(['b', 'a'])
    expect(await filterWorkspaceTagIds(db, WS, 'a')).toEqual({ kept: [], dropped: [], names: {} })
  })

  it('停用的標籤照留（刪除是軟刪除，既有貼標路徑本來就收）', async () => {
    const { db } = fakeDb({ a: { workspaceId: WS, status: 'inactive' } })
    expect((await filterWorkspaceTagIds(db, WS, ['a'])).kept).toEqual(['a'])
  })

  it('一次讀太多會分批 getAll', async () => {
    const tags: Record<string, Record<string, unknown>> = {}
    const ids = Array.from({ length: 650 }, (_, i) => `t${i}`)
    ids.forEach((id) => { tags[id] = { workspaceId: WS } })
    const { db, getAllSizes } = fakeDb(tags)
    const r = await filterWorkspaceTagIds(db, WS, ids)
    expect(r.kept).toHaveLength(650)
    expect(getAllSizes).toEqual([300, 300, 50])
  })

  it('沒開快取的呼叫端（後台端點）每次都讀最新的', async () => {
    const { db, getAllSizes } = fakeDb({ a: { workspaceId: WS } })
    await filterWorkspaceTagIds(db, WS, ['a'], { cache: true })
    await filterWorkspaceTagIds(db, WS, ['a'])
    expect(getAllSizes).toEqual([1, 1])
  })

  it('🔴 存設定時有一顆不是自家的 → 400，而且訊息不透露「別家有這顆」', async () => {
    const { db } = fakeDb({ a: { workspaceId: WS }, b: { workspaceId: 'ws2' } })
    const err = await assertWorkspaceTagIds(db, WS, ['a', 'b'], 'test').catch(e => e)
    expect(err).toMatchObject({ statusCode: 400 })
    expect(String(err.statusMessage)).toContain('找不到')
    // 別家的與不存在的講同一句話
    const err2 = await assertWorkspaceTagIds(db, WS, ['a', 'zzz'], 'test').catch(e => e)
    expect(err2.statusMessage).toBe(err.statusMessage)
  })

  it('全是自家的、或根本沒選 → 放行（沒選就不讀資料庫）', async () => {
    const { db, getAllSizes } = fakeDb({ a: { workspaceId: WS } })
    await expect(assertWorkspaceTagIds(db, WS, ['a'], 'test')).resolves.toBeUndefined()
    await expect(assertWorkspaceTagIds(db, WS, [], 'test')).resolves.toBeUndefined()
    expect(getAllSizes).toEqual([1])
  })

  it('稽核用的標籤名：太多就「等 N 個」，名字讀不到退回 id（不印空白引號）', () => {
    expect(tagNamesForAudit(['a', 'b'], { a: 'VIP', b: '回購' })).toBe('「VIP」「回購」')
    expect(tagNamesForAudit(['a', 'x'], { a: 'VIP' })).toBe('「VIP」「x」')
    expect(tagNamesForAudit(['a', 'b', 'c'], {}, 2)).toBe('「a」「b」等 3 個標籤')
  })

  it('⛔ 查不到的不進快取：標籤剛建好時不會被記成不存在', async () => {
    const tags: Record<string, Record<string, unknown>> = {}
    const { db } = fakeDb(tags)
    expect((await filterWorkspaceTagIds(db, WS, ['new'], { cache: true })).kept).toEqual([])
    tags.new = { workspaceId: WS }
    expect((await filterWorkspaceTagIds(db, WS, ['new'], { cache: true })).kept).toEqual(['new'])
  })
})
