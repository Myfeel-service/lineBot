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
// 「同一瞬間只查一次」的機制（E-28 抽出去的那支）在 app 裡是自動匯入，測試要自己接上；
// 它只用到上面那個 useState 替身，所以照順序放在受測模組之前就好
const { useSharedRequest } = await import('./useSharedRequest')
g.useSharedRequest = useSharedRequest

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

  it('頁面級提醒條與側欄的點吃同一個展開：點亮在哪頁，那頁就列得出同一批事＋完整深連結', async () => {
    const a = await load([
      { id: 'humanBacklog', state: 'active', count: 2 },
      { id: 'knowledgeSyncFailed', state: 'active', count: 1 },
      { id: 'brokenModuleButton', state: 'active', count: 1, scopes: ['campaign'] },
    ])

    // 對話頁列出 backlog，按鈕帶著「切到待真人分頁」的深連結（這就是下一步）
    const conv = a.alertsForPath('/admin/w1/conversations')
    expect(conv.map(r => r.alert.id)).toEqual(['humanBacklog'])
    expect(conv[0]!.to).toBe('/admin/w1/conversations?tab=pending_human')

    // 壞在活動 → 活動頁列得出來；沒事的頁（圖文選單）一列都沒有——沒事就不出現
    expect(a.alertsForPath('/admin/w1/campaigns').map(r => r.alert.id)).toEqual(['brokenModuleButton'])
    expect(a.alertsForPath('/admin/w1/richmenu')).toEqual([])

    // 與 navAlerts 完全同一批頁：兩邊各算各的就會「點亮著、進來卻空白」
    expect(Object.keys(a.navAlerts.value).sort()).toEqual(
      ['/admin/w1/campaigns', '/admin/w1/conversations', '/admin/w1/knowledge/sources'].sort(),
    )
  })

  it('換帳號時清空：把 A 家的紅點留在 B 家的側欄上是最糟的錯', async () => {
    const a = await load([{ id: 'lineWebhookBroken', state: 'active' }])
    expect(a.navAlerts.value['/admin/w1/settings/organization']?.severity).toBe('critical')

    a.reset()
    expect(a.navAlerts.value).toEqual({})
  })
})

describe('修復手段對應的一致性（D-34）：註冊表、op 表、劇本三處不能漂', () => {
  it('掛在註冊表上的 fixOpId 都存在於 op 清單（打錯字＝「幫我修」按下去 400）', async () => {
    const { ALERT_FIX_OP_IDS } = await import('~~/shared/types/alert-fix')
    const a = useWorkspaceAlerts()
    for (const def of a.alerts.value) {
      if (def.fixOpId)
        expect(ALERT_FIX_OP_IDS, `異常 ${def.id} 掛了不存在的 op ${def.fixOpId}`).toContain(def.fixOpId)
    }
  })

  it('每個 op 至少被一顆異常掛著（孤兒 op＝寫了永遠沒人按得到）', async () => {
    const { ALERT_FIX_OP_IDS } = await import('~~/shared/types/alert-fix')
    const used = new Set(useWorkspaceAlerts().alerts.value.map(d => d.fixOpId).filter(Boolean))
    for (const id of ALERT_FIX_OP_IDS)
      expect(used.has(id), `op ${id} 沒有任何異常掛它`).toBe(true)
  })

  it('guideId 與劇本的 alertIds 互相對得上（兩邊各登記一份，靠這條釘住）', async () => {
    const { AGENT_GUIDES } = await import('~/utils/agent-guides')
    const a = useWorkspaceAlerts()
    // 正向：註冊表掛的劇本，劇本自己也認這顆異常
    for (const def of a.alerts.value) {
      if (def.guideId)
        expect(AGENT_GUIDES[def.guideId].alertIds, `劇本 ${def.guideId} 不認異常 ${def.id}`).toContain(def.id)
    }
    // 反向：劇本說自己修哪幾顆，那幾顆的註冊表也要掛回這條劇本
    for (const guide of Object.values(AGENT_GUIDES)) {
      for (const alertId of guide.alertIds) {
        const def = a.alerts.value.find(d => d.id === alertId)
        expect(def?.guideId, `異常 ${alertId} 沒掛回劇本 ${guide.id}`).toBe(guide.id)
      }
    }
  })
})

