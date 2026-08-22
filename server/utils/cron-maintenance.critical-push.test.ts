/**
 * 嚴重異常主動推到 LINE（`D-8`②，2026-08-21 老闆拍板做）。
 *
 * 這支會**真的發訊息到商家的手機**，所以釘住的都是「發錯就會被關掉」的行為：
 *   ① 只推 critical。warning／suggestion 推了就是狼來了，久了連真的紅燈也被忽略
 *   ② 🔴「這次查不到」不可以當成壞掉去推——那是把我方的查詢失敗說成商家的災情
 *   ③ 同一件事一天最多一次；修好了要能立刻再講（不是修好後還被冷卻 24 小時）
 *   ④ 🔴 一則都沒送成功就不記「已通知」，否則商家什麼都沒收到卻要等 24 小時才重試
 *   ⑤ 半夜不吵人、關掉開關就完全不查（省掉整套彙總查詢）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) },
  Timestamp: { now: () => ({ __ts: 'now' }), fromMillis: (ms: number) => ({ __ts: ms }) },
}))
vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  buildSourceClearFailure: () => ({}),
  clearSourceFailure: vi.fn(),
  markSourceOutdated: vi.fn(),
}))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
vi.mock('./ai-knowledge-autoapply', () => ({ tryAutoApplyMinorChange: vi.fn() }))
vi.mock('./ai-source-extractors', () => ({ extractUrlText: vi.fn() }))
vi.mock('./gsheet-sync', () => ({ syncGoogleSheetSource: vi.fn() }))
vi.mock('./webhook-dedup', () => ({ WEBHOOK_EVENT_LOCKS_COLLECTION: 'webhookEventLocks' }))
vi.mock('./conversation-session', () => ({ closeConversationSession: vi.fn(), handBackSessionToBot: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(), notifyOverdueHandoffBatch: vi.fn() }))

const { pushMessage } = vi.hoisted(() => ({ pushMessage: vi.fn(async () => {}) }))
vi.mock('./line', () => ({ pushMessage }))
const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))
const { collectWorkspaceAlerts } = vi.hoisted(() => ({ collectWorkspaceAlerts: vi.fn() }))
vi.mock('./workspace-alerts', () => ({ collectWorkspaceAlerts }))

import { pushCriticalAlerts } from './cron-maintenance'
import type { WorkspaceAlertItem } from '~~/shared/types/alerts'

/** 台北時間 10:00＝UTC 02:00，落在允許發送的時段內 */
const DAYTIME = Date.UTC(2026, 7, 21, 2, 0, 0)
/** 台北時間 03:00＝UTC 19:00（前一天） */
const NIGHT = Date.UTC(2026, 7, 20, 19, 0, 0)

let stateDoc: Record<string, unknown> = {}

/**
 * 模擬 Firestore `set(..., { merge: true })`：**巢狀 map 是深合併**，而且會處理
 * `FieldValue.delete()` 哨兵。這兩件事都不能省——「修好了要能立刻再講」靠的正是
 * 把已修好的項目從紀錄裡刪掉，用淺合併的假貨會測出假的結果。
 */
function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && (v as { __op?: string }).__op === 'del') {
      delete target[k]
      continue
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const cur = (target[k] && typeof target[k] === 'object') ? target[k] as Record<string, unknown> : {}
      mergeInto(cur, v as Record<string, unknown>)
      target[k] = cur
      continue
    }
    target[k] = v
  }
}
const setSpy = vi.fn(async (patch: Record<string, unknown>) => {
  mergeInto(stateDoc, patch)
})

function fakeDb(workspaceIds: string[]) {
  return {
    collection: (name: string) => {
      if (name === 'cronState') {
        return { doc: () => ({ get: async () => ({ data: () => stateDoc }), set: setSpy }) }
      }
      if (name === 'workspaces') {
        return {
          select: () => ({
            limit: () => ({ get: async () => ({ docs: workspaceIds.map(id => ({ id })) }) }),
          }),
        }
      }
      throw new Error(`未預期的集合 ${name}`)
    },
  } as never
}

const notify = (patch: Record<string, unknown> = {}) => ({
  handoffNotify: {
    enabled: true,
    lineUserIds: ['U-staff'],
    criticalAlertPush: true,
    ...patch,
  },
})

const alert = (id: string, state = 'active', detail?: string): WorkspaceAlertItem =>
  ({ id, state, detail } as WorkspaceAlertItem)

const pushedText = () => String(((pushMessage.mock.calls[0] as unknown[] | undefined)?.[1] as any)?.[0]?.text ?? '')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(DAYTIME)
  stateDoc = {}
  getAiSettings.mockResolvedValue(notify())
  pushMessage.mockResolvedValue(undefined)
})

