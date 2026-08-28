/**
 * 開通引導與導覽的「流程不變量」防守（2026-08-28 code review 修完後補）。
 *
 * 為什麼用讀原始碼比對字串，而不是跑真的流程：這幾條的失敗方式都是**畫面上沒東西可按**
 * 或**被送去沒權限的頁面**，而它們埋在 while 迴圈與 composable 閉包裡，
 * 要跑起來得先搬出半個 Nuxt。這裡守的是「別再改回去」，不是行為本身——
 * 每一條都對應一個實際被 review 抓到的死路，註解寫清楚踩到會怎樣。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const chat = readFileSync(`${APP_DIR}composables/useOnboardingChat.ts`, 'utf8')
const tutorial = readFileSync(`${APP_DIR}composables/useTutorial.ts`, 'utf8')

describe('等第一則訊息時不能走進死路', () => {
  it('「檢查好了，繼續等」之後仍留得住回排障的入口', () => {
    // 踩到會怎樣：接線驗過的人，waitOptions 只有「先跳過測試」一顆，而「等太久」提示
    // 是一次性的（hintPending 已 false）——按下「繼續等」就再也叫不回排障選單，
    // 正在排障的人畫面上只剩「放棄測試」。
    expect(chat, '「繼續等」不可以退回最初的 waitOptions')
      .toMatch(/val === 'wait'\)\s*\{\s*askOptions = quietOptions/)
    const quiet = chat.slice(chat.indexOf('const quietOptions'), chat.indexOf('let askOptions'))
    expect(quiet, '安靜等的那份也要留著「再驗一次」').toContain("value: 'verify'")
    expect(quiet, '安靜等的那份也要留著「改前面的設定」').toContain("value: 'redo'")
    expect(quiet, '他剛說要安靜等，不該再有填色按鈕在旁邊催').not.toContain('primary: true')
  })

  it('每一組選項都給得出離開的路', () => {
    // 「先跳過測試」是這一段唯一的離場出口，任何一份選項清單漏掉它都會把人關在裡面
    for (const name of ['waitOptions', 'stallOptions', 'quietOptions']) {
      const i = chat.indexOf(`const ${name}`)
      expect(i, `${name} 不見了`).toBeGreaterThan(-1)
      const block = chat.slice(i, i + 700)
      expect(block, `${name} 少了離場出口`).toContain("value: 'skip'")
    }
  })
})

describe('跳過類選項一律標 escape', () => {
  it('開通引導裡沒有漏標的跳過鈕', () => {
    // 踩到會怎樣：漏標的那顆會排在主要鈕正旁邊（拇指落點），而語意相同的其他跳過鈕
    // 在最左邊——同一條流程兩種位置，正是 escape 這個旗標要消滅的不一致。
    const offenders = [...chat.matchAll(/\{\s*label:\s*'([^']*(?:跳過|略過|直接測試|直接檢查|自己逛逛)[^']*)'[^}]*\}/g)]
      .filter(m => !m[0].includes('escape: true'))
      .map(m => m[1]!)
    expect(offenders, `這幾顆是跳過／離開，卻沒標 escape：\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('導覽入口不可繞過角色過濾', () => {
  it('startTopicById 查的是過濾後的清單', () => {
    // 踩到會怎樣：?tour= 是使用者能自己在網址列打的。查未過濾的 TUTORIAL_TOPICS
    // 會把客服／觀察者送進他沒權限的設定頁，然後每一步都指不到東西——
    // 那正是步驟級 stepAllowedForRole 要防的事，在這一層又漏回來。
    const fn = tutorial.slice(
      tutorial.indexOf('function startTopicById'),
      tutorial.indexOf('function startAdHocTour'),
    )
    expect(fn, 'startTopicById 不可以直接查 TUTORIAL_TOPICS').not.toContain('TUTORIAL_TOPICS.find')
    expect(fn).toContain('topics.value.find')
  })
})
