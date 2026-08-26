/**
 * 側欄狀態點：點要畫在**真的壞掉的那一頁**上（2026-08-26 `D-33` P0-1／P0-2）。
 *
 * 為什麼值得測：這件事錯了比沒做更糟——使用者照著點進去、那一頁一切正常，
 * 下一次他就不會再相信那顆點。最容易錯的正是「有按鈕按下去沒反應」這顆：
 * 它一顆管四種設定（圖文選單／機器人模組／客服腳本／活動），2026-08-26 之前
 * 一律指到圖文選單，壞在活動的人被帶去一個沒有問題的頁面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import { ALERT_LABELS } from '~~/shared/types/alerts'
import type { WorkspaceAlertItem } from '~~/shared/types/alerts'

// ── Nuxt 自動匯入的替身（要在 import 受測模組之前就位）────────────────
const states = new Map<string, Ref<unknown>>()
const workspaceId = ref('w1')
let items: WorkspaceAlertItem[] = []

const fetchSpy = vi.fn(async () => ({ workspaceId: workspaceId.value, items, checkedAt: 1 }))

const g = globalThis as Record<string, unknown>
g.useState = (key: string, init: () => unknown) => {
  if (!states.has(key))
    states.set(key, ref(init()))
  return states.get(key)!
}
g.computed = computed
g.useWorkspace = () => ({
  workspaceId,
  getBearer: async () => 'token',
  canManageSettings: ref(true),
  canOperate: ref(true),
})
g.$fetch = fetchSpy

const { useWorkspaceAlerts } = await import('./useWorkspaceAlerts')

beforeEach(() => {
  states.clear()
  fetchSpy.mockClear()
  workspaceId.value = 'w1'
  items = []
})

async function load(next: WorkspaceAlertItem[]) {
  items = next
  const a = useWorkspaceAlerts()
  await a.refresh({ force: true })
  return a
}

describe('側欄狀態點：畫在哪一頁', () => {
  it('壞在活動 → 點畫在「活動標籤」，⛔不可以畫在圖文選單', async () => {
    const a = await load([{ id: 'brokenModuleButton', state: 'active', count: 1, scopes: ['campaign'] }])

    expect(a.navAlerts.value['/admin/w1/campaigns']?.severity).toBe('critical')
    // 這一行紅掉＝又回到「一律指到圖文選單」的舊行為
    expect(a.navAlerts.value['/admin/w1/richmenu']).toBeUndefined()
  })

  it('同時壞在兩種設定 → 兩頁都要有點（只點一頁等於漏報另一頁）', async () => {
    const a = await load([{ id: 'brokenModuleButton', state: 'active', count: 3, scopes: ['richmenu', 'script'] }])

    expect(a.navAlerts.value['/admin/w1/richmenu']?.severity).toBe('critical')
    expect(a.navAlerts.value['/admin/w1/ai-scripts']?.severity).toBe('critical')
    expect(a.navAlerts.value['/admin/w1/campaigns']).toBeUndefined()
  })

  it('後端沒回面向（舊版）→ 退回原本的落點，而不是整顆不畫', async () => {
    const a = await load([{ id: 'brokenModuleButton', state: 'active', count: 1 }])
    expect(a.navAlerts.value['/admin/w1/richmenu']?.severity).toBe('critical')
  })

  it('卡片上那顆按鈕也要跟著分流：壞在活動就帶去活動頁', async () => {
    const a = await load([{ id: 'brokenModuleButton', state: 'active', count: 1, scopes: ['campaign'] }])
    const card = a.alerts.value.find(x => x.id === 'brokenModuleButton')!
    expect(card.route('w1')).toBe('/admin/w1/campaigns')
  })
})

describe('側欄狀態點：什麼該畫、什麼不該畫', () => {
  it('深連結要被剝掉，否則永遠對不上側欄的網址', async () => {
    // knowledgeSyncFailed 的 route 帶 ?health=failedSources
    const a = await load([{ id: 'knowledgeSyncFailed', state: 'active', count: 2 }])
    expect(Object.keys(a.navAlerts.value)).toEqual(['/admin/w1/knowledge/sources'])
  })

  it('同一頁有紅有黃 → 畫紅色，兩件事都要講到', async () => {
    const a = await load([
      { id: 'knowledgeOutdated', state: 'active', count: 1 },
      { id: 'knowledgeSyncFailed', state: 'active', count: 2 },
    ])
    const hit = a.navAlerts.value['/admin/w1/knowledge/sources']!
    expect(hit.severity).toBe('critical')
    expect(hit.titles).toHaveLength(2)
    expect(hit.titles).toContain(ALERT_LABELS.knowledgeSyncFailed)
  })

  it('建議類不上側欄（老闆 08-26 拍板：常年都有的東西掛上去會變裝飾）', async () => {
    const a = await load([{ id: 'knowledgeSuggestions', state: 'active', count: 5 }])
    expect(a.navAlerts.value).toEqual({})
    // 但它照樣要出現在小幫手的「可以更好」區
    expect(a.suggestionAlerts.value.map(x => x.id)).toEqual(['knowledgeSuggestions'])
  })

  it('查不到（unknown）不畫點——但也不會被當成沒事，另有清單列出來', async () => {
    const a = await load([{ id: 'lineWebhookBroken', state: 'unknown' }])
    expect(a.navAlerts.value).toEqual({})
    expect(a.unknownAlerts.value.some(x => x.id === 'lineWebhookBroken')).toBe(true)
  })

  it('檢查過沒問題 → 什麼都不畫（⛔沒有綠點這種東西）', async () => {
    const a = await load([{ id: 'lineWebhookBroken', state: 'clear' }])
    expect(a.navAlerts.value).toEqual({})
  })

  it('沒有權限看的異常不畫點（客服不該看到帳單亮紅燈）', async () => {
    g.useWorkspace = () => ({
      workspaceId,
      getBearer: async () => 'token',
      canManageSettings: ref(false), // 客服
      canOperate: ref(true),
    })
    const a = await load([{ id: 'quotaExceeded', state: 'active' }])
    expect(a.navAlerts.value['/admin/w1/settings/billing']).toBeUndefined()

    g.useWorkspace = () => ({
      workspaceId,
      getBearer: async () => 'token',
      canManageSettings: ref(true),
      canOperate: ref(true),
    })
  })

  it('換帳號時清空：把 A 家的紅點留在 B 家的側欄上是最糟的錯', async () => {
    const a = await load([{ id: 'lineWebhookBroken', state: 'active' }])
    expect(a.navAlerts.value['/admin/w1/settings/organization']?.severity).toBe('critical')

    a.reset()
    expect(a.navAlerts.value).toEqual({})
  })
})