/**
 * 去重與跨帳號：這一組釘住 2026-08-27 那次效能修正（`E-20`）的兩個要求。
 *
 * 為什麼值得測：①「同一次載入只打一支」本來就沒人測，而防重複的閂是靠宣告位置成立的
 * ——有人把它改回函式內的 `let`（為了好測、或順手重構）就會靜靜地退回每頁打兩次，
 * 而唯一的證據是手動走一次瀏覽器。②共用同一支 promise 的代價是「拿 A 家的查詢回答 B 家」，
 * 那比慢兩秒嚴重得多（reset() 自己的註解就是這樣寫的）。
 */
describe('去重與跨帳號（E-20）', () => {
  /** 讓 $fetch 停在半空中，好模擬「還在路上時使用者切帳號」 */
  function deferredFetch() {
    const pending: Array<{ wid: string, resolve: (items: WorkspaceAlertItem[]) => void }> = []
    fetchSpy.mockImplementation(((_url: string, opts: any) => {
      const wid = String(opts?.query?.workspaceId ?? '')
      return new Promise((resolve) => {
        pending.push({ wid, resolve: its => resolve({ workspaceId: wid, items: its, checkedAt: 1 }) })
      })
    }) as never)
    return pending
  }

  /** refresh() 內部先 await getBearer() 才打 $fetch，所以要放行一輪 microtask 才看得到請求 */
  const flush = () => new Promise(r => setTimeout(r, 0))

  it('兩個呼叫端同時要資料 → 只打一支 API（面板與提醒條共用同一次查詢）', async () => {
    const pending = deferredFetch()
    // 兩個不同的呼叫端各自 useWorkspaceAlerts()，模擬 TutorialAgent 與 AdminPageAlertStrip
    const strip = useWorkspaceAlerts()
    const fab = useWorkspaceAlerts()
    const p1 = strip.refresh()
    const p2 = fab.refresh()
    await flush()

    // 這一行紅掉＝防重複的閂又變成「每個呼叫端各一份」
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    pending[0]!.resolve([{ id: 'llmError', state: 'active', count: 2 }])
    await Promise.all([p1, p2])
    // 一支查詢餵飽兩個呼叫端（狀態是共用的）
    expect(strip.activeAlerts.value.map(x => x.id)).toContain('llmError')
    expect(fab.activeAlerts.value.map(x => x.id)).toContain('llmError')
  })

  it('查詢還在路上就換帳號 → 新帳號要自己被查一次，而且舊帳號的答案不准寫進新畫面', async () => {
    const pending = deferredFetch()
    const a = useWorkspaceAlerts()

    const first = a.refresh() // w1 送出，卡在路上
    await flush()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.wid).toBe('w1')

    // 使用者切到 w2（TutorialAgent 的 watch 會先 reset 再重查）
    workspaceId.value = 'w2'
    a.reset()
    const second = a.refresh({ force: true })
    await flush()

    // ⛔ 這一行紅掉＝w2 被 w1 那支在飛的查詢擋掉，等於從來沒被查過
    expect(pending).toHaveLength(2)
    expect(pending[1]!.wid).toBe('w2')

    // w2 先回來（正常情況），再讓落後的 w1 回來
    pending[1]!.resolve([{ id: 'quotaExceeded', state: 'active', count: 1 }])
    await second
    pending[0]!.resolve([{ id: 'llmError', state: 'active', count: 99 }])
    await first

    // ⛔ 這兩行紅掉＝A 家的異常被寫到 B 家畫面上
    const shown = a.activeAlerts.value.map(x => x.id)
    expect(shown).not.toContain('llmError')
    expect(shown).toContain('quotaExceeded')
  })
})
