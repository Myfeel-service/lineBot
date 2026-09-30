/**
 * 小幫手「前往某頁」的連結，跟那一頁的進頁守門要講同一句話（2026-09-30 code review）。
 *
 * 為什麼要有：`D-109` 補了「測試對話」「成員管理」「操作紀錄」三個目的地，但這張表當時沒有角色欄位——
 * 觀察者問「怎麼邀請同事」，小幫手給「前往『成員管理』」，點下去被「這一頁只有管理員能進入」踢回對話頁。
 *
 * 比法跟 `app/middleware/auth.ts` 的背景重驗同一招：**讀那一頁自己在 `definePageMeta` 宣告的 middleware**，
 * 再拿那幾道門的判定函式逐角色判一次（⛔ 不照網址猜：`settings/line-notify` 在 /settings/ 底下，掛的卻是
 * `workspace-notify`，客服就進得去）。目的地多一個、或某頁換了門檻，這裡對不上就紅。
 *
 * 放在 app/ 不放 shared/：它要 import 前端的守門檔，放 shared/ 會把前端的自動匯入拖進伺服器端的型別檢查。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import { AGENT_DESTINATIONS, agentDestinationCatalogueForPrompt, resolveAgentDestinations } from '~~/shared/agent-destinations'

// 三支守門檔的 default export 是 defineNuxtRouteMiddleware(...)：node 環境沒有這個全域，給一個原樣回傳的
vi.stubGlobal('defineNuxtRouteMiddleware', (fn: unknown) => fn)
const { aiFeatureDenial } = await import('~/middleware/ai-feature')
const { settingsPageDenial } = await import('~/middleware/workspace-settings')
const { notifyPageDenial } = await import('~/middleware/workspace-notify')

const PAGES_DIR = fileURLToPath(new URL('../pages/admin/[workspaceId]', import.meta.url))
const ROLES: WorkspaceMemberRole[] = ['owner', 'admin', 'agent', 'viewer']
const WID = 'w1'

/** 網址 → 那一頁的 .vue（`x.vue` 或 `x/index.vue`） */
function pageFile(path: string): string {
  const rest = path.replace(`/admin/${WID}/`, '')
  const candidates = [join(PAGES_DIR, `${rest}.vue`), join(PAGES_DIR, rest, 'index.vue')]
  const hit = candidates.find(f => existsSync(f))
  if (!hit) throw new Error(`找不到 ${path} 對應的頁面檔（試過 ${candidates.join('、')}）`)
  return hit
}

/** 那一頁 definePageMeta 宣告的具名 middleware */
function declaredMiddleware(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const meta = src.match(/definePageMeta\(\{[^}]*middleware:\s*(\[[^\]]*\]|'[^']*')/)
  if (!meta) return []
  return [...meta[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!)
}

/** 照那一頁掛的門逐道判（同 auth.ts 的 routeRoleDenial） */
function pageDenial(path: string, role: WorkspaceMemberRole): string | null {
  const names = declaredMiddleware(pageFile(path))
  if (names.includes('workspace-settings')) {
    const d = settingsPageDenial(path, role)
    if (d) return d
  }
  if (names.includes('ai-feature')) {
    const d = aiFeatureDenial(path, role)
    if (d) return d
  }
  if (names.includes('workspace-notify')) {
    const d = notifyPageDenial(role)
    if (d) return d
  }
  return null
}

describe('小幫手的「前往」連結 ＝ 那一頁進得去', () => {
  for (const [id, d] of Object.entries(AGENT_DESTINATIONS)) {
    it(`${id}（${d.label}）：每個角色都跟進頁守門講同一句話`, () => {
      const path = d.path(WID)
      for (const role of ROLES) {
        const gets = resolveAgentDestinations([id], WID, role).length === 1
        const canEnter = pageDenial(path, role) === null
        expect({ role, gets }).toEqual({ role, gets: canEnter })
      }
    })
  }

  it('那三個 code review 抓到的：觀察者拿不到成員管理／操作紀錄／測試對話', () => {
    expect(resolveAgentDestinations(['settings-members', 'settings-activity'], WID, 'viewer')).toEqual([])
    expect(resolveAgentDestinations(['ai-playground'], WID, 'viewer')).toEqual([])
    expect(resolveAgentDestinations(['ai-playground'], WID, 'agent')).toHaveLength(1)
    expect(resolveAgentDestinations(['settings-members'], WID, 'admin')).toHaveLength(1)
  })

  it('被濾掉的不佔名額：前面那個進不去，後面兩個照樣給', () => {
    const out = resolveAgentDestinations(['settings-members', 'conversations', 'tags'], WID, 'viewer')
    expect(out.map(m => (m as { label: string }).label)).toEqual(['前往「客服對話」', '前往「標籤管理」'])
  })

  it('給模型挑的清單也照角色篩（⛔ 列了進不去的，它就會指過去）', () => {
    const viewerList = agentDestinationCatalogueForPrompt('viewer')
    expect(viewerList).not.toContain('settings-members')
    expect(viewerList).toContain('conversations')
    expect(agentDestinationCatalogueForPrompt('owner')).toContain('settings-members')
    expect(agentDestinationCatalogueForPrompt(null)).toBe('')
  })
})
