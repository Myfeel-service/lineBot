/**
 * `C-436`：商品目錄編輯畫面的資料與「換圖」動作。
 * 釘這幾件事：
 *   ① 每個商品分得出：在目錄上／第 11 張以後沒放上去／勾了沒圖／沒勾／表上找不到；表上找不到的排最後。
 *   ② 標籤顯示名稱（⛔ 別的帳號的標籤不顯示）；還沒同步出商品清單＝ready false。
 *   ③ ⛔ 不是這個帳號的試算表＝404。
 *   ④ 換圖只收這個帳號自己上傳區的網址；改回要真的換過；寫操作紀錄。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) } }))
vi.stubGlobal('createError', (e: { statusCode: number, statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
const body = { current: {} as Record<string, unknown> }
vi.stubGlobal('readBody', async () => body.current)

const store: Record<string, Record<string, any>> = {}
function col(name: string) {
  store[name] ??= {}
  const docs = store[name]!
  const ref = (id: string): any => ({
    id,
    get: async () => ({ id, exists: id in docs, get: (k: string) => docs[id]?.[k], data: () => docs[id] }),
    set: async (v: any) => { docs[id] = { ...v } },
    update: async (v: any) => { docs[id] = { ...docs[id], ...v } },
  })
  return { doc: ref }
}
const db: any = {
  collection: col,
  runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({ get: (r: any) => r.get(), set: (r: any, v: any) => { void r.set(v) }, update: (r: any, v: any) => { void r.update(v) } }),
}
vi.mock('./firebase', () => ({ getDb: () => db }))
vi.mock('./workspace-auth', () => ({ requireCapability: vi.fn(async () => ({ workspaceId: 'ws1', uid: 'u1' })) }))
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('./audit-log', () => ({ writeAuditLog }))
vi.mock('./ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))
const { invalidateSheetIssuesCache } = vi.hoisted(() => ({ invalidateSheetIssuesCache: vi.fn() }))
vi.mock('./sheet-issues', () => ({ invalidateSheetIssuesCache }))

const { readSheetCatalogView, handleSheetProductImage, handleSheetProductDecision, isOwnUploadUrl } = await import('./sheet-catalog-editor')
const { syncSheetProducts } = await import('./sheet-products')

const card = (title: string, checked: boolean) => ({ title, content: `商品頁面：https://a.com/${encodeURIComponent(title)}`, tags: [], controls: { 放進LINE目錄: checked ? 'TRUE' : 'FALSE' } })
const OWN = 'https://storage.googleapis.com/bkt/uploads/ws1/abc.jpg'
const prod = (title: string) => Object.values(store.sheetProductRegistries!.src1.products as Record<string, any>).find(p => p.title === title)!

beforeEach(async () => {
  for (const k of Object.keys(store)) delete store[k]
  writeAuditLog.mockClear()
  store.knowledgeSources = { src1: { workspaceId: 'ws1', type: 'gsheet', name: '客服（商品資訊）', url: 'https://docs.google.com/spreadsheets/d/x', lastFetchedAt: { toMillis: () => 1234 } } }
})

async function seed(rows: Array<[string, boolean]>) {
  await syncSheetProducts(db, 'ws1', 'src1', { cards: rows.map(([t, c]) => card(t, c)), fieldHeaders: ['商品頁面'], controlHeaders: ['放進LINE目錄'] })
}

describe('① ② 編輯畫面的資料', () => {
  it('還沒同步出商品清單：ready false，試算表名稱、網址照樣給（畫面要能講「按立即更新」）', async () => {
    const v = await readSheetCatalogView(db, 'ws1', 'src1')
    expect(v).toMatchObject({ ready: false, sourceName: '客服（商品資訊）', sheetUrl: 'https://docs.google.com/spreadsheets/d/x', lastFetchedAt: 1234, products: [] })
  })

  it('⭐ 每個商品分組；標籤顯示名稱；表上找不到的排最後', async () => {
    const rows: Array<[string, boolean]> = [['A', true], ['B', true], ['C', false]]
    for (let i = 1; i <= 11; i++) rows.push([`M${i}`, true])
    await seed(rows)
    const reg = store.sheetProductRegistries!.src1
    for (const p of Object.values(reg.products as Record<string, any>)) {
      if (p.title !== 'B') p.cover = { url: `https://s/${p.title}.jpg`, fromUrlKey: 'x', at: 1 }
    }
    prod('A').tagId = 'tag-a'
    store.tags = { 'tag-a': { workspaceId: 'ws1', name: '客服 - A' } }
    await seed([...rows.slice(1), ['A', true]].filter(([t]) => t !== 'C') as Array<[string, boolean]>) // C 被刪掉、A 換到最後
    const v = await readSheetCatalogView(db, 'ws1', 'src1')
    const place = Object.fromEntries(v.products.map(p => [p.title, p.placement]))
    expect(place.B).toBe('noImage')
    expect(place.C).toBe('missing')
    expect(v.products.at(-1)!.title).toBe('C')
    expect(v.products.filter(p => p.placement === 'card')).toHaveLength(10)
    // 表上現在的順序：B、M1…M11、A（B 沒圖）→ 前 10 張是 M1…M10，第 11 張以後的是 M11、A
    expect(v.products.filter(p => p.placement === 'card').map(p => p.title)).toEqual(Array.from({ length: 10 }, (_, i) => `M${i + 1}`))
    expect(v.products.filter(p => p.placement === 'overflow').map(p => p.title)).toEqual(['M11', 'A'])
    expect(v.products.find(p => p.title === 'A')!.tag).toEqual({ id: 'tag-a', name: '客服 - A' })
    expect(v.changes.length).toBeGreaterThan(0)
  })

  it('⛔ 別的帳號的標籤不顯示名稱', async () => {
    await seed([['A', true]])
    prod('A').tagId = 'tag-x'
    store.tags = { 'tag-x': { workspaceId: 'other', name: '別人的' } }
    const v = await readSheetCatalogView(db, 'ws1', 'src1')
    expect(v.products[0]!.tag).toBeNull()
  })

  it('③ ⛔ 不是這個帳號的試算表、不是試算表＝404', async () => {
    store.knowledgeSources!.src1.workspaceId = 'other'
    await expect(readSheetCatalogView(db, 'ws1', 'src1')).rejects.toMatchObject({ statusCode: 404 })
    store.knowledgeSources!.src1 = { workspaceId: 'ws1', type: 'url' }
    await expect(readSheetCatalogView(db, 'ws1', 'src1')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('④ 換圖／改回', () => {
  it('只收這個帳號自己上傳區的網址', () => {
    expect(isOwnUploadUrl(OWN, 'ws1')).toBe(true)
    expect(isOwnUploadUrl('https://storage.googleapis.com/bkt/uploads/ws2/abc.jpg', 'ws1')).toBe(false)
    expect(isOwnUploadUrl('https://evil.com/uploads/ws1/abc.jpg', 'ws1')).toBe(false)
    expect(isOwnUploadUrl('', 'ws1')).toBe(false)
  })

  it('⭐ 換圖 → 用自己的、寫操作紀錄；改回 → 用封面圖', async () => {
    await seed([['A', true]])
    prod('A').cover = { url: 'https://s/cover.jpg', fromUrlKey: 'x', at: 1 }
    const id = prod('A').id
    body.current = { sourceId: 'src1', productId: id, url: OWN }
    expect(await handleSheetProductImage({} as any)).toEqual({ image: { url: OWN, source: 'own' }, hasCover: true })
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'sheetProduct.image', note: 'A' }))
    body.current = { sourceId: 'src1', productId: id, revert: true }
    expect(await handleSheetProductImage({} as any)).toEqual({ image: { url: 'https://s/cover.jpg', source: 'web' }, hasCover: true })
  })

  it('`C-438` 換上圖之後：「抓不到圖」那顆提醒下一次就重算（不等 5 分鐘）', async () => {
    await seed([['A', true]])
    body.current = { sourceId: 'src1', productId: prod('A').id, url: OWN }
    await handleSheetProductImage({} as any)
    expect(invalidateSheetIssuesCache).toHaveBeenCalledWith('ws1')
  })

  it('⛔ 別的網址不收；找不到的商品 404；沒換過還按改回 409', async () => {
    await seed([['A', true]])
    const id = prod('A').id
    body.current = { sourceId: 'src1', productId: id, url: 'https://evil.com/x.jpg' }
    await expect(handleSheetProductImage({} as any)).rejects.toMatchObject({ statusCode: 400 })
    body.current = { sourceId: 'src1', productId: 'nope', url: OWN }
    await expect(handleSheetProductImage({} as any)).rejects.toMatchObject({ statusCode: 404 })
    body.current = { sourceId: 'src1', productId: id, revert: true }
    await expect(handleSheetProductImage({} as any)).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('`C-438` 試算表上找不到的商品：是改名／不賣了', () => {
  it('⭐ 名字跟網址一起改了 → 畫面列出候選；按「是，改名成…」→ 舊的接上新名字（圖、標籤跟著舊的），新的那筆收掉', async () => {
    await seed([['10S', true]])
    prod('10S').ownImage = { url: OWN, at: 1 }
    prod('10S').tagId = 'tag-10s'
    const oldId = prod('10S').id
    await seed([['10S Pro', true]]) // 名字和網址都換了：系統不猜
    const newId = prod('10S Pro').id
    const v = await readSheetCatalogView(db, 'ws1', 'src1')
    expect(v.products.find(p => p.id === oldId)).toMatchObject({ placement: 'missing', renameCandidates: [{ id: newId, title: '10S Pro' }] })

    body.current = { sourceId: 'src1', productId: oldId, action: 'rename', newId }
    expect(await handleSheetProductDecision({} as any)).toEqual({ ok: true })
    const products = store.sheetProductRegistries!.src1.products as Record<string, any>
    expect(products[newId]).toBeUndefined()
    expect(products[oldId]).toMatchObject({ title: '10S Pro', missingSince: null, ownImage: { url: OWN }, tagId: 'tag-10s' })
    expect(products[oldId].renameCandidates).toBeUndefined()
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'sheetProduct.rename', note: '「10S」→「10S Pro」' }))
    expect(invalidateSheetIssuesCache).toHaveBeenCalledWith('ws1')
  })

  it('⭐ 不賣了，拿掉 → 從商品清單拿掉、記一筆變動、寫操作紀錄', async () => {
    await seed([['A', true], ['B', true]])
    const a = prod('A').id
    await seed([['B', true]])
    body.current = { sourceId: 'src1', productId: a, action: 'retire' }
    await handleSheetProductDecision({} as any)
    const reg = store.sheetProductRegistries!.src1
    expect(reg.products[a]).toBeUndefined()
    expect(reg.changes[0]).toMatchObject({ kind: 'retired', title: 'A' })
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'sheetProduct.retire', note: 'A' }))
  })

  it('⛔ 還在表上的不收（要到試算表改）；不是候選的新名字不接；不認得的動作 400', async () => {
    await seed([['A', true], ['B', true]])
    body.current = { sourceId: 'src1', productId: prod('A').id, action: 'retire' }
    await expect(handleSheetProductDecision({} as any)).rejects.toMatchObject({ statusCode: 409 })
    await seed([['B', true]])
    body.current = { sourceId: 'src1', productId: prod('A').id, action: 'rename', newId: prod('B').id }
    await expect(handleSheetProductDecision({} as any)).rejects.toMatchObject({ statusCode: 409 })
    body.current = { sourceId: 'src1', productId: prod('A').id, action: 'delete' }
    await expect(handleSheetProductDecision({} as any)).rejects.toMatchObject({ statusCode: 400 })
    expect(prod('A')).toBeTruthy()
  })
})
