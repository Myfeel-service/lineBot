/**
 * 小幫手出場時機的對照表（`D-112`）。
 *
 * 釘住的是會讓人「按了才發現不對」的那幾件：
 * 1. 每一頁的「做」建議都是 15 件代辦之一，而且**做完的結果就在這一頁**——
 *    在推播頁建議「把服務時間改成…」，按下去改的是另一頁的東西，人會在這頁找不到。
 * 2. 權限照代辦本身的門檻篩：觀察者一個「做」都看不到。
 * 3. 網址 → 頁、頁 → 「前往查看」的網址，兩個方向都對得上。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_OP_CAPABILITY,
  ADMIN_OP_TARGET,
  AGENT_FALLBACK_PROMPTS,
  AGENT_FESTIVAL_ASK,
  AGENT_SETUP_ASKS,
  AGENT_OP_PAGE_LABEL,
  AGENT_PAGE_PROMPTS,
  AGENT_OP_EXAMPLES,
  AGENT_NUMBERLESS_SAY,
  agentOpCatalogue,
  agentOpViewPath,
  agentPromptPageFromPath,
  agentPromptsFor,
  normalizeAgentAskSource,
  normalizeAgentPromptPage,
  type AgentOpPage,
} from './agent-entry'
import { can as roleCan, type Capability } from './permissions'
import { ADMIN_OP_LABELS, type AdminOpId } from './types/admin-ops'

const asRole = (role: 'viewer' | 'agent' | 'admin' | 'owner') => (cap: Capability) => roleCan(role, cap)
const PAGES = Object.keys(AGENT_PAGE_PROMPTS) as AgentOpPage[]

describe('每一頁的建議', () => {
  it('「做」都是 15 件代辦之一、每頁最多 3 個、至少 1 個「查」', () => {
    for (const page of PAGES) {
      const p = AGENT_PAGE_PROMPTS[page]
      expect(p.dos.length, `${page} 的「做」超過 3 個`).toBeLessThanOrEqual(3)
      expect(p.dos.length, `${page} 沒有任何「做」`).toBeGreaterThan(0)
      expect(p.asks.length, `${page} 沒有「查」`).toBeGreaterThan(0)
      for (const d of p.dos) expect(ADMIN_OP_LABELS[d.op], `${page}：${d.op} 不是代辦`).toBeTruthy()
    }
  })

  it('「做」的結果就在這一頁（⛔ 不在 A 頁建議改 B 頁的東西）', () => {
    for (const page of PAGES) {
      for (const d of AGENT_PAGE_PROMPTS[page].dos)
        expect(ADMIN_OP_TARGET[d.op].page, `${page} 的「${d.say}」改的是別頁的東西`).toBe(page)
    }
  })

  it('輸入框範例字不跟任何一個建議重複，而且一眼看得完（輸入框約 18 個字寬）', () => {
    for (const p of [...PAGES.map(k => AGENT_PAGE_PROMPTS[k]), AGENT_FALLBACK_PROMPTS]) {
      const said = [...p.dos.map(d => d.say), ...p.asks]
      expect(said.some(s => p.placeholder.includes(s) || s.includes(p.placeholder.replace(/^例：/, ''))), `${p.label}：範例字跟建議重複`).toBe(false)
      expect([...p.placeholder].length, `${p.label}：範例字「${p.placeholder}」太長會被切掉`).toBeLessThanOrEqual(18)
    }
  })

  it('標題用的頁名跟側欄同一個字', () => {
    for (const page of PAGES) expect(AGENT_PAGE_PROMPTS[page].label).toBe(AGENT_OP_PAGE_LABEL[page])
  })

  it('沒有專屬建議的頁：標題不講頁名，但照樣有「做」也有「查」', () => {
    expect(AGENT_FALLBACK_PROMPTS.label).toBeNull()
    expect(AGENT_FALLBACK_PROMPTS.dos.length).toBeGreaterThan(0)
    expect(AGENT_FALLBACK_PROMPTS.asks.length).toBeGreaterThan(0)
  })
})

describe('權限', () => {
  it('觀察者一個「做」都看不到，「查」照樣有', () => {
    for (const page of [...PAGES, null]) {
      const p = agentPromptsFor(page, asRole('viewer'))
      expect(p.dos, `${page} 觀察者看得到「做」`).toEqual([])
      expect(p.asks.length).toBeGreaterThan(0)
    }
    expect(agentOpCatalogue(asRole('viewer'))).toEqual([])
  })

  it('客服（agent）看得到自動回應、標籤、知識庫的「做」，看不到 AI 設定的', () => {
    const can = asRole('agent')
    expect(agentPromptsFor('ai-scripts', can).dos.length).toBeGreaterThan(0)
    expect(agentPromptsFor('tags', can).dos.length).toBeGreaterThan(0)
    expect(agentPromptsFor('ai-settings', can).dos).toEqual([])
  })

  it('「我會做的 N 件」管理員看得到全部 15 件，每件只出現一次', () => {
    const all = agentOpCatalogue(asRole('owner')).flatMap(g => g.items)
    expect(all.length).toBe(Object.keys(ADMIN_OP_LABELS).length)
    expect(new Set(all.map(i => i.op)).size).toBe(all.length)
  })

  // `D-115`（2026-10-05）：清單從「功能名詞攤開」改成「先選一類、再點一句」
  it('每件代辦剛好一句範例（新增代辦忘了寫範例＝清單上少一件、紅）', () => {
    expect(Object.keys(AGENT_OP_EXAMPLES).sort()).toEqual(Object.keys(ADMIN_OP_LABELS).sort())
  })

  it('範例句：⛔ 不重複（兩件講同一句＝點了分不出要哪一件）、30 字以內（好掃，別家準則：短句勝過一整面說明）', () => {
    const says = Object.values(AGENT_OP_EXAMPLES)
    expect(new Set(says).size).toBe(says.length)
    for (const s of says) {
      expect(s.trim().length, s).toBeGreaterThan(0)
      expect(s.length, s).toBeLessThanOrEqual(30)
    }
  })

  it('分類照側欄由上到下、同一類的句子都住在那一頁（點分類看到的就是那一頁的事）', () => {
    const groups = agentOpCatalogue(asRole('owner'))
    expect(groups.map(g => g.label)).toEqual(['自動回應', '標籤管理', '推播', '知識庫', 'AI 設定', 'LINE 通知'])
    for (const g of groups) {
      for (const it of g.items) expect(ADMIN_OP_TARGET[it.op].page, it.say).toBe(g.page)
    }
    // 客服（agent）沒有 AI 設定的權限：那一類整顆不出現（⛔ 不出一顆點進去全是會被拒絕的句子）
    expect(agentOpCatalogue(asRole('agent')).map(g => g.page)).not.toContain('ai-settings')
  })

  it('門檻影本涵蓋每一件代辦', () => {
    expect(Object.keys(ADMIN_OP_CAPABILITY).sort()).toEqual(Object.keys(ADMIN_OP_LABELS).sort())
    expect(Object.keys(ADMIN_OP_TARGET).sort()).toEqual(Object.keys(ADMIN_OP_LABELS).sort())
  })
})

describe('網址', () => {
  it('網址 → 哪一頁', () => {
    expect(agentPromptPageFromPath('/admin/w1/ai-scripts')).toBe('ai-scripts')
    expect(agentPromptPageFromPath('/admin/w1/broadcasts?id=b1')).toBe('broadcasts')
    expect(agentPromptPageFromPath('/admin/w1/tags')).toBe('tags')
    expect(agentPromptPageFromPath('/admin/w1/knowledge/sources')).toBe('knowledge')
    expect(agentPromptPageFromPath('/admin/w1/ai-settings')).toBe('ai-settings')
    expect(agentPromptPageFromPath('/admin/w1/settings/line-notify')).toBe('line-notify')
    expect(agentPromptPageFromPath('/admin/w1/settings/members')).toBeNull()
    expect(agentPromptPageFromPath('/admin/w1/conversations')).toBeNull()
    expect(agentPromptPageFromPath('/login')).toBeNull()
  })

  it('「前往查看」的網址回得到同一頁（兩個方向對得上）', () => {
    for (const page of PAGES)
      expect(agentPromptPageFromPath(agentOpViewPath(page, 'w1', 'x1')), page).toBe(page)
  })

  it('有 id 的兩頁沿用 ?id= 深連結；知識庫帶到「等你看過」', () => {
    expect(agentOpViewPath('ai-scripts', 'w1', 'a b')).toBe('/admin/w1/ai-scripts?id=a%20b')
    expect(agentOpViewPath('broadcasts', 'w1', 'b1')).toBe('/admin/w1/broadcasts?id=b1')
    expect(agentOpViewPath('ai-scripts', 'w1')).toBe('/admin/w1/ai-scripts')
    expect(agentOpViewPath('knowledge', 'w1', 'c1')).toBe('/admin/w1/knowledge/sources?drafts=1')
  })

  it('改設定的代辦一定標得出那一頁上的哪一塊；改清單的不標（靠 targetId）', () => {
    for (const [id, t] of Object.entries(ADMIN_OP_TARGET) as [AdminOpId, { page: AgentOpPage, section?: string }][]) {
      if (t.page === 'ai-settings' || t.page === 'line-notify') expect(t.section, `${id} 沒標是哪一塊`).toBeTruthy()
      else expect(t.section, `${id} 是清單裡的一筆，不該標區塊`).toBeUndefined()
    }
  })
})

describe('卡片上的「交給小幫手」', () => {
  it('對應的都是真的代辦；待辦卡的 id 都是設定體檢真的有的項目', () => {
    // 設定體檢的註冊表住在 app/（相依 Vue 圖示），shared 這邊 import 不動——讀檔比對（同 agent-teachings.test 的做法）
    const src = readFileSync(fileURLToPath(new URL('../app/composables/useSetupStatus.ts', import.meta.url)), 'utf8')
    const block = src.slice(src.indexOf('const CAPABILITIES'), src.indexOf('\n]\n', src.indexOf('const CAPABILITIES')))
    const setupIds = [...block.matchAll(/^ {4}id: '([^']+)',/gm)].map(m => m[1]!)
    expect(setupIds.length, '讀不到設定體檢的項目（檔案結構變了？）').toBeGreaterThan(3)
    for (const [id, a] of Object.entries(AGENT_SETUP_ASKS)) {
      expect(setupIds, `${id} 不是設定體檢的項目`).toContain(id)
      expect(ADMIN_OP_LABELS[a!.op], `${id} 對到的不是代辦`).toBeTruthy()
    }
    expect(ADMIN_OP_LABELS[AGENT_FESTIVAL_ASK.op]).toBeTruthy()
    expect(AGENT_FESTIVAL_ASK.text('中秋節')).toContain('「中秋節」')
  })
})

describe('記錄來源', () => {
  it('不在表上的值一律當成自己打字／沒有頁（⛔ 不原樣存外面送來的字）', () => {
    expect(normalizeAgentAskSource('page-button')).toBe('page-button')
    // `D-113`：左側欄那一格另記一個來源，上線兩週後跟其他入口一起比（`C-284`）
    expect(normalizeAgentAskSource('sidebar')).toBe('sidebar')
    expect(normalizeAgentAskSource('<script>')).toBe('typed')
    expect(normalizeAgentAskSource(undefined)).toBe('typed')
    expect(normalizeAgentPromptPage('tags')).toBe('tags')
    expect(normalizeAgentPromptPage('constructor')).toBeNull()
    expect(normalizeAgentPromptPage(null)).toBeNull()
  })
})

/** `D-116`（2026-10-08 老闆拍板）：沒受過訓練的店家實測撞到的兩件事 */
describe('建議與範例句的字（D-116）', () => {
  /** 畫面上會出現的所有建議字：每頁的做／查／範例字、沒有專屬頁的那一組、「我會做的 N 件」 */
  const allSaid = () => [
    ...Object.values(AGENT_PAGE_PROMPTS).flatMap(p => [p.placeholder, ...p.dos.map(d => d.say), ...p.asks]),
    AGENT_FALLBACK_PROMPTS.placeholder,
    ...AGENT_FALLBACK_PROMPTS.dos.map(d => d.say),
    ...AGENT_FALLBACK_PROMPTS.asks,
    ...Object.values(AGENT_OP_EXAMPLES),
  ]

  it('🔴 改時間／分鐘的那幾件，點了會進輸入框的句子⛔不帶數字（以前「服務時間改成平日 9 點到 6 點」照送就改到真的設定）', () => {
    const numberless = new Set(Object.keys(AGENT_NUMBERLESS_SAY) as AdminOpId[])
    const clickable = [
      ...Object.values(AGENT_PAGE_PROMPTS).flatMap(p => p.dos),
      ...AGENT_FALLBACK_PROMPTS.dos,
      ...(Object.entries(AGENT_OP_EXAMPLES) as [AdminOpId, string][]).map(([op, say]) => ({ op, say })),
    ].filter(d => numberless.has(d.op))
    expect(clickable.length).toBeGreaterThan(0)
    for (const d of clickable)
      expect(d.say, `${d.op}：「${d.say}」帶了數字`).not.toMatch(/[0-9０-９]|[一二兩三四五六七八九十半]\s*(點|分|小時|天)/)
  })

  it('🔴 跟側欄同一套字：叫「自動回應」、開關叫「啟用／停用」，⛔ 不出現「客服流程」「上架」「下架」', () => {
    for (const s of allSaid())
      expect(s, s).not.toMatch(/客服流程|腳本|上架|下架/)
  })
})
