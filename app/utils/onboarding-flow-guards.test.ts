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
const topics = readFileSync(`${APP_DIR}utils/tutorial-topics.ts`, 'utf8')

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

/**
 * 去掉 // 與區塊註解，只留真的會被執行到的程式。
 *
 * ⚠️ 這支不是裝飾：下面那幾條 `toContain('某顆按鈕')` 第一版沒有濾註解，結果**把按鈕
 * 整顆刪掉測試照樣綠**——因為同一段的註解裡就寫著那顆按鈕的名字，`toContain` 比中的是
 * 註解。這正是這個專案一路踩的那種「查不到＝沒問題」的假綠燈，只是換了個地方發生。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 濾掉註解之後的劇本原始碼——下面所有「畫面上有沒有這顆」的斷言一律吃這一份 */
const chatCode = stripComments(chat)

/** 取某一支函式的程式（不含註解）：從它的宣告切到下一支的宣告 */
function fnBody(from: string, to: string): string {
  const i = chatCode.indexOf(from)
  const j = chatCode.indexOf(to)
  expect(i, `找不到 ${from}`).toBeGreaterThan(-1)
  expect(j, `找不到 ${to}`).toBeGreaterThan(i)
  return chatCode.slice(i, j)
}

describe('使用者看得到的字裡沒有「接線」', () => {
  it('進度條與劇本文案都改用白話（2026-09-02）', () => {
    // 踩到會怎樣：五格進度條裡只有那一格是工程隱喻，使用者不知道自己在接什麼線。
    // 這條特別容易改一半——「接線」在這個檔裡出現十幾次，絕大多數在註解裡（那些沒關係），
    // 漏掉的通常是 say() 或 label 裡的那幾句，而畫面上就會變成進度條寫「讓訊息進來」、
    // 小幫手嘴上還在講「最後一步接線」。
    expect(chatCode, '劇本的字串裡不可以再有「接線」（註解不算）').not.toContain('接線')
    expect(chatCode).toContain("'讓訊息進來'")
  })
})

describe('拿掉教學閘門之後不可以長回來', () => {
  it('第二把鑰匙直接播教學，並留著「重貼第一把」的回頭路', () => {
    // 踩到會怎樣：這支教學只有一則，「要不要教你拿」問下去省不到任何東西
    //（選「直接貼上」的人省下的就是那一則），閘門純粹多收一次點擊和一個決定。
    // 而「回上一步：重貼第一把」是剛存完第一把才發現貼錯的唯一回頭路，
    // 拿掉閘門時最容易連它一起弄丟——弄丟了那個窗口就只能等接線檢查才診斷得出來。
    const step = fnBody('async function stepSecret', 'async function walkSecretNodes')
    expect(step, '不可以再問「要不要教你拿」').not.toContain('教我怎麼拿')
    expect(step, '教學要直接播').toContain('await walkSecretNodes()')
    expect(step, '回頭路不見了').toContain('回上一步：重貼第一把')
  })

  it('關自動回應直接播教學，而且那一排同時給得出「做完了」和「我會關」', () => {
    // 踩到會怎樣：這一步沒有東西要貼回來，教學不擋在任何輸入框前面，問「要不要教」
    // 實際上是在問「你知不知道有這個東西」——而 LINE 內建自動回應預設就是開的，
    // 100% 的人都得做。拿掉閘門之後，底下那一排就是這一步**唯一**的按鈕列：
    // 少了「我會關，直接測試」就沒有出口，少了「關好了，來測試」就少掉 08-28 拍板
    // 要的那個確認（跨兩個後台的兩件事，疊在一起會有人漏掉其中一件）。
    const step = fnBody('async function teachAutoReplyOff', 'async function showOaInvite')
    expect(step, '不可以再問「要不要教你關」').not.toContain('教我一步步關')
    expect(step, '確認鈕不見了').toContain('關好了，來測試')
    expect(step, '出口不見了').toContain('我會關，直接測試')
  })

  it('重貼鑰匙時主鈕是「直接貼新的」不是教學', () => {
    // 踩到會怎樣：會走到重貼的人已經走過一遍教學了，八成是貼錯要換一把。
    // 主鈕給教學＝把他最不需要的東西放在拇指落點上。
    const fn = fnBody('async function redoKeyFlow', 'async function verifyAndAdvise')
    expect(fn).toMatch(/label: '我會拿，直接貼新的', value: 'paste', primary: true/)
    expect(fn, '教學不可以再佔著主鈕').not.toMatch(/label: '教我一步步拿', value: 'walk', primary: true/)
  })
})

