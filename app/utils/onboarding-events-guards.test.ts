/**
 * 開通步驟紀錄的守門（`C-250`③，`D-100` C-1「升格為上線前提」）。
 *
 * 型別只擋得住「事件名稱打錯字」，擋不住這三件事：
 *   ① **事件表上有、卻沒有任何地方記**——看紀錄的人會以為「沒人走到那一步」，其實是沒記（最危險的那種零）
 *   ② **把他打的字、貼的連線資訊直接塞進紀錄**——這張表是看行為的，⛔ 不收內容
 *   ③ 進接 LINE 的三個入口沒帶 `entry`——「從哪個入口進來」那個數字就全變成 direct
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ONBOARDING_EVENTS } from '~~/shared/onboarding-events'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(`${APP_DIR}${p}`, 'utf8')
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')

const SOURCES = {
  chat: read('composables/useOnboardingChat.ts'),
  tutorial: read('components/TutorialAgent.vue'),
  playground: read('pages/admin/[workspaceId]/ai-playground.vue'),
  drafts: read('components/knowledge/KnowledgeSiteDrafts.vue'),
}

/** 每一處 `track('名字', { … })`／`trackOnboarding(…)`：名字＋那一包附帶資料的原文 */
function trackCalls(src: string): Array<{ name: string, props: string }> {
  const out: Array<{ name: string, props: string }> = []
  const re = /\b(?:track|trackOnboarding)\('([a-z_]+)'(?:,\s*(\{[\s\S]*?\}))?\)/g
  for (const m of codeOnly(src).matchAll(re)) out.push({ name: m[1]!, props: m[2] ?? '' })
  return out
}
const allCalls = Object.values(SOURCES).flatMap(trackCalls)

describe('開通步驟紀錄：記的地方', () => {
  it('① 事件表上的每一個名字都真的有地方記（⛔ 表上有、沒人記＝看紀錄時的假零）', () => {
    const used = new Set(allCalls.map(c => c.name))
    const unused = Object.keys(ONBOARDING_EVENTS).filter(n => !used.has(n))
    expect(unused).toEqual([])
  })

  it('記的名字都在表上（伺服器照表收，表外的會被丟掉）', () => {
    const unknown = allCalls.map(c => c.name).filter(n => !(n in ONBOARDING_EVENTS))
    expect(unknown).toEqual([])
  })

  it('② 附帶資料不直接放他打的字、貼的連線資訊、題目原文', () => {
    // 這幾個變數裝的都是「內容」：答案、網址、連線資訊、題目、帳號名稱、錯誤訊息
    const RAW = /:\s*(?:typed|trimmed|siteUrl|finalBody|shownBody|name|v|msg|query\.value|answers\b[^,}]*)\s*[,}\n]/
    const leaks = allCalls.filter(c => RAW.test(c.props)).map(c => `${c.name}: ${c.props}`)
    expect(leaks).toEqual([])
  })

  it('紀錄點散在兩趟與落地：打造、接 LINE、離開、落地導覽、測試對話、知識庫審卡都有', () => {
    const byFile = Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, new Set(trackCalls(s).map(c => c.name))]))
    expect([...byFile.chat!]).toEqual(expect.arrayContaining(['build_start', 'build_finish', 'line_start', 'phone_wait', 'line_done', 'wizard_leave']))
    expect([...byFile.tutorial!]).toContain('landing_tour')
    expect([...byFile.playground!]).toContain('playground_sent')
    expect([...byFile.drafts!]).toContain('kb_draft_decision')
  })

  it('離開精靈（頁首「之後再說」、整頁卸載）當下就送出，不等 1.5 秒那一批', () => {
    const chat = codeOnly(SOURCES.chat)
    const leaving = chat.slice(chat.indexOf('function markLeaving'), chat.indexOf('function dispose'))
    expect(leaving).toMatch(/track\('wizard_leave'[\s\S]*flushEvents\(\)/)
    const dispose = chat.slice(chat.indexOf('function dispose'), chat.indexOf('return {', chat.indexOf('function dispose')))
    expect(dispose).toContain('flushEvents()')
  })

  it('測試對話只記開帳那一趟的人（⛔ 其他人天天在那裡測題目，全記下來是雜訊）', () => {
    const pg = codeOnly(SOURCES.playground)
    const at = pg.indexOf("trackOnboarding('playground_sent'")
    const guard = pg.slice(Math.max(0, at - 200), at)
    expect(guard).toMatch(/fromOnboarding \|\| onboardingIncomplete\.value/)
  })
})

describe('開通步驟紀錄：③ 進接 LINE 的入口都帶 entry', () => {
  it('紅帶、小幫手英雄卡、被拉回——三個入口各帶自己的 entry', () => {
    expect(codeOnly(read('components/admin/AdminPageAlertStrip.vue'))).toMatch(/\/admin\/onboarding\?workspaceId=\$\{[^}]+\}&entry=band/)
    expect(codeOnly(SOURCES.tutorial)).toMatch(/\/admin\/onboarding\?workspaceId=\$\{wid\}&entry=hero/)
    expect(codeOnly(read('layouts/default.vue'))).toMatch(/\/admin\/onboarding\?workspaceId=\$\{wid\}&entry=pullback/)
  })

  it('精靈頁把 entry 交給 start()，start() 過一次白名單才記', () => {
    expect(codeOnly(read('pages/admin/onboarding.vue'))).toMatch(/start\(continueWid\.value, focusParam\.value, String\(route\.query\.entry/)
    expect(codeOnly(SOURCES.chat)).toMatch(/entry: lineFlowEntry\(entry\)/)
  })
})
