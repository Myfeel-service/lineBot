/**
 * 資料夾的「通用」那一格（`C-320`）：列表帶出來、改得動、改回商品分組＝拿掉這一格、只改名照舊。
 * 記憶體假 Firestore，正式庫零讀零寫。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const DELETE = Symbol('FieldValue.delete')
  return { DELETE, FieldValue: { serverTimestamp: () => '__ts__', delete: () => DELETE } }
})
vi.mock('firebase-admin/firestore', () => ({ FieldValue: h.FieldValue }))
vi.mock('./ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

type Doc = Record<string, any>
const STORE: Record<string, Doc> = {}
const db: any = {
  collection: () => ({
    // `D-127`：建組、改名前找「已經有同一台的商品分組」（只用 workspaceId 一個條件）
    where: (f: string, _op: string, v: unknown) => ({
      get: async () => ({
        docs: Object.keys(STORE).filter(id => STORE[id]![f] === v).map(id => ({ id, data: () => ({ ...STORE[id] }) })),
      }),
    }),
    doc: (id: string) => ({
      get: async () => ({ exists: !!STORE[id], data: () => (STORE[id] ? { ...STORE[id] } : undefined) }),
      update: async (patch: Doc) => {
        for (const [k, v] of Object.entries(patch)) {
          if (v === h.DELETE) delete STORE[id]![k]
          else STORE[id]![k] = v
        }
      },
    }),
  }),
}

const { createFolder, docToFolderSummary, updateFolder, renameFolder } = await import('./ai-knowledge-folders')

beforeEach(() => {
  for (const k of Object.keys(STORE)) delete STORE[k]
  STORE.f1 = { workspaceId: 'ws1', name: '客服', order: 0 }
})

describe('資料夾的「通用」（C-320）', () => {
  it('列表帶 general：沒有這一格的舊資料夾＝商品分組', () => {
    expect(docToFolderSummary('f1', { name: '客服' }).general).toBe(false)
    expect(docToFolderSummary('f1', { name: '客服', general: true }).general).toBe(true)
  })

  it('改成通用、再改回商品分組（改回＝拿掉這一格，不留 false）', async () => {
    const on = await updateFolder(db, 'ws1', 'f1', { general: true })
    expect(on).toMatchObject({ before: { general: false }, after: { general: true, name: '客服' } })
    expect(STORE.f1!.general).toBe(true)

    const off = await updateFolder(db, 'ws1', 'f1', { general: false })
    expect(off?.after.general).toBe(false)
    expect('general' in STORE.f1!).toBe(false)
  })

  it('只改名照舊、不碰通用那一格', async () => {
    STORE.f1!.general = true
    expect((await renameFolder(db, 'ws1', 'f1', '  客服與總覽  '))?.name).toBe('客服與總覽')
    expect(STORE.f1!.general).toBe(true)
  })

  it('`D-127` 同一台只能有一組：改成跟別的商品分組同名＝400（只差空白大小寫也算）；通用那幾組不算', async () => {
    STORE.f2 = { workspaceId: 'ws1', name: 'SHARP 自動調理零水鍋', order: 1 }
    STORE.f3 = { workspaceId: 'ws1', name: '常見問題', order: 2, general: true }
    STORE.f4 = { workspaceId: 'ws2', name: '零水鍋', order: 0 }
    await expect(updateFolder(db, 'ws1', 'f1', { name: 'sharp 自動調理零水鍋' })).rejects.toMatchObject({ statusCode: 400 })
    expect(STORE.f1!.name).toBe('客服')
    // 通用的同名、別家的同名都不擋；改自己的大小寫也不擋
    expect((await updateFolder(db, 'ws1', 'f1', { name: '常見問題' }))?.after.name).toBe('常見問題')
    expect((await updateFolder(db, 'ws1', 'f1', { name: '零水鍋' }))?.after.name).toBe('零水鍋')
    expect((await updateFolder(db, 'ws1', 'f2', { name: 'sharp 自動調理零水鍋' }))?.after.name).toBe('sharp 自動調理零水鍋')
  })

  it('`D-127` 建商品分組時已經有同一台 → 回那一組（existed），不另建', async () => {
    STORE.f2 = { workspaceId: 'ws1', name: 'SHARP 自動調理零水鍋', order: 1 }
    const res = await createFolder(db, 'ws1', 'SHARP  自動調理零水鍋')
    expect(res).toMatchObject({ id: 'f2', existed: true })
    expect(Object.keys(STORE)).toEqual(['f1', 'f2'])
  })

  it('什麼都沒帶、名字是空的 400；別家的 403；找不到回 null', async () => {
    await expect(updateFolder(db, 'ws1', 'f1', {})).rejects.toMatchObject({ statusCode: 400 })
    await expect(updateFolder(db, 'ws1', 'f1', { name: '  ' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(updateFolder(db, 'ws2', 'f1', { general: true })).rejects.toMatchObject({ statusCode: 403 })
    expect(await updateFolder(db, 'ws1', 'nope', { general: true })).toBeNull()
  })
})
