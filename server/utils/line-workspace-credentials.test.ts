import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 這一檔只驗「用 liffClientId 反查租戶」的查詢邊界。
 *
 * 為什麼值得測：呼叫它的 /api/liff/config 不需要登入，先前的做法是把整個 workspaces
 * 集合讀進記憶體再比對，任何人用亂編的 liffClientId 就能反覆觸發全表掃描。改成前綴範圍
 * 查詢之後，正確性全押在那兩個邊界值上——`{id}-` 到 `{id}.`（`-` 的下一個字元是 `.`）。
 * 邊界只要寫錯一個字元，`1234` 就會把 `12345-…` 那個租戶一起撈進來，客人會被送去
 * 別的 Login channel 登入。
 */

vi.mock('./firebase', () => ({ getDb: vi.fn() }))

import { getDb } from './firebase'
import {
  findWorkspacesByLiffChannelId,
  getLineWorkspaceCredentials,
  invalidateLineWorkspaceCredentialsCache,
  isPlausibleWorkspaceId,
} from './line-workspace-credentials'

interface FakeWorkspace { id: string, defaultLiffId: string }

/** 只認這支查詢會用到的東西：defaultLiffId 的範圍條件 + limit。字串比較照 JS 的字典序 */
function makeDb(rows: FakeWorkspace[]) {
  const query = (f: { gte?: string, lt?: string, cap?: number }): any => ({
    where: (field: string, op: string, value: string) => {
      if (field !== 'defaultLiffId') return query(f)
      if (op === '>=') return query({ ...f, gte: value })
      if (op === '<') return query({ ...f, lt: value })
      return query(f)
    },
    limit: (n: number) => query({ ...f, cap: n }),
    get: async () => {
      let docs = [...rows].sort((a, b) => a.defaultLiffId.localeCompare(b.defaultLiffId))
      if (f.gte !== undefined) docs = docs.filter(r => r.defaultLiffId >= f.gte!)
      if (f.lt !== undefined) docs = docs.filter(r => r.defaultLiffId < f.lt!)
      if (f.cap !== undefined) docs = docs.slice(0, f.cap)
      return {
        docs: docs.map(r => ({
          id: r.id,
          data: () => ({ defaultLiffId: r.defaultLiffId, channelAccessToken: 'tok', channelSecret: 'sec' }),
        })),
      }
    },
  })
  return { collection: () => query({}) }
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidateLineWorkspaceCredentialsCache()
})

describe('findWorkspacesByLiffChannelId', () => {
  it('找得到前綴相符的那一個租戶', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb([
      { id: 'ws-a', defaultLiffId: '1234567890-abcdefg' },
      { id: 'ws-b', defaultLiffId: '2222222222-hijklmn' },
    ]) as any)

    const rows = await findWorkspacesByLiffChannelId('1234567890')

    expect(rows.map(r => r.workspaceId)).toEqual(['ws-a'])
    expect(rows[0]!.credentials.defaultLiffId).toBe('1234567890-abcdefg')
  })

  it('前綴只是「開頭剛好一樣」的不算：1234 不可以撈到 12345-…', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb([
      { id: 'ws-long', defaultLiffId: '12345-aaaaaaa' },
      { id: 'ws-short', defaultLiffId: '1234-bbbbbbb' },
    ]) as any)

    const rows = await findWorkspacesByLiffChannelId('1234')

    expect(rows.map(r => r.workspaceId)).toEqual(['ws-short'])
  })

  it('兩個租戶共用同一個 Login channel → 兩筆都要回，呼叫端才有辦法拒絕猜', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb([
      { id: 'ws-a', defaultLiffId: '1234567890-aaaaaaa' },
      { id: 'ws-b', defaultLiffId: '1234567890-bbbbbbb' },
      { id: 'ws-c', defaultLiffId: '9999999999-ccccccc' },
    ]) as any)

    const rows = await findWorkspacesByLiffChannelId('1234567890')

    expect(rows.map(r => r.workspaceId).sort()).toEqual(['ws-a', 'ws-b'])
  })

  it('不是純數字的就別查（LIFF 的 Login channel id 一定是數字）', async () => {
    const db = makeDb([{ id: 'ws-a', defaultLiffId: '1234567890-abcdefg' }])
    const spy = vi.spyOn(db, 'collection')
    vi.mocked(getDb).mockReturnValue(db as any)

    expect(await findWorkspacesByLiffChannelId('12ab')).toEqual([])
    expect(await findWorkspacesByLiffChannelId('')).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})

/**
 * `G-105`：`/api/liff/config?workspaceId=亂編` 不用登入，每個亂編的值都會讀一次庫、再塞進快取。
 * 釘兩件事：①明顯不是帳號 id 的值在讀庫前就擋掉，⛔ 但真的帳號 id（uuid、舊的 'default'）一定要過；
 * ②快取有上限，換值猛打不會讓記憶體一直長。
 */
describe('isPlausibleWorkspaceId', () => {
  it('真的帳號 id 一定要過：uuid、舊的 default、Firestore 自動 id', () => {
    expect(isPlausibleWorkspaceId('3f2b9c1e-8a4d-4f6b-9e21-7c5d0a1b2c3d')).toBe(true)
    expect(isPlausibleWorkspaceId('default')).toBe(true)
    expect(isPlausibleWorkspaceId('AbCdEfGhIjKlMnOpQrSt')).toBe(true)
  })

  it('明顯不是的擋掉：含 /、空白、超長、空字串', () => {
    expect(isPlausibleWorkspaceId('a/b')).toBe(false)
    expect(isPlausibleWorkspaceId('ws 1')).toBe(false)
    expect(isPlausibleWorkspaceId('x'.repeat(65))).toBe(false)
    expect(isPlausibleWorkspaceId('')).toBe(false)
    expect(isPlausibleWorkspaceId('<script>')).toBe(false)
  })
})

describe('getLineWorkspaceCredentials 快取上限', () => {
  it('⛔ 換 2001 個不同的 id 猛打，最早那個會被擠出快取（＝快取沒有無上限成長）', async () => {
    let reads = 0
    vi.mocked(getDb).mockReturnValue({
      collection: () => ({
        doc: () => ({ get: async () => { reads++; return { exists: false, data: () => undefined } } }),
      }),
    } as any)

    await getLineWorkspaceCredentials('first')
    await getLineWorkspaceCredentials('first')
    expect(reads).toBe(1) // 快取有作用

    for (let i = 0; i < 2000; i++) await getLineWorkspaceCredentials(`junk-${i}`)
    reads = 0
    await getLineWorkspaceCredentials('first')
    expect(reads).toBe(1) // 被擠掉了，要重讀
    await getLineWorkspaceCredentials('junk-1999')
    expect(reads).toBe(1) // 最近的還在
  })
})
