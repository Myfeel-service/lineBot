/**
 * 開帳走完回到後台（`C-250`②，示意頁 v80）的守門。
 *
 * 這一包最容易壞成的樣子都是「畫面上講了一件不存在的事」：講了他沒建的東西、指一排空頁、
 * 叫他按一顆名字對不上的鈕、講手機會收到通知但他根本不在通知名單裡。
 * ⚠️ 步驟內容是純函式（`utils/onboarding-landing.ts`），開跑的時機在 `TutorialAgent`——兩邊各守一半。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ONBOARDING_FLOWS } from '~/composables/useOnboardingChat'
import {
  BUILT_PLACE,
  KNOWLEDGE_NAV,
  LANDING_FROM_BUILD,
  LANDING_FROM_LINE,
  LINE_FLOW_MINUTES,
  type OnboardingBuiltItem,
  builtTourSteps,
  hasTriedPlayground,
  landingTourSteps,
  liveTourStepCount,
  liveTourSteps,
  markPlaygroundTried,
  readOnboardingBuilt,
  saveOnboardingBuilt,
} from './onboarding-landing'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(`${APP_DIR}${p}`, 'utf8')
const agent = read('components/TutorialAgent.vue')
const layout = read('layouts/default.vue')
const strip = read('components/admin/AdminPageAlertStrip.vue')
const playground = read('pages/admin/[workspaceId]/ai-playground.vue')
const convPanel = read('components/conversations/AdminPanel.vue')
const chat = read('composables/useOnboardingChat.ts')
const setupStatus = read('composables/useSetupStatus.ts')

const ALL: OnboardingBuiltItem[] = [
  { key: 'welcome', label: '加好友歡迎訊息' },
  { key: 'tone', label: 'AI 說話的語氣' },
  { key: 'tags', label: '建議的分眾標籤 2 顆' },
]

describe('打造完的落地 3 步（`D-102`）', () => {
  it('三步：你做的在哪 → LINE 準備好再接 → 按送出問它一句', () => {
    const steps = landingTourSteps(ALL, { hasBand: true, bandAction: '接上 LINE' })
    expect(steps.map(s => s.title)).toEqual(['你剛剛做的，都在這幾頁', 'LINE 準備好再接', '最後，按「送出」問它一句'])
    expect(steps[2]!.target).toBe('[data-tour="pg-input"]')
  })

  it('第 1 步框整個選單、標亮他建了的那幾列（⛔ 沒建的不標）', () => {
    const [first] = landingTourSteps([ALL[0]!, ALL[2]!], { hasBand: true, bandAction: '接上 LINE' })
    expect(first!.target).toBe('[data-tour="nav-main"]')
    expect(first!.mark).toBe(`${BUILT_PLACE.welcome!.nav}, ${BUILT_PLACE.tags!.nav}`)
    expect(first!.mark).not.toContain('nav-ai-settings')
    // ⭐ 頁名已經標亮了，文字只列「哪幾樣」
    expect(first!.description).toContain('歡迎訊息')
    expect(first!.description).toContain('分眾標籤')
    expect(first!.description).not.toContain('AI 口氣')
  })

  it('⛔ 什麼都沒採用的人不指一排空頁（整步拿掉）', () => {
    const steps = landingTourSteps([], { hasBand: true, bandAction: '接上 LINE' })
    expect(steps.map(s => s.title)).toEqual(['LINE 準備好再接', '最後，按「送出」問它一句'])
  })

  it('⛔ 紅帶沒出現就不講第 2 步（不指著空氣）', () => {
    const steps = landingTourSteps(ALL, { hasBand: false, bandAction: '接上 LINE' })
    expect(steps.some(s => s.target.includes('onboarding-band'))).toBe(false)
  })

  it('⭐ 第 2 步叫出的鈕名＝紅帶鈕上**現在**寫的字；⛔ 不講「現在就接」', () => {
    const band = landingTourSteps(ALL, { hasBand: true, bandAction: '用手機測試' })[1]!
    expect(band.description).toContain('「用手機測試」')
    expect(band.description).toContain('不用現在做')
    // 紅帶、英雄卡、落地導覽三處吃同一份鈕名（⛔ 各寫一次＝導覽講「按接上 LINE」而鈕上寫「帶我完成開通」）
    expect(strip).toContain('{{ onboardingBand.action }}')
    expect(agent).toContain('{{ onboardingBand.heroCta }}')
    expect(agent).toContain('bandAction: onboardingBand.value.action')
    expect(strip + agent).not.toContain('帶我完成開通')
    expect(strip + agent).not.toContain('用聊天引導完成開通')
  })

  it('⭐ 網站整理出卡了：知識庫那一列也標亮、講得出幾張（`C-250`③）；什麼都沒採用但有卡，第 1 步照樣出現', () => {
    const [first] = landingTourSteps([ALL[0]!], { hasBand: true, bandAction: '接上 LINE', draftCards: 12 })
    expect(first!.mark).toContain(KNOWLEDGE_NAV)
    expect(first!.description).toContain('等你看過的 <strong>12 張知識卡</strong>')
    const onlyCards = landingTourSteps([], { hasBand: true, bandAction: '接上 LINE', draftCards: 3 })
    expect(onlyCards[0]!.title).toBe('你剛剛做的，都在這幾頁')
    // ⛔ 沒有卡就不提、也不標知識庫
    expect(landingTourSteps([ALL[0]!], { hasBand: true, bandAction: '接上 LINE', draftCards: 0 })[0]!.mark).not.toContain(KNOWLEDGE_NAV)
    expect(layout).toContain("tour: 'nav-knowledge'")
  })

  it('要多久跟精靈頁首同一個數字', () => {
    expect(ONBOARDING_FLOWS.line.time).toContain(LINE_FLOW_MINUTES)
  })
})

describe('接完 LINE 的「上線之後」（`D-101`）', () => {
  it('收到過訊息＝3 步；沒測試＝2 步，⛔ 鈕上寫的步數跟導覽計數同一個數字', () => {
    expect(liveTourSteps({ received: true, triedPlayground: true })).toHaveLength(liveTourStepCount(true))
    expect(liveTourSteps({ received: false, triedPlayground: true })).toHaveLength(liveTourStepCount(false))
    expect(chat).toContain('liveTourStepCount(true)')
    expect(chat).toContain('liveTourStepCount(false)')
  })

  it('第 1 步先幫他點開那一場，而且那一場要真的在（⛔ 沒測試的人不憑空指一個人）', () => {
    const [first] = liveTourSteps({ received: true, triedPlayground: true })
    // ⚠️ 指清單那一列、卡片放右邊：指右半邊＋放左邊，1280px 下說明卡被切到畫面外（實走量到的）
    expect(first!.target).toBe('.conv-list-row .split-list-item')
    expect(first!.placement).toBe('right-start')
    expect(first!.clickBefore).toBe('.conv-list-row .split-list-item')
    expect(first!.requiresPresent).toBe('.conv-list-row .split-list-item')
    expect(liveTourSteps({ received: false, triedPlayground: true })[0]!.target).toBe('[data-tour="conv-tabs"]')
  })

  it('最後一步照他真的還沒做的事講（⛔ 試過測試對話的人不再叫他去問一題）', () => {
    const tried = liveTourSteps({ received: true, triedPlayground: true }).at(-1)!
    const notTried = liveTourSteps({ received: true, triedPlayground: false }).at(-1)!
    expect(tried.target).toBe('[data-tour="ta-fab"]')
    expect(tried.description).not.toContain('測試對話')
    expect(notTried.description).toContain('測試對話')
  })

  it('還有卡沒看過：最後一步把它列成待辦（跟測試對話那件一起算件數）', () => {
    const both = liveTourSteps({ received: true, triedPlayground: false, draftCards: 8 }).at(-1)!
    expect(both.description).toContain('還差 2 件')
    expect(both.description).toContain('看過那 8 張知識卡')
    const none = liveTourSteps({ received: true, triedPlayground: true, draftCards: 0 }).at(-1)!
    expect(none.description).not.toContain('還差')
  })

  it('⛔ 沒加進通知名單就不承諾手機會收到通知／早上的摘要', () => {
    const text = [true, false].flatMap(r => liveTourSteps({ received: r, triedPlayground: true })).map(s => s.description).join('\n')
    expect(text).not.toContain('手機也會')
    expect(text).not.toContain('早上的摘要')
  })

  it('⭐ 按了「是我」、真的加進通知名單了（`C-250`③）：才講手機會收到通知與早上的摘要', () => {
    const steps = liveTourSteps({ received: true, triedPlayground: true, phoneNotified: true })
    expect(steps[1]!.description).toContain('你的手機也會同時收到通知')
    expect(steps.at(-1)!.description).toContain('每天早上的摘要也會傳到你的手機')
  })

  it('精靈結尾不再開 7 步地圖，改帶 ?from= 落在客服對話', () => {
    expect(chat).toContain('?from=${LANDING_FROM_LINE}')
    // ⚠️ 只查按鈕本身（註解裡交代「原本是那顆」不算）
    expect(chat).not.toContain("label: '帶你認識後台")
  })

  it('🔴 落地那一頁**一讀到 ?from= 就**記成看過（⛔ 等開跑才記＝那一頁自己的 7 步搶先跑掉，實走抓到的）', () => {
    expect(convPanel).toContain(':topics="[\'conversations\']"')
    expect(playground).toContain(":help-topics=\"['ai-playground']\"")
    expect(agent).toContain("markTourSeen(landingFrom === LANDING_FROM_LINE ? 'conversations' : 'ai-playground')")
    const i = agent.indexOf('const landingFrom =')
    const firstAwait = agent.indexOf('await ', i)
    expect(agent.indexOf('markTourSeen(landingFrom', i)).toBeLessThan(firstAwait)
  })
})

describe('看看你剛剛做的東西（`D-95`）', () => {
  it('只走他真的建了的那幾樣', () => {
    expect(builtTourSteps([ALL[1]!]).map(s => s.target)).toEqual([BUILT_PLACE.tone!.nav])
    expect(builtTourSteps([])).toEqual([])
  })

  it('⛔ 標籤那一步不講「聊過了就會貼上」（AI 只會建議、要人採用，而且要先開開關）', () => {
    const tags = builtTourSteps([ALL[2]!])[0]!
    expect(tags.description).not.toContain('聊過')
    expect(tags.description).toContain('代號不行')
  })
})

describe('錨點都真的在畫面上（⛔ 指一個不存在的 data-tour＝那一步永遠「位置不在畫面上」）', () => {
  it.each([
    ['nav-main', layout],
    ['nav-auto-response', layout],
    ['nav-ai-settings', layout],
    ['nav-tags', layout],
    ['onboarding-band', strip],
    ['pg-input', playground],
    ['conv-messages', convPanel],
    ['conv-tabs', convPanel],
    ['ta-fab', agent],
  ])('%s', (anchor, src) => {
    expect(src).toMatch(new RegExp(`data-tour="${anchor}"|tour: '${anchor}'`))
  })
})

describe('紀錄（存在這台瀏覽器）', () => {
  afterEach(() => vi.unstubAllGlobals())

  function fakeStorage() {
    const m = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    })
    return m
  }

  it('存進去、讀得回來；⛔ 知識庫初稿與月曆這種不會再建的不記', () => {
    fakeStorage()
    saveOnboardingBuilt('w1', [...ALL, { key: 'knowledge', label: '知識庫初稿' }])
    expect(readOnboardingBuilt('w1').map(i => i.key)).toEqual(['welcome', 'tone', 'tags'])
    expect(readOnboardingBuilt('w2')).toEqual([])
  })

  it('壞掉的內容、讀不到的儲存空間都當沒有（⛔ 指路不可以把頁面弄壞）', () => {
    const m = fakeStorage()
    m.set('minime:onb-built:w1', '{not json')
    expect(readOnboardingBuilt('w1')).toEqual([])
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(readOnboardingBuilt('w1')).toEqual([])
    expect(() => saveOnboardingBuilt('w1', ALL)).not.toThrow()
    expect(hasTriedPlayground('w1')).toBe(false)
  })

  it('測試對話送出過一題就記一筆', () => {
    fakeStorage()
    expect(hasTriedPlayground('w1')).toBe(false)
    markPlaygroundTried('w1')
    expect(hasTriedPlayground('w1')).toBe(true)
    expect(playground).toContain('markPlaygroundTried(workspaceId.value)')
  })

  it('精靈結尾先記下建了什麼，才送他進後台', () => {
    const i = chat.indexOf('async function stepBuildFinish')
    const block = chat.slice(i, chat.indexOf('// ── 入口', i))
    expect(block.indexOf('saveOnboardingBuilt(')).toBeGreaterThan(-1)
    expect(block.indexOf('saveOnboardingBuilt(')).toBeLessThan(block.indexOf('navigateTo('))
    expect(block).toContain("s.status === 'done'")
    expect(block).toContain('?from=${LANDING_FROM_BUILD}')
  })
})

describe('開跑的時機（`TutorialAgent`）', () => {
  it('兩個 ?from= 值各自只在自己那一頁開跑，讀到就從網址拿掉（重新整理不重跑）', () => {
    expect(agent).toContain("landingFrom === LANDING_FROM_BUILD && route.path.endsWith('/ai-playground')")
    expect(agent).toContain("landingFrom === LANDING_FROM_LINE && route.path.endsWith('/conversations')")
    expect(agent).toContain('const { from: _from, notify: _notify, ...restQuery } = route.query')
    expect(LANDING_FROM_BUILD).not.toBe(LANDING_FROM_LINE)
  })

  it('⛔ 等設定狀態載完才開跑（紅帶是看狀態才長出來的）', () => {
    const i = agent.indexOf('await refreshAll()\n  loadBuiltItems()')
    expect(i).toBeGreaterThan(-1)
    expect(agent.indexOf('await startLandingTour(landingFrom)')).toBeGreaterThan(i)
  })

  it('⭐ 落地導覽走完把游標放進輸入框，⛔ 不打開小幫手面板（`D-102`：面板蓋住剛出來的回答）', () => {
    const i = agent.indexOf('async function startLandingTour')
    const block = agent.slice(i, agent.indexOf('const { markSeen: markTourSeen }', i))
    // ⚠️ el-input 把 data-tour 掛在 textarea 本身——寫成「[data-tour] textarea」會找不到（實走抓到的）
    expect(block).toContain(`document.querySelector<HTMLElement>('[data-tour="pg-input"]')?.focus()`)
    // ⚠️ 晚一拍：el-tour 關掉時會把焦點還回去（當下 focus 會被蓋掉）
    expect(block).toMatch(/setTimeout\(\(\) => document\.querySelector<HTMLElement>\('\[data-tour="pg-input"\]'\)\?\.focus\(\), \d+\)/)
    expect(block).not.toContain('[data-tour="pg-input"] textarea')
    expect(block).toContain('finishOverride = {')
    // ⚠️ 「收到第一則訊息」不在能力註冊表裡，從 capabilities 找永遠找不到
    expect(block).toContain("onboardingSteps.value.find(s => s.id === 'firstMessageReceived')")
  })

  it('🔴 el-tour 按「完成」是先發 close 再發 finish——⛔ 不可以在 onTourClose 作廢走完要做的事', () => {
    // 踩到會怎樣：close 那一下把設定清掉，finish 永遠拿不到＝落地導覽走完照樣打開面板
    const i = agent.indexOf('function onTourClose')
    const block = agent.slice(i, agent.indexOf('\n}\n', i))
    expect(block).not.toContain('finishOverride')
    const f = agent.indexOf('async function onTourFinish')
    expect(agent.slice(f, f + 400)).not.toContain('toRaw(activeSteps.value) === finishOverride')
  })

  it('落地的人不再彈「第一次來？我帶你一步步把設定做完」（跟導覽講相反的事）', () => {
    const i = agent.indexOf('if (wantLanding) {\n    // ⛔')
    expect(agent.slice(i, i + 400)).toContain('dismissNudge()')
  })

  it('測試對話頁在 setup 就讀 ?from=（⛔ 小幫手掛載時會把它拿掉，寫成 computed 就跟著消失）', () => {
    expect(playground).toContain('const fromOnboarding = route.query.from === LANDING_FROM_BUILD')
    expect(playground).not.toMatch(/computed\(\(\) => route\.query\.from/)
  })

  it('標亮換步、關掉時一律收掉', () => {
    const i = agent.indexOf('async function focusActiveStep')
    expect(agent.slice(i, i + 200)).toContain('clearTourMarks()')
  })
})

describe('開通步驟的說法（`C-250`②）', () => {
  it('第三步叫「用手機測試」（⛔ 不再叫「傳話測試」：跟接 LINE 那一趟的進度格同一個說法）', () => {
    expect(setupStatus).toContain("label: '用手機測試'")
    expect(setupStatus).not.toContain('收到第一則訊息（傳話測試）')
  })
})
