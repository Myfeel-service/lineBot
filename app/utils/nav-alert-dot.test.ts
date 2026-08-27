/**
 * 側欄那顆點的規則測試。
 *
 * 為什麼值得一支測試：這顆點的「哪些情況該亮」已經被改過三次（08-26 建立、08-26 開通期
 * 整排不亮、08-27 開通期只亮一顆），而它的失效方式**在畫面上跟「一切正常」長得一樣**——
 * 不亮的時候沒有人會發現它壞了。三個真正會出事的情境各釘一條：開通期該亮的那一顆、
 * 開通期不該亮的其他列、狀態還沒載完的新帳號。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { navAlertDot } from './nav-alert-dot'
import type { NavAlertDotInput } from './nav-alert-dot'

const ORG_PATH = '/admin/kevin-test/settings/organization'
const STATS_PATH = '/admin/kevin-test/conversation-stats'

/** 開通還沒做完的全新帳號（＝老闆截圖那個「小貓商店」的狀態） */
function onboardingCase(path: string, over: Partial<NavAlertDotInput> = {}): NavAlertDotInput {
  return {
    path,
    setupLoaded: true,
    onboardingIncomplete: true,
    onboardingNavPath: ORG_PATH,
    onboardingTip: 'LINE 官方帳號還沒接上：客人的訊息現在進不來',
    navAlerts: {},
    ...over,
  }
}

/** 已經在營運的帳號：開通做完了，點只回答「哪一頁現在有異常」 */
function runningCase(path: string, navAlerts: NavAlertDotInput['navAlerts']): NavAlertDotInput {
  return {
    path,
    setupLoaded: true,
    onboardingIncomplete: false,
    onboardingNavPath: ORG_PATH,
    onboardingTip: '不該被用到',
    navAlerts,
  }
}

describe('開通還沒做完的帳號', () => {
  it('「組織與 LINE」那一列要亮紅點，滑過去講的是開通那句話', () => {
    const dot = navAlertDot(onboardingCase(ORG_PATH))
    // ⛔這行紅掉＝頂端那條開通帶被捲走之後，左半邊完全沒有訊號（08-27 加這顆的原因）
    expect(dot).toEqual({
      severity: 'critical',
      tip: 'LINE 官方帳號還沒接上：客人的訊息現在進不來',
    })
  })

  it('其餘每一列都不亮——開通期只准一顆（一多就變裝飾）', () => {
    expect(navAlertDot(onboardingCase(STATS_PATH))).toBeUndefined()
    expect(navAlertDot(onboardingCase('/admin/kevin-test/ai-settings'))).toBeUndefined()
    expect(navAlertDot(onboardingCase('/admin/kevin-test/settings/billing'))).toBeUndefined()
  })

  it('開通期就算別頁真的有異常也不亮（那些數字本來就還量不出來）', () => {
    const dot = navAlertDot(onboardingCase(STATS_PATH, {
      navAlerts: { [STATS_PATH]: { severity: 'critical', titles: ['AI 已停止回覆'] } },
    }))
    expect(dot).toBeUndefined()
  })

  it('體檢狀態還沒載完 → 什麼都不畫（不然新帳號會先閃一排點再消失）', () => {
    expect(navAlertDot(onboardingCase(ORG_PATH, { setupLoaded: false }))).toBeUndefined()
  })

  it('還不知道要指哪一列（沒有工作區）→ 不亮，不亂猜一列', () => {
    expect(navAlertDot(onboardingCase(ORG_PATH, { onboardingNavPath: '' }))).toBeUndefined()
  })
})

describe('已經開通完的帳號', () => {
  it('紅＝客人正在受影響、琥珀＝該處理但還沒影響到客人', () => {
    expect(navAlertDot(runningCase(STATS_PATH, {
      [STATS_PATH]: { severity: 'critical', titles: ['AI 已停止回覆'] },
    }))).toEqual({ severity: 'critical', tip: '客人正在受影響：AI 已停止回覆' })

    expect(navAlertDot(runningCase(STATS_PATH, {
      [STATS_PATH]: { severity: 'warning', titles: ['額度快用完'] },
    }))).toEqual({ severity: 'warning', tip: '有事情要處理：額度快用完' })
  })

  it('同一頁多件事 → 一顆點、一句話列完（⛔不顯示數字）', () => {
    const dot = navAlertDot(runningCase(STATS_PATH, {
      [STATS_PATH]: { severity: 'critical', titles: ['AI 已停止回覆', '額度快用完'] },
    }))
    expect(dot?.tip).toBe('客人正在受影響：AI 已停止回覆、額度快用完')
  })

  it('沒事的頁面什麼都不畫（⛔不畫綠燈——系統沒在檢查的頁面畫綠燈就是說謊）', () => {
    expect(navAlertDot(runningCase(STATS_PATH, {}))).toBeUndefined()
    expect(navAlertDot(runningCase(STATS_PATH, {
      [STATS_PATH]: { severity: 'critical', titles: [] },
    }))).toBeUndefined()
  })

  it('建議類（「AI 可以幫你更好」）不上側欄——常年都有，掛上去就變裝飾', () => {
    expect(navAlertDot(runningCase(STATS_PATH, {
      [STATS_PATH]: { severity: 'suggestion', titles: ['可以補幾張知識卡'] },
    }))).toBeUndefined()
  })
})

describe('側欄那一列的路徑要跟判定用的路徑對得上', () => {
  /**
   * 這條守的是**最安靜的失效方式**：側欄 `to` 與 `onboardingNavPath` 只要差一個字，
   * 那顆點就永遠不亮，而畫面看起來跟「沒事」一模一樣，沒有任何錯誤訊息。
   * 判定端的路徑來自 useSetupStatus 的能力註冊表（lineConnected.route），
   * 這裡確認 layout 傳給元件的就是同一個字串。
   */
  it('layouts/default.vue 的「組織與 LINE」傳的是 settings/organization', () => {
    const layout = readFileSync(
      fileURLToPath(new URL('../layouts/default.vue', import.meta.url)),
      'utf8',
    )
    expect(layout).toContain('<AdminNavAlertDot :path="`/admin/${workspaceId}/settings/organization`" />')
  })
})