describe('教學翻頁不會生出沒有字的按鈕', () => {
  it('exitLabel 是空字串時不 push 出口鈕', () => {
    // 踩到會怎樣：單節點的教學（第二把鑰匙、關自動回應）exitLabel 傳的是空字串。
    // 現在它們在 isLast 就 return、碰不到那段，但只要有人日後幫它們加第二個節點，
    // 畫面上就會多一顆**完全沒有字**的按鈕，而且不會有任何測試變紅。
    const fn = fnBody('async function walkNodes', 'async function stepToken')
    expect(fn).toMatch(/if \(exitLabel\)\s*\n\s*options\.push\(\{ label: exitLabel/)
  })
})

describe('第一次一定要看導覽（2026-09-02 拍板）', () => {
  it('開通結尾不再給「不看導覽直接進去」的出口', () => {
    // 踩到會怎樣：那顆一長回來，就沒有人會看導覽了——而導覽現在是唯一會把人送到
    // 「你剛剛傳的那句話」面前的路。08-28 留那顆的工作已經由導覽最後一步接手。
    const end = stripComments(chat.slice(chat.indexOf('async function stepDone')))
    expect(end, '結尾不該再有直接進後台的按鈕').not.toContain("value: 'workspace'")
    expect(end, '導覽那顆要在').toContain("value: 'tour'")
  })

  it('導覽的最後一步是「你剛剛傳的那句話」，不是介面註腳', () => {
    // 踩到會怎樣：拿掉之後，客人被強迫看完 2 分鐘導覽，最後收在「每一頁都有問號」
    // 這種關於介面的註腳，而他剛剛親手做成的那件事沒有人帶他去看。
    const i = topics.indexOf('OVERVIEW_TOPIC_ID,')
    const j = topics.indexOf("id: 'organization'", i)
    const overview = stripComments(topics.slice(i, j))
    const lastTarget = [...overview.matchAll(/target: '(\[data-tour="[^"]+"\])'/g)].pop()
    expect(lastTarget?.[1], 'OVERVIEW 的最後一步要指對話訊息').toBe('[data-tour="conv-messages"]')
    expect(overview, '一場對話都沒有的人要跳過這一步').toContain("requiresPresent: '.conv-list-row .split-list-item'")
  })

  it('導覽的「前提在不在」必須在換頁之後才問', () => {
    // 踩到會怎樣：**這是靜默失效**。前提判斷若跑在 router.push 之前，問的是上一頁的 DOM，
    // 任何 requiresPresent 指向目標頁元素的步驟都會被無聲刷掉——沒有錯誤、沒有 log，
    // 只是那幾步再也不會出現。上面那條「最後一步」100% 會中（從開通頁開導覽時，
    // 對話清單根本還不存在）。
    const fn = stripComments(tutorial.slice(
      tutorial.indexOf('async function startTopic('),
      tutorial.indexOf('function startTopicById'),
    ))
    const push = fn.indexOf('router.push')
    const check = fn.indexOf('stepPreconditionMet')
    expect(push, '找不到導航').toBeGreaterThan(-1)
    expect(check, '找不到前提判斷').toBeGreaterThan(-1)
    expect(check, '前提判斷不可以早於導航').toBeGreaterThan(push)
    // ⛔ 也不能退回一次性 querySelector：對話清單是非同步載入的，剛換頁一定還是空的
    expect(fn, '前提要「短暫等它出現」不是問一次就算').toMatch(/waitForElement\(sel/)
  })
})