describe('嚴重異常推播', () => {
  it('紅燈亮著就推一則，講標題與補充', async () => {
    collectWorkspaceAlerts.mockResolvedValue([
      alert('lineWebhookBroken', 'active', 'LINE 後台還沒設定 Webhook 網址'),
      alert('knowledgeOutdated'), // warning，不該進來
    ])
    const r = await pushCriticalAlerts(fakeDb(['ws1']))
    expect(r).toMatchObject({ workspacesNotified: 1 })
    expect(pushMessage).toHaveBeenCalledTimes(1)
    expect(pushedText()).toContain('機器人收不到客人訊息')
    expect(pushedText()).toContain('LINE 後台還沒設定 Webhook 網址')
  })

  it('🔴 只推 critical：建議處理那一級不進 LINE', async () => {
    collectWorkspaceAlerts.mockResolvedValue([
      alert('knowledgeOutdated'),
      alert('humanBacklog'),
      alert('knowledgeSuggestions'),
    ])
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('🔴 「這次查不到」不可以拿來推播', async () => {
    collectWorkspaceAlerts.mockResolvedValue([alert('lineWebhookBroken', 'unknown')])
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('系統側的狀況要當場說明不用他動手', async () => {
    collectWorkspaceAlerts.mockResolvedValue([alert('llmError', 'active', '近 24 小時 3 次')])
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(pushedText()).toContain('不用你操作')
  })

  it('同一件事一天只講一次；隔天才會再講', async () => {
    collectWorkspaceAlerts.mockResolvedValue([alert('lineWebhookBroken')])
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(pushMessage).toHaveBeenCalledTimes(1)

    // 一小時後又檢查（節流剛好到期）：同一件事還在，但不該再推
    vi.setSystemTime(DAYTIME + 3600_000 + 1000)
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(pushMessage).toHaveBeenCalledTimes(1)

    // 隔天同一時刻：該再講一次
    vi.setSystemTime(DAYTIME + 25 * 3600_000)
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(pushMessage).toHaveBeenCalledTimes(2)
  })

  it('🔴 修好之後再壞，要能立刻再講（不是被冷卻壓住 24 小時）', async () => {
    collectWorkspaceAlerts.mockResolvedValue([alert('lineWebhookBroken')])
    await pushCriticalAlerts(fakeDb(['ws1']))

    // 一小時後：修好了（沒有任何 critical）→ 紀錄要被清掉
    vi.setSystemTime(DAYTIME + 3600_000 + 1000)
    collectWorkspaceAlerts.mockResolvedValue([])
    await pushCriticalAlerts(fakeDb(['ws1']))

    // 再一小時：又壞了 → 馬上要再講一次
    vi.setSystemTime(DAYTIME + 2 * 3600_000 + 2000)
    collectWorkspaceAlerts.mockResolvedValue([alert('lineWebhookBroken')])
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(pushMessage).toHaveBeenCalledTimes(2)
  })

  it('🔴 一則都沒送成功就不記「已通知」，下一輪要重試', async () => {
    collectWorkspaceAlerts.mockResolvedValue([alert('lineWebhookBroken')])
    pushMessage.mockRejectedValue(new Error('not a friend'))
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(pushMessage).toHaveBeenCalledTimes(1)

    vi.setSystemTime(DAYTIME + 3600_000 + 1000)
    pushMessage.mockResolvedValue(undefined)
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(pushMessage).toHaveBeenCalledTimes(2)
  })

  it('半夜不吵人，而且整支早退（連工作區都不掃）', async () => {
    vi.setSystemTime(NIGHT)
    collectWorkspaceAlerts.mockResolvedValue([alert('lineWebhookBroken')])
    const r = await pushCriticalAlerts(fakeDb(['ws1']))
    expect(r).toEqual({ skipped: 'off-hours' })
    expect(collectWorkspaceAlerts).not.toHaveBeenCalled()
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('關掉開關／沒有人收通知時，連查都不查（省掉整套彙總查詢）', async () => {
    for (const patch of [{ criticalAlertPush: false }, { lineUserIds: [] }, { enabled: false }]) {
      vi.clearAllMocks()
      stateDoc = {}
      getAiSettings.mockResolvedValue(notify(patch))
      await pushCriticalAlerts(fakeDb(['ws1']))
      expect(collectWorkspaceAlerts).not.toHaveBeenCalled()
      expect(pushMessage).not.toHaveBeenCalled()
    }
  })

  it('一小時內不重複檢查（節流擋在彙總查詢之前）', async () => {
    collectWorkspaceAlerts.mockResolvedValue([])
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(collectWorkspaceAlerts).toHaveBeenCalledTimes(1)
    vi.setSystemTime(DAYTIME + 10 * 60_000)
    await pushCriticalAlerts(fakeDb(['ws1']))
    expect(collectWorkspaceAlerts).toHaveBeenCalledTimes(1)
  })
})
