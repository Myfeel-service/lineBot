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
// 2026-09-11：捲動那條不變量橫跨引擎與頁面（引擎記「這一輪的第一則」、頁面負責真的捲）
const runner = readFileSync(`${APP_DIR}composables/useAgentScriptRunner.ts`, 'utf8')
const page = readFileSync(`${APP_DIR}pages/admin/onboarding.vue`, 'utf8')

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
    // 2026-09-06 又換一次字：五格要跟開場那句四步用**同一組字**（見 ONBOARDING_PROGRESS_LABELS）
    expect(chatCode).toContain("'接收 LINE 訊息'")
  })
})

describe('拿掉教學閘門之後不可以長回來', () => {
  it('第二組連線資訊直接播教學，並留著「重貼第一組」的回頭路', () => {
    // 踩到會怎樣：這支教學只有一則，「要不要教你拿」問下去省不到任何東西
    //（選「直接貼上」的人省下的就是那一則），閘門純粹多收一次點擊和一個決定。
    // 而「回上一步：重貼第一把」是剛存完第一把才發現貼錯的唯一回頭路，
    // 拿掉閘門時最容易連它一起弄丟——弄丟了那個窗口就只能等接線檢查才診斷得出來。
    const step = fnBody('async function stepSecret', 'async function walkSecretNodes')
    expect(step, '不可以再問「要不要教你拿」').not.toContain('教我怎麼拿')
    expect(step, '教學要直接播').toContain('await walkSecretNodes()')
    expect(step, '回頭路不見了').toContain('回上一步：重貼第一組')
  })

  it('接線教學直接播，不問「要不要教你」', () => {
    // 踩到會怎樣：這兩步沒有東西要貼回來，教學不擋在任何輸入框前面，問「要不要教」
    // 實際上是在問「你知不知道有這個東西」——而 LINE 內建自動回應預設就是開的，
    // 100% 的人都得做。
    // ⚠️ 2026-09-06 這一段從 `teachAutoReplyOff` 改名為 `teachConnect`：貼網址與回應設定
    //    兩件事都搬到官方帳號後台之後，它們是同一段路，合成一支教學。
    //    原本尾巴那兩顆（「關好了，來測試」／「我會關，直接測試」）也拿掉了——老闆問
    //    「是否只需要一顆」，查下去發現**兩顆的回傳值根本沒被使用**、走向完全一樣＝假選擇；
    //    現在教學跑完直接進下面的檢查選單，那一排本身就是確認。
    // ⚠️ 2026-09-10 改看輪播的名字，不看文案字串：兩步的操作說明搬進
    //    `ONBOARDING_CAROUSELS`（圖說跟分鏡綁在一起），`teachConnect` 裡不再字面出現
    //    「Webhook網址」「回應設定」。守的東西沒變——**這兩步都還在**。
    // ⚠️ 2026-09-11 `showOaInvite` 改名 `loadOaInvite`：見證時刻併成一張兩步驟卡之後，
    //    這支只負責去查帳號代號、不自己出卡（卡由 `stepFirstMessageWait` 重畫）。
    const step = fnBody('async function teachConnect', 'async function loadOaInvite')
    expect(step, '不可以再問「要不要教你關」').not.toContain('教我一步步關')
    expect(step, '兩步都要在（貼網址、回應設定）').toContain('ONBOARDING_CAROUSELS.webhookUrl')
    expect(step, '兩步都要在（貼網址、回應設定）').toContain('ONBOARDING_CAROUSELS.responseSettings')
  })

  it('第二組連線資訊要從官方帳號後台拿，不可以改回 LINE Developers', () => {
    // ⛔ 踩到會怎樣：**這是全流程唯一「照著做也會錯」的地方**。LINE Developers 的卡片清單裡
    //    同名卡有兩張，點到 `LINE Login` 那張，它的 Basic settings **也有**一個 Channel secret，
    //    貼進來系統照收、還回一句「收到 ✓ 已經幫你存好」，然後客人每句話都被當成假冒的丟掉，
    //    而且**畫面上一切正常**、什麼地方都不會亮紅。
    //    官方帳號後台那一頁沒有卡片可以挑（它就是「這個帳號」的設定頁），錯誤機會直接消失。
    //    改回去＝把那個靜默災難請回來，而且會連帶需要重新掛回認錯卡對照圖與整段警告。
    const fn = fnBody('async function walkSecretNodes', 'async function verifyWebhook')
    expect(fn, '第二組要指官方帳號後台').toContain('manager.line.biz')
    expect(fn, '不可以改回 LINE Developers').not.toContain('developers.line.biz')
    // 2026-09-10：循環動畫 `oamChannelSecretAnim` → 步驟輪播 `channelSecret`（同一段路、同一個後台）
    expect(fn, '要用官方帳號後台那支輪播').toContain('ONBOARDING_CAROUSELS.channelSecret')
  })

  it('接線教學必須播在「幫我檢查」之前', () => {
    // ⛔ 踩到會怎樣：Webhook 開關現在跟「關自動回應」在**同一頁**（回應設定），
    //    是 teachConnect 第二個節點才會教到的事。若把檢查排在教學之前（或把教學改回
    //    「要不要教你」的閘門讓人可以先按檢查），**一定驗不過**——而那個失敗看起來像
    //    「設定錯了」，其實只是「還沒做到」。被嚇到的人會回頭亂改已經正確的設定。
    const fn = fnBody('async function stepWebhookAndFirstMsg', 'async function teachConnect')
    const teach = fn.indexOf('await teachConnect()')
    const loop = fn.indexOf('while (!verified)')
    expect(teach, '找不到 teachConnect 的呼叫').toBeGreaterThan(-1)
    expect(loop, '找不到檢查迴圈').toBeGreaterThan(-1)
    expect(teach, '教學必須排在檢查迴圈之前').toBeLessThan(loop)
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

describe('2026-09-11 那批「不知道現在該幹嘛」的修法不可以被改回去', () => {
  it('貼連線資訊前要有交棒句，而且在迴圈裡（教學重播完會再講一次）', () => {
    // 踩到會怎樣：整條流程都是「按對話裡的按鈕」，只有貼連線資訊這兩步動作跑到**最下面
    // 那條輸入區**。教學最後一格演的是「在 LINE 那邊按複製」，演完畫面靜止——
    // 沒有這一句，人會繼續等下一張圖。
    expect(chatCode, '交棒句不見了').toContain('const HANDOFF =')
    for (const [fn, next] of [
      ['async function stepToken', 'async function walkTokenNodes'],
      ['async function stepSecret', 'async function walkSecretNodes'],
    ] as const) {
      const step = fnBody(fn, next)
      const loop = step.slice(step.indexOf('while ('))
      expect(loop, `${fn} 的迴圈裡要有交棒句`).toContain('await say(HANDOFF)')
    }
  })

  it('換後台是獨立一步，而且那一步不放教學圖', () => {
    // 踩到會怎樣：「換到另一個後台」如果只是泡泡的後半句，底下緊接著「點右上角設定」的
    // 輪播——而那顆「設定」**兩個後台都有**，人留在 LINE Developers 照著做一路做得下去，
    // 錯要到最後接不通才爆（正是 09-06 大搬家要消滅的那類「照著做也會錯」）。
    // ⛔ 那一步也不可以放輪播：它唯一要傳達的是「換後台了」，自動播放的圖會把眼睛拉走。
    const walk = fnBody('async function walkSecretNodes', 'async function verifyWebhook')
    expect(walk, '換後台那一步的按鈕要他宣示「我打開了」').toContain("nextLabel: '我打開了，下一步'")
    expect(walk, '要有「換後台」徽章').toContain('class="agm-flag"')
    expect(walk, '兩個後台都要指名道姓').toContain('LINE Developers')
    const first = walk.slice(0, walk.indexOf("nextLabel: '我打開了，下一步'"))
    expect(first, '換後台那一步不可以放輪播').not.toContain('carousel:')
    expect(walk.match(/carousel:/g)?.length, '教學圖只留在第二步').toBe(1)
  })

  it('見證時刻是一張兩步驟卡，收到訊息時打勾而不是把卡換掉', () => {
    // 踩到會怎樣：①②寫在泡泡、①要用的 QR 在下一張卡、②的狀態在再下一張卡——
    // 讀者得自己連線。而後端**只認真的訊息**（加好友寫的是 traceOnly 的 customer_action），
    // 所以「加好友還不算」這句一定要在第②步旁邊。
    const step = fnBody('async function stepFirstMessageWait', 'async function redoKeyFlow')
    expect(step, '見證卡不見了').toContain("kind: 'witness'")
    expect(step, '收到訊息要打勾（不是把卡換成強調卡）').toContain("setWait('ok'")
    expect(step, '強調卡要另外接在後面').toContain("kind: 'highlight'")
    expect(step, '訊息是自己飄進來的，要自己宣告新的一輪').toContain('startTurn()')
    // 卡住那張清單的第一條＝唯一一條跟設定無關、而且最可能的那條
    expect(step, '卡住清單要有「只加了好友」那條').toContain('只加了好友')
    expect(step, '清單是五條').toContain("summary: '照這五條檢查'")
  })

  it('一輪的第一則要記下來（頁面靠它把第一句貼到頂）', () => {
    // 踩到會怎樣：捲到底的意思其實是「從最後一句開始看」——一步的內容是泡泡→連結卡→教學圖，
    // 捲到底剛好把「這一步要做什麼」那句話推出畫面，人看到的是一張沒有前因的圖。
    const runnerCode = stripComments(runner)
    expect(runnerCode, 'turnStartId 不見了').toContain('const turnStartId =')
    // ⛔ 切到**下一支函式的宣告**，不要用「往後抓 N 個字」——第一版抓 600 字，
    //    視窗直接蓋到隔壁的 onSkip，把 onPick 的 startTurn 整行刪掉測試照樣綠（實測過）。
    for (const fn of ['function onChoice', 'function onSubmit', 'function onPick', 'function onSkip']) {
      const i = runnerCode.indexOf(fn)
      expect(i, `找不到 ${fn}`).toBeGreaterThan(-1)
      const rest = runnerCode.slice(i + fn.length)
      const end = rest.search(/\n {2}(?:async )?function /)
      const body = end > 0 ? rest.slice(0, end) : rest
      expect(body, `${fn} 要宣告新的一輪`).toContain('startTurn()')
    }
    expect(stripComments(page), '頁面要用 turnStartId 決定捲到哪').toContain('turnStartId.value')
  })
})
