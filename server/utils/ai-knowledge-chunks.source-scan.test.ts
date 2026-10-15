/**
 * `C-325`：答題、建索引用的商品名＝「現在有資料在用的」，不再讀只增不減的 knowledgeProductIndex.names。
 *
 * 災情：MYFEEL 的 names 留著官網首頁被認成的「MYFEEL全品項總覽」（資料上早就拿掉了），
 * 對話裡出現店名 MYFEEL 就鎖到這台不存在的商品、所有商品的資料都被擋掉（近 60 天 23 次轉真人）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { getCatalogSourceIds } from './ai-knowledge-sources'
import { getWorkspaceProductNames, invalidateWorkspaceProductNames } from './ai-knowledge-chunks'

type Doc = { id: string; data: Record<string, unknown> }

/** 只實作掃描用到的 collection().where().select().limit().get()；names 那份文件放在另一個集合，掃描不該讀到 */
function fakeDb(sources: Doc[]) {
  let reads = 0
  const db = {
    collection: (name: string) => ({
      where: (_f: string, _op: string, ws: string) => ({
        select: () => ({
          limit: () => ({
            get: async () => {
              reads++
              if (name !== 'knowledgeSources') throw new Error(`不該讀 ${name}`)
              const docs = sources.filter(s => s.data.workspaceId === ws)
              return { docs: docs.map(s => ({ id: s.id, data: () => s.data })) }
            },
          }),
        }),
      }),
    }),
  }
  return { db: db as any, reads: () => reads }
}

beforeEach(() => invalidateWorkspaceProductNames())

describe('getWorkspaceProductNames（在用的商品名）', () => {
  it('只算還在的資料：刪掉的（isDeleted／deletedAt）不算，同一個寫法只留一個', async () => {
    const { db } = fakeDb([
      { id: 'a', data: { workspaceId: 'w1', productName: 'SHARP 自動調理零水鍋' } },
      { id: 'b', data: { workspaceId: 'w1', productName: 'SHARP  自動調理零水鍋' } },
      { id: 'c', data: { workspaceId: 'w1', productName: 'MYFEEL全品項總覽', isDeleted: true } },
      { id: 'd', data: { workspaceId: 'w1', productName: '舊的商品', deletedAt: new Date() } },
      { id: 'e', data: { workspaceId: 'w1', productName: '' } },
      { id: 'f', data: { workspaceId: 'w2', productName: '別家的商品' } },
    ])
    expect(await getWorkspaceProductNames(db, 'w1')).toEqual(['SHARP 自動調理零水鍋'])
  })

  it('跟型錄來源共用同一次掃描（答題不多讀一次）', async () => {
    const { db, reads } = fakeDb([
      { id: 'cat', data: { workspaceId: 'w1', generateOverview: true } },
      { id: 'p', data: { workspaceId: 'w1', productName: 'BOYA mini2' } },
    ])
    expect([...(await getCatalogSourceIds(db, 'w1'))]).toEqual(['cat'])
    expect(await getWorkspaceProductNames(db, 'w1')).toEqual(['BOYA mini2'])
    expect(reads()).toBe(1)
  })
})
