/**
 * 通知名單跟「存 AI 設定」之間的規矩（`C-271`①⑫⑮，2026-09-27）。
 *
 * ① 存 AI 設定（還有小幫手改提醒分鐘、操作紀錄「還原」）⛔ 不可以把名單蓋掉：
 *    原本拿這台機器 60 秒快取裡的舊設定整份 set 回去，剛掃 QR 加進來的人被洗掉、手機卻已經收到「好了」。
 * ⑫ 不經快取的讀法 ⛔ 不清共用快取（原本等 QR 時每 2.5 秒清一次，送訊息熱路徑一直重讀）。
 * ⑮ 舊資料「名單有人但 enabled=false」在 normalize 一處收成空名單，讀的地方只看 lineUserIds。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({
  store: { doc: null as any, reads: 0, sets: [] as { data: any, opts: any }[] },
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('./firebase', () => ({
  getDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => { store.reads++; return { exists: store.doc != null, data: () => store.doc } },
        set: async (data: any, opts: any) => { store.sets.push({ data, opts }) },
      }),
    }),
  }),
}))

import { getAiSettings, invalidateAiSettingsCache, normalizeAiSettings, readAiSettingsFresh, setAiSettings } from './ai-settings'

const U1 = `U${'1'.repeat(32)}`
const U2 = `U${'2'.repeat(32)}`

beforeEach(() => {
  invalidateAiSettingsCache('W')
  store.doc = { handoffNotify: { enabled: true, lineUserIds: [U1], displayNames: { [U1]: '舊的' }, mode: 'always', slaRemindMinutes: 30, digestHour: 9 } }
  store.reads = 0
  store.sets = []
})

describe('setAiSettings ⛔ 不碰通知名單', () => {
  it('🔴 快取裡是舊名單、別台剛加了一位 → 存 AI 設定之後那一位還在（名單三格不寫、用 merge）', async () => {
    await getAiSettings('W') // 這台快取＝只有 U1
    store.doc = { ...store.doc, handoffNotify: { ...store.doc.handoffNotify, lineUserIds: [U1, U2] } } // 別台（webhook）加了 U2
    await setAiSettings('W', { replyMode: 'draft' } as never)
    const { data, opts } = store.sets[0]!
    expect(opts).toEqual({ merge: true })
    expect(data.replyMode).toBe('draft')
    expect(data.handoffNotify).not.toHaveProperty('lineUserIds')
    expect(data.handoffNotify).not.toHaveProperty('displayNames')
    expect(data.handoffNotify).not.toHaveProperty('enabled')
    // 其他幾格照寫（提醒分鐘、摘要時間這些還是走這支）
    expect(data.handoffNotify).toMatchObject({ mode: 'always', slaRemindMinutes: 30, digestHour: 9 })
  })

  it('小幫手只改提醒分鐘 → 只動那一格，名單一樣不寫', async () => {
    await setAiSettings('W', { handoffNotify: { slaRemindMinutes: 45 } } as never)
    const { data } = store.sets[0]!
    expect(data.handoffNotify.slaRemindMinutes).toBe(45)
    expect(data.handoffNotify).not.toHaveProperty('lineUserIds')
  })

  it('現值讀的是資料庫、不是這台的快取（合併的底是新的）', async () => {
    await getAiSettings('W')
    store.doc = { ...store.doc, shopUrl: 'https://new.example.com' }
    await setAiSettings('W', { replyMode: 'draft' } as never)
    expect(store.sets[0]!.data.shopUrl).toBe('https://new.example.com')
  })
})

describe('readAiSettingsFresh', () => {
  it('每次都讀資料庫，而且 ⛔ 不清共用快取（`C-271`⑫）', async () => {
    await getAiSettings('W') // 讀 1 次，進快取
    await readAiSettingsFresh('W') // 讀 1 次
    await readAiSettingsFresh('W') // 讀 1 次
    await getAiSettings('W') // 快取還在 → 不讀
    expect(store.reads).toBe(3)
  })
})

describe('normalizeAiSettings：舊資料「名單有人但關著」一處收掉（`C-271`⑮）', () => {
  it('enabled=false 的舊名單讀出來是空名單、enabled=false', () => {
    const s = normalizeAiSettings({ handoffNotify: { enabled: false, lineUserIds: [U1], displayNames: { [U1]: 'x' } } })
    expect(s.handoffNotify.lineUserIds).toEqual([])
    expect(s.handoffNotify.displayNames).toEqual({})
    expect(s.handoffNotify.enabled).toBe(false)
  })
  it('名單有人＝enabled；名單空＝不 enabled（enabled 由名單推出來）', () => {
    expect(normalizeAiSettings({ handoffNotify: { enabled: true, lineUserIds: [U1] } }).handoffNotify.enabled).toBe(true)
    expect(normalizeAiSettings({ handoffNotify: { enabled: true, lineUserIds: [] } }).handoffNotify.enabled).toBe(false)
  })
})
