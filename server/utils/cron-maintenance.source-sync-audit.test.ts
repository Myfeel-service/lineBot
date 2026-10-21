/**
 * 排程自動同步也要進操作紀錄、擋下時要講對原因（`C-308`⑤⑥，2026-10-13）。
 *
 * ⑥ 以前只有手按「立即同步」才記，每小時自動新增／刪掉的知識、網頁小改自動套用，一筆都查不到——
 *    「AI 怎麼突然不會答了」沒有答案。現在記一筆 actor＝system（⛔ 不掛在任何人頭上），
 *    但只在真的有動到東西時記（不然每小時一筆「什麼都沒發生」洗掉整頁紀錄），而且記不成也不打斷同步。
 * ⑤ 表格一次少太多列被擋下：原因要講「按立即同步確認」、記 blockedPendingDeletes 讓畫面分得出
 *    「擋下了」跟「讀不到表」；擋著的時候每小時又擋一次，紀錄只記第一次。
 */
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) },
  Timestamp: { now: () => ({ __ts: 'now' }), fromMillis: (ms: number) => ({ __ts: ms }) },
}))
const { clearSourceFailure, markSourceOutdated, saveAppliedPage } = vi.hoisted(() => ({
  clearSourceFailure: vi.fn(async () => {}),
  markSourceOutdated: vi.fn(async () => {}),
  saveAppliedPage: vi.fn(async () => {}),
}))
vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  buildSourceClearFailure: () => ({}),
  clearSourceFailure,
  countSourceChunks: vi.fn(async () => 20),
  markSourceOutdated,
  saveAppliedPage,
}))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
const { tryAutoApplyMinorChange, tryAutoApplyPageChange } = vi.hoisted(() => ({ tryAutoApplyMinorChange: vi.fn(), tryAutoApplyPageChange: vi.fn() }))
vi.mock('./ai-knowledge-autoapply', () => ({ tryAutoApplyMinorChange, tryAutoApplyPageChange }))
const { extractUrlText } = vi.hoisted(() => ({ extractUrlText: vi.fn() }))
vi.mock('./ai-source-extractors', () => ({ extractUrlText }))
vi.mock('./gemini', () => ({ runWithLlmBudget: (_w: string, fn: () => unknown) => fn() }))
const { syncGoogleSheetSource } = vi.hoisted(() => ({ syncGoogleSheetSource: vi.fn() }))
vi.mock('./gsheet-sync', async importOriginal => ({
  // 紀錄那一句用真的（手按跟排程同一句話）
  gsheetSyncAuditNote: (await importOriginal<typeof import('./gsheet-sync')>()).gsheetSyncAuditNote,
  syncGoogleSheetSource,
}))
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('./audit-log', () => ({ writeAuditLog }))
vi.mock('./webhook-dedup', () => ({ WEBHOOK_EVENT_LOCKS_COLLECTION: 'webhookEventLocks' }))
vi.mock('./line', () => ({ pushMessage: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(), notifyOverdueHandoffBatch: vi.fn() }))
vi.mock('./conversation-session', () => ({ closeConversationSession: vi.fn(), handBackSessionToBot: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
vi.mock('./knowledge-source-files', () => ({ deleteSourceFiles: vi.fn(async () => {}) }))

import { detectSourceUpdates } from './cron-maintenance'

/** 假 Firestore：撈候選來源那一支查詢回 SOURCES；來源的 update 收進 UPDATES */
let SOURCES: Array<{ id: string, data: Record<string, any> }> = []
let UPDATES: Array<{ id: string, payload: Record<string, any> }> = []
function makeDb(): any {
  const q: any = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    startAfter: () => q,
    get: async () => ({ size: SOURCES.length, docs: SOURCES.map(s => ({ id: s.id, data: () => s.data })) }),
  }
  return {
    collection: (col: string) => {
      if (col === 'cronState') return { doc: () => ({ get: async () => ({ data: () => undefined }), set: async () => {} }) }
      return {
        ...q,
        doc: (id: string) => ({
          update: async (payload: Record<string, any>) => { UPDATES.push({ id, payload }) },
          collection: () => ({ doc: () => ({ set: async () => {} }) }),
        }),
      }
    },
  }
}

const sheet = (extra: Record<string, any> = {}) => ({
  id: 'sheet1',
  data: { workspaceId: 'ws1', type: 'gsheet', name: '價目表', refreshIntervalMinutes: 60, status: 'ready', ...extra },
})
const synced = (extra: Record<string, any> = {}) => ({ outcome: 'synced', added: 0, updated: 0, deleted: 0, kept: 5, manualKept: 0, quotaSkipped: 0, ...extra })
const auditCalls = () => writeAuditLog.mock.calls.map(c => (c as unknown as [Record<string, any>])[0])

beforeEach(() => {
  vi.clearAllMocks()
  SOURCES = []
  UPDATES = []
  // 預設：沒有上一版原文（舊資料）→ 照舊路（`C-368`）
  tryAutoApplyPageChange.mockResolvedValue({ kind: 'legacy', usedAi: false })
})

describe('試算表自動同步的操作紀錄（`C-308`⑥）', () => {
  it('有新增／刪除 → 記一筆 actor＝system、uid 空的，講幾條、講沒收的列', async () => {
    SOURCES = [sheet()]
    syncGoogleSheetSource.mockResolvedValue(synced({ added: 2, deleted: 1, quotaSkipped: 3 }))
    await detectSourceUpdates(makeDb())
    expect(auditCalls()).toHaveLength(1)
    const a = auditCalls()[0]!
    expect(a).toMatchObject({ workspaceId: 'ws1', uid: '', actor: 'system', action: 'source.gsheetSync', targetId: 'sheet1' })
    expect(a.after).toMatchObject({ added: 2, updated: 0, deleted: 1 })
    expect(a.note).toContain('新增 2')
    expect(a.note).toContain('有 3 列因為 AI 知識量滿了沒有新增')
    expect(a.note).toContain('每小時自動同步')
  })

  it('⛔ 什麼都沒動（沒新增、沒更新、沒刪、沒收的列數也沒變）→ 不記', async () => {
    SOURCES = [sheet({ quotaSkippedCount: 3 })]
    syncGoogleSheetSource.mockResolvedValue(synced({ quotaSkipped: 3 }))
    await detectSourceUpdates(makeDb())
    expect(writeAuditLog).not.toHaveBeenCalled()
    syncGoogleSheetSource.mockResolvedValue({ outcome: 'unchanged', added: 0, updated: 0, deleted: 0, kept: 5 })
    await detectSourceUpdates(makeDb())
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('記不成也不打斷同步：失敗標記照清、這一輪照算成功', async () => {
    SOURCES = [sheet()]
    syncGoogleSheetSource.mockResolvedValue(synced({ added: 1 }))
    writeAuditLog.mockRejectedValueOnce(new Error('audit down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await detectSourceUpdates(makeDb())
    expect(r).toMatchObject({ gsheetSynced: 1, errors: 0 })
    expect(clearSourceFailure).toHaveBeenCalledWith(expect.anything(), 'sheet1', 'ready')
    warn.mockRestore()
  })

  it('同步途中資料被刪了（`C-308`③）→ ⛔ 不清失敗標記（文件已不在）、不記「同步了」', async () => {
    SOURCES = [sheet()]
    syncGoogleSheetSource.mockResolvedValue({ outcome: 'source_deleted', added: 0, updated: 0, deleted: 0, kept: 0 })
    await detectSourceUpdates(makeDb())
    expect(clearSourceFailure).not.toHaveBeenCalled()
    expect(writeAuditLog).not.toHaveBeenCalled()
  })
})

describe('表格一次少太多列被擋下（`C-308`⑤）', () => {
  // `C-319`：按鈕改叫「立即更新」
  it('原因講「按立即更新」、⛔ 不講分享；記 blockedPendingDeletes；第一次擋下記一筆紀錄', async () => {
    SOURCES = [sheet()]
    syncGoogleSheetSource.mockResolvedValue({ outcome: 'blocked_mass_deletion', added: 0, updated: 0, deleted: 0, kept: 40, pendingDeletes: 15 })
    await detectSourceUpdates(makeDb())
    const p = UPDATES.find(u => u.id === 'sheet1')!.payload
    expect(p.failureReason).toBe('表格一次少了 15 列（現有 40 條）。為了避免誤刪，自動同步先停下來了；確定是你刪的，請到這份資料按「立即更新」。')
    expect(p.failureReason).not.toMatch(/分享|張|卡/)
    expect(p).toMatchObject({ status: 'failed', blockedPendingDeletes: 15 })
    expect(auditCalls()).toHaveLength(1)
    expect(auditCalls()[0]!.note).toContain('自動同步先停下來了')
  })

  it('擋著的時候每小時又擋一次（列數一樣）→ ⛔ 不再記一筆', async () => {
    SOURCES = [sheet({ blockedPendingDeletes: 15 })]
    syncGoogleSheetSource.mockResolvedValue({ outcome: 'blocked_mass_deletion', added: 0, updated: 0, deleted: 0, kept: 40, pendingDeletes: 15 })
    await detectSourceUpdates(makeDb())
    expect(writeAuditLog).not.toHaveBeenCalled()
  })
})

describe('網頁小改自動套用的操作紀錄（`C-308`⑥）', () => {
  it('自動換了內容 → 記一筆 source.resyncApply、actor＝system，講更新幾條', async () => {
    const text = '新的網頁內容'
    SOURCES = [{
      id: 'url1',
      data: {
        workspaceId: 'ws1', type: 'url', url: 'https://shop.example.tw/faq', name: '官網 FAQ', refreshIntervalMinutes: 1440,
        contentHash: 'old', appliedContentHash: 'old', observedHash: createHash('sha256').update(text).digest('hex'), status: 'ready',
      },
    }]
    extractUrlText.mockResolvedValue({ text, rawLength: text.length })
    tryAutoApplyMinorChange.mockResolvedValue({ applied: true, noop: false, updated: 2, failed: 1, reason: '' })
    const r = await detectSourceUpdates(makeDb())
    expect(r).toMatchObject({ autoApplied: 1 })
    expect(auditCalls()).toHaveLength(1)
    expect(auditCalls()[0]).toMatchObject({ actor: 'system', uid: '', action: 'source.resyncApply', targetId: 'url1', after: { updated: 2 } })
    expect(auditCalls()[0]!.note).toContain('更新 2 條，1 條沒有套用成功')
  })
})

/**
 * `C-368`：先比網頁。照網頁那一條路的結果，排程要怎麼收尾。
 * 來源都是「連兩輪抓到同一份新內容」＝確認變了的那一刻（observedHash＝這次的指紋）。
 */
describe('先比網頁、沒衝突就自動做完（`C-368`）', () => {
  const text = '首頁換了一批商品'
  const hash = createHash('sha256').update(text).digest('hex')
  const homepage = (extra: Record<string, any> = {}) => ({
    id: 'home',
    data: {
      workspaceId: 'ws1', type: 'url', url: 'https://www.myfeel-tw.com/', name: '官網首頁', refreshIntervalMinutes: 1440,
      contentHash: 'old', appliedContentHash: 'old', observedHash: hash, status: 'ready', generateOverview: true, ...extra,
    },
  })
  const record = { added: 15, removed: 2, updated: 0, addedTitles: ['乾淨方MAX'], removedTitles: ['DEAR.min'], updatedTitles: [], quotaSkipped: 0, overviewUpdated: true }
  const homeUpdates = () => UPDATES.filter(u => u.id === 'home').map(u => u.payload)

  beforeEach(() => {
    extractUrlText.mockResolvedValue({ text, rawLength: text.length })
  })

  it('型錄也照網頁自動做完：推進版本、存原文、清掉「有變動」、記一行紀錄與操作紀錄，⛔ 不走舊路', async () => {
    SOURCES = [homepage()]
    tryAutoApplyPageChange.mockResolvedValue({ kind: 'applied', usedAi: true, fingerprintSafe: true, failed: 0, record })
    const r = await detectSourceUpdates(makeDb())
    expect(r).toMatchObject({ autoApplied: 1 })
    expect(tryAutoApplyMinorChange).not.toHaveBeenCalled()
    const p = homeUpdates().find(x => x.lastAutoUpdate)!
    expect(p).toMatchObject({ contentHash: hash, appliedContentHash: hash, outdatedAt: null, outdatedReason: null, chunkCount: 20 })
    expect(p.lastAutoUpdate).toMatchObject({ added: 15, removed: 2, overviewUpdated: true })
    expect(saveAppliedPage).toHaveBeenCalledWith(expect.anything(), 'home', text, hash)
    expect(markSourceOutdated).not.toHaveBeenCalled()
    expect(auditCalls()[0]).toMatchObject({ actor: 'system', action: 'source.resyncApply', targetId: 'home' })
    expect(auditCalls()[0]!.note).toContain('新增 15、拿掉 2')
    expect(auditCalls()[0]!.note).toContain('總覽跟著換成現在的')
  })

  it('⛔ 空間不夠沒加完：做完的照留，但不推進版本、不存原文，標「有變動」並寫原因', async () => {
    SOURCES = [homepage()]
    tryAutoApplyPageChange.mockResolvedValue({
      kind: 'applied', usedAi: true, fingerprintSafe: false, failed: 0,
      reason: { kind: 'quota', count: 5 }, record: { ...record, added: 10, quotaSkipped: 5 },
    })
    await detectSourceUpdates(makeDb())
    const p = homeUpdates().find(x => x.lastAutoUpdate)!
    expect(p.appliedContentHash).toBeUndefined()
    expect(saveAppliedPage).not.toHaveBeenCalled()
    expect(markSourceOutdated).toHaveBeenCalledWith(expect.anything(), 'home', { kind: 'quota', count: 5 })
    expect(auditCalls()[0]!.note).toContain('還有 5 條新的沒有加進來')
  })

  it('網頁一行都沒改（只有順序、空白）→ 推進版本、存原文、不標、不花 AI', async () => {
    SOURCES = [homepage({ outdatedAt: { __ts: 1 } })]
    tryAutoApplyPageChange.mockResolvedValue({ kind: 'noop', usedAi: false })
    await detectSourceUpdates(makeDb())
    expect(homeUpdates().some(x => x.appliedContentHash === hash && x.outdatedAt === null)).toBe(true)
    expect(saveAppliedPage).toHaveBeenCalledWith(expect.anything(), 'home', text, hash)
    expect(markSourceOutdated).not.toHaveBeenCalled()
  })

  it('有衝突（動到手改過的）→ 標「有變動」並帶原因', async () => {
    SOURCES = [homepage()]
    tryAutoApplyPageChange.mockResolvedValue({ kind: 'manual', usedAi: true, reason: { kind: 'manual_edit', count: 1 } })
    const r = await detectSourceUpdates(makeDb())
    expect(r).toMatchObject({ changedNotified: 1 })
    expect(markSourceOutdated).toHaveBeenCalledWith(expect.anything(), 'home', { kind: 'manual_edit', count: 1 })
    expect(saveAppliedPage).not.toHaveBeenCalled()
  })

  it('⛔ 這一輪請 AI 的名額用完了：先不收（不推進 contentHash），下一輪再來；不標「有變動」', async () => {
    SOURCES = [homepage()]
    tryAutoApplyPageChange.mockResolvedValue({ kind: 'needs_ai', usedAi: false })
    await detectSourceUpdates(makeDb())
    expect(homeUpdates().every(x => x.contentHash === undefined)).toBe(true)
    expect(markSourceOutdated).not.toHaveBeenCalled()
  })
})
