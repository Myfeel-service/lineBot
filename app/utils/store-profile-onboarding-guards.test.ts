/**
 * 「認識你的店」接進開通精靈之後的流程不變量（`D-85` / `C-219`）。
 *
 * 跟 `onboarding-flow-guards.test.ts` 同一種守法：讀原始碼比對字串。
 * 這幾條的失敗方式都是**改一半**——進度條加了一格但劇本沒動、官網那份抄過去的
 * 標籤沒跟上、閘門的次要鈕忘了講後果——跑起來不會壞，只會慢慢說謊。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BUILD_STEP,
  LINE_STEP,
  ONBOARDING_BUILD_LABELS,
  ONBOARDING_FLOWS,
  ONBOARDING_LINE_LABELS,
} from '~/composables/useOnboardingChat'
import { ONBOARDING_CAROUSELS } from '~/utils/onboarding-shots'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const chat = readFileSync(`${APP_DIR}composables/useOnboardingChat.ts`, 'utf8')
const landing = readFileSync(`${APP_DIR}pages/index.vue`, 'utf8')
const setupStatus = readFileSync(`${APP_DIR}composables/useSetupStatus.ts`, 'utf8')
const onboardingPage = readFileSync(`${APP_DIR}pages/admin/onboarding.vue`, 'utf8')
const layout = readFileSync(`${APP_DIR}layouts/default.vue`, 'utf8')

/** 拿掉 `//` 註解——「⛔ 不可以再說 X」這種交代歷史的註解本身就含 X，查使用者看得到的字要先剝掉 */
const stripComments = (s: string) => s.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')

/** 全新開通（打造那一趟）的劇本：`start()` 裡「打造你的 MiniMe」那一段 */
const startAt = chat.indexOf('async function start(')
const buildFlow = chat.slice(chat.indexOf('── 打造你的 MiniMe（全新開通）', startAt), chat.indexOf('function markLeaving', startAt))
const lineFlow = chat.slice(chat.indexOf('── 接上 LINE 那一趟', startAt), chat.indexOf('── 打造你的 MiniMe（全新開通）', startAt))

describe('兩趟、各四格（`C-250`，示意頁 v80）', () => {
  it('打造那一趟：建立帳號 → 認識你的店 → 看看成果 → 完成打造', () => {
    // 踩到會怎樣：打造與接 LINE 又畫回同一條路——走到第三格就撞上要登入別人的後台，
    // 前面的成功率被後面拖著走（`D-88` 要修的病）。
    expect([...ONBOARDING_BUILD_LABELS]).toEqual(['建立帳號', '認識你的店', '看看成果', '完成打造'])
  })

  it('接 LINE 那一趟：取得連線資訊 → 接收 LINE 訊息 → 用手機測試 → 上線完成', () => {
    // ⚠️ 第三格是「用手機測試」不是「傳訊息測試」（v79）：那一步頭頂跟卡片要講同一件事
    expect([...ONBOARDING_LINE_LABELS]).toEqual(['取得連線資訊', '接收 LINE 訊息', '用手機測試', '上線完成'])
  })

  it('索引常數跟標籤對得起來', () => {
    // 踩到會怎樣：常數是為了不要在劇本裡散落 magic number 才存在的，
    // 它自己跟標籤飄掉的話，進度條會停在錯的格子而畫面完全正常。
    expect(ONBOARDING_BUILD_LABELS[BUILD_STEP.create]).toBe('建立帳號')
    expect(ONBOARDING_BUILD_LABELS[BUILD_STEP.profile]).toBe('認識你的店')
    expect(ONBOARDING_BUILD_LABELS[BUILD_STEP.reveal]).toBe('看看成果')
    expect(ONBOARDING_BUILD_LABELS[BUILD_STEP.done]).toBe('完成打造')
    expect(ONBOARDING_LINE_LABELS[LINE_STEP.credentials]).toBe('取得連線資訊')
    expect(ONBOARDING_LINE_LABELS[LINE_STEP.receive]).toBe('接收 LINE 訊息')
    expect(ONBOARDING_LINE_LABELS[LINE_STEP.testMessage]).toBe('用手機測試')
    expect(ONBOARDING_LINE_LABELS[LINE_STEP.done]).toBe('上線完成')
  })

  it('⛔ 劇本裡不可以再出現寫死的 progress 數字', () => {
    const hardcoded = chat.match(/progress\.value\s*=\s*\d/g) ?? []
    expect(hardcoded, `這幾處要改用 BUILD_STEP／LINE_STEP：${hardcoded.join('、')}`).toEqual([])
  })

  it('⛔ 不寫「第 1 段／第 2 段」（老闆 09-25：「第一段第二段不好理解」）', () => {
    // 拆兩趟是我們內部的設計，對他只有兩件各自獨立的事；講「第 1 段」等於暗示還有第 2 段在等他
    const names = Object.values(ONBOARDING_FLOWS).map(f => f.name).join(' ')
    expect(names).not.toMatch(/第\s*[12一二]\s*段/)
    // ⚠️ 只查使用者看得到的字串（註解裡講「第 1 段」是在交代歷史，不算）
    const userStrings = [...chat.matchAll(/(?:say|label:)\s*\(?\s*['`]([^'`]*)['`]/g)].map(m => m[1]).join('\n')
    expect(userStrings).not.toMatch(/第\s*[12]\s*段/)
  })

  it('頁首的名字、要多久、四格吃同一份資料（⛔ 分散三處就會各說各話）', () => {
    expect(onboardingPage).toContain('flowInfo.name')
    expect(onboardingPage).toContain('flowInfo.time')
    expect(onboardingPage).toContain('flowInfo.labels')
  })

  it('官網示範那份抄過去的標籤跟「接 LINE 那一趟」一字不差（那支示範演的就是那一趟）', () => {
    const m = landing.match(/const OB_PROGRESS_LABELS = \[([^\]]+)\]/)
    expect(m, '官網那份 OB_PROGRESS_LABELS 不見了').toBeTruthy()
    const copied = m![1]!.split(',').map(s => s.trim().replace(/^'|'$/g, ''))
    expect(copied).toEqual([...ONBOARDING_LINE_LABELS])
    expect(landing).toContain(`name: '${ONBOARDING_FLOWS.line.name}'`)
  })
})

describe('打造那一趟（`C-250`／`D-102`）', () => {
  it('建立帳號 → 五題 → 揭曉 → 草稿 → 成績單，⛔ 中間不接 LINE', () => {
    const create = buildFlow.indexOf('await stepCreate()')
    const profile = buildFlow.indexOf('await stepStoreProfile()')
    const reveal = buildFlow.indexOf('await revealStoreProfile()')
    const drafts = buildFlow.indexOf('await stepStoreDrafts(')
    const finish = buildFlow.indexOf('await stepBuildFinish(')
    expect(create).toBeGreaterThan(-1)
    expect(profile).toBeGreaterThan(create)
    expect(reveal).toBeGreaterThan(profile)
    expect(drafts).toBeGreaterThan(reveal)
    expect(finish).toBeGreaterThan(drafts)
    // ⛔ 老闆 09-25「打造 MiniMe 之後直接進後台，之後再讓他自己決定什麼時候要串接 LINE」
    expect(buildFlow).not.toContain('stepHasOA')
    expect(buildFlow).not.toContain('MAIN_FLOW')
    expect(chat, '「要不要接 LINE」的閘門已經拆掉').not.toContain('async function stepConnectGate')
  })

  it('⛔ 結尾只有一顆「進入後台」，落在測試對話', () => {
    const i = chat.indexOf('async function stepBuildFinish')
    expect(i).toBeGreaterThan(-1)
    const block = chat.slice(i, chat.indexOf('// ── 入口', i))
    expect(block).toContain("askChoices([{ label: '進入後台', value: 'go', primary: true }])")
    expect(block).toContain('onboardingBuiltLandingPath')
    expect(block, '⛔ 不再有「現在就接 LINE」').not.toContain('接 LINE（')
    // 老闆：「這句是否先不用，進去後馬上接 tour 了」
    expect(block).not.toContain('先進後台看看')
    expect(block).not.toContain('這些在後台都改得到')
  })

  it('成績單叫「MiniMe 打造完成」，列得出「哪幾樣」，⛔ 不叫「第 1 段完成」', () => {
    const i = chat.indexOf('async function stepBuildFinish')
    const block = chat.slice(i, chat.indexOf('// ── 入口', i))
    expect(block).toContain("title: 'MiniMe 打造完成'")
    expect(block).toContain('draftSteps.map')
    // ⚠️ 「接上 LINE 之後」不能拿掉：每日摘要只送通知名單裡的手機（`D-100`）
    expect(block).toContain('接上 LINE 之後，節日前會在早上的摘要提醒你')
  })

  it('⛔ 痛點回扣只講真的建了的東西（對不上就整句不講）', () => {
    const i = chat.indexOf('function painPayoff')
    const block = chat.slice(i, chat.indexOf('async function stepBuildFinish', i))
    expect(block).toContain("builtKeys.has('welcome')")
    expect(block).toContain("builtKeys.has('tags')")
    // 「客服回不完」要指的知識卡這一趟還不會產生 → 先不講
    expect(block).not.toContain('客服回不完')
  })
})

describe('接 LINE 那一趟（`?workspaceId=`）', () => {
  it('還沒拿過任何連線資訊的人先問「有沒有官方帳號」', () => {
    expect(lineFlow).toContain('await stepHasOA()')
    expect(lineFlow).toContain("flow.value = 'line'")
  })

  it('⛔ 成績單前不再揭曉輪廓、不再給草稿（那兩樣已經在打造那一趟給過）', () => {
    // 踩到會怎樣：走完兩趟的人看到同一張卡兩次、同幾樣草稿被問兩次——重複採用會多出重複的腳本與標籤
    const i = chat.indexOf('async function stepDone')
    const block = chat.slice(i, chat.indexOf('// ── 打造這一趟的結尾', i))
    expect(block).not.toContain('await revealStoreProfile()')
    expect(block).not.toContain('stepStoreDrafts(')
  })
})

describe('「加入好友的歡迎訊息」那顆開關（`D-100`）', () => {
  it('⛔ 採用歡迎訊息時的承諾，接 LINE 那一步真的兌現（照有沒有自己的歡迎訊息換講法）', () => {
    // 踩到會怎樣：草稿附註說「接上 LINE 那一步會提醒你關掉」，這裡卻照舊寫「不用動」＝兩處教相反，
    // 照做的客人加好友會連收兩則
    const i = chat.indexOf('async function teachConnect')
    const block = chat.slice(i, i + 4000)
    expect(block).toContain('await hasActiveFollowWelcome()')
    expect(block).toContain('ownWelcome ? ONBOARDING_CAROUSELS.responseSettingsOwnWelcome : ONBOARDING_CAROUSELS.responseSettings')
    expect(block).toContain('關掉 LINE 內建的歡迎訊息')
  })

  it('兩支輪播只差第 3 格的字：有自己那則的叫他關掉，沒有的照舊不用動', () => {
    const own = ONBOARDING_CAROUSELS.responseSettingsOwnWelcome
    const plain = ONBOARDING_CAROUSELS.responseSettings
    expect(own.map(s => s.src)).toEqual(plain.map(s => s.src))
    expect(own[2]!.caption).toContain('<b>關掉</b>')
    expect(plain[2]!.caption).toContain('<b>不用動</b>')
    expect(own.filter((s, k) => s.caption !== plain[k]!.caption)).toHaveLength(1)
  })

  it('⛔ 查不到就當沒有（講「不用動」最壞收兩則；講「關掉」最壞一則都沒有）', () => {
    const i = chat.indexOf('async function hasActiveFollowWelcome')
    const block = chat.slice(i, chat.indexOf('async function teachConnect', i))
    expect(block).toMatch(/catch \{\s*return false/)
  })
})

describe('拉回精靈的規則（`D-88` ②）', () => {
  it('⛔ 只拉回「接 LINE 接到一半」的人，而且拉的同時收旗（一次性）', () => {
    const i = layout.indexOf('async function maybePopOnboarding')
    const block = layout.slice(i, i + 900)
    expect(block).toContain('isLineFlowInProgress(wid)')
    expect(block).toContain('clearLineFlowInProgress(wid)')
  })

  it('接 LINE 那一趟開始時立旗、走到成績單收旗、按「之後再說」也收旗', () => {
    expect(lineFlow).toContain('markLineFlowInProgress(wid.value)')
    const i = chat.indexOf('async function stepDone')
    expect(chat.slice(i, i + 4000)).toContain('clearLineFlowInProgress(wid.value)')
    expect(onboardingPage).toContain('@click="markLeaving"')
  })
})

describe('五題問答', () => {
  it('⛔ 選項不可以有 primary（這幾題沒有「建議答案」）', () => {
    // 踩到會怎樣：把某個選項染成主要動作＝暗示那是對的，收上來的輪廓會往那邊偏。
    const i = chat.indexOf('async function stepStoreProfile')
    const block = chat.slice(i, chat.indexOf('// ── 五樣草稿', i))
    expect(block).toContain('def.options.map(o => ({ label: o, value: o }))')
  })

  it('⛔ 每一題按鈕題都有出口「都不是，我自己講」，而且不是「其他」', () => {
    const i = chat.indexOf('async function stepStoreProfile')
    const block = chat.slice(i, chat.indexOf('// ── 五樣草稿', i))
    expect(block).toContain("label: '都不是，我自己講', value: FREE_ANSWER, escape: true")
    expect(block).toContain('def.freeAsk')
  })

  it('⛔ 第 2、3、4 題的問法照型換（牙醫不會被問「主要賣什麼」「賣給誰」「怎麼買」）', () => {
    const i = chat.indexOf('async function stepStoreProfile')
    const block = chat.slice(i, chat.indexOf('// ── 五樣草稿', i))
    expect(block).toContain('wording.productsQuestion')
    expect(block).toContain('wording.customersQuestion')
    expect(block).toContain('wording.channelQuestion')
    // `C-260`：開場那句在第 1 題之前，還不知道型——不可以先講「賣」
    expect(stripComments(block)).not.toContain('知道你賣什麼')
  })

  it('五題答完先存，再去讀網站', () => {
    // 踩到會怎樣：讀網站失敗時，他剛答的五題會跟著陪葬——而那五題才是最貴的東西
    //（AI 猜得到網站上的事，猜不到「你現在最想解決什麼」）。
    const i = chat.indexOf('async function stepStoreProfile')
    const block = chat.slice(i, chat.indexOf('// ── 五樣草稿', i))
    const save = block.indexOf("apiFetch('/api/store-profile'")
    const read = block.indexOf('/api/store-profile/read-site')
    expect(save).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(save)
  })

  it('沒有網站的人跳得掉', () => {
    const i = chat.indexOf('async function stepStoreProfile')
    const block = chat.slice(i, chat.indexOf('// ── 五樣草稿', i))
    // skipLabel 沒配 skippable 不會長出那顆鈕——兩個都要在
    expect(block).toContain('skippable: true')
    expect(block).toContain('沒有網站')
  })

  it('⛔ 讀網站那句不再說「先把 LINE 接起來」（拆兩趟之後下一步就是等它讀完）', () => {
    const i = chat.indexOf('async function stepStoreProfile')
    const block = chat.slice(i, chat.indexOf('// ── 五樣草稿', i))
    expect(stripComments(block)).not.toContain('先把 LINE 接起來')
  })
})

describe('揭曉', () => {
  it('⭐ 檢查點「都對了，繼續」擋在草稿前面（`D-91`）', () => {
    // 踩到會怎樣：草稿是照輪廓生的，先生完再讓他改，下面那幾樣就全是照舊資料做的
    const i = chat.indexOf('async function revealStoreProfile')
    const block = chat.slice(i, chat.indexOf('let profileCardId', i))
    expect(block).toContain("label: '都對了，繼續'")
  })

  it('⭐ 分組又可以就地修改；改完寫回輪廓（下面的草稿照改過的生）', () => {
    const i = chat.indexOf('async function revealStoreProfile')
    const block = chat.slice(i, chat.indexOf('let profileCardId', i))
    expect(block).toContain('grouped: true')
    const e = chat.indexOf('async function onProfileEdit')
    const edit = chat.slice(e, e + 1600)
    expect(edit).toContain('revealedProfile = r.profile')
    expect(edit, '存不進去要講').toContain('沒存進去')
  })

  it('讀網站時看得到「正在讀」（⛔ 拆兩趟之後它不再躲在接 LINE 的等待裡）', () => {
    const i = chat.indexOf('async function revealStoreProfile')
    const block = chat.slice(i, i + 1500)
    expect(block).toContain('正在讀你的網站')
  })

  it('等讀網站一定要有上限', () => {
    // 踩到會怎樣：`pollUntil` 本身沒有上限（它是給「等客人傳訊息」用的）。
    // 沒有封頂的話，網站卡住時人會坐在一個沒有任何按鈕的畫面前面。
    expect(chat).toContain('SITE_JOB_MAX_WAIT_MS')
    const i = chat.indexOf('async function revealStoreProfile')
    const block = chat.slice(i, i + 2500)
    expect(block, '要用 race 封頂').toContain('Promise.race')
    expect(block, '封頂之後要把輪詢停掉').toContain('poll.stop()')
  })

  it('查不到輪廓就不要畫卡', () => {
    // 踩到會怎樣：畫一張空卡等於說「我對你一無所知」，而那不是真的——只是這次查詢失敗。
    const i = chat.indexOf('async function revealStoreProfile')
    const block = chat.slice(i, i + 3000)
    expect(block).toContain('filledFieldCount')
  })
})

describe('五樣草稿（C-221）', () => {
  it('⛔ 先畫草稿卡、再問採用（不可以先寫出去才問）', () => {
    const i = chat.indexOf('async function stepStoreDrafts')
    expect(i).toBeGreaterThan(-1)
    const block = chat.slice(i, i + 4000)
    const cardAt = block.indexOf("kind: 'store-draft'")
    const askAt = block.indexOf("label: '採用'")
    const applyAt = block.indexOf('applyOneDraft')
    expect(cardAt).toBeGreaterThan(-1)
    expect(askAt).toBeGreaterThan(cardAt)
    expect(applyAt).toBeGreaterThan(askAt)
  })

  it('⛔ 有東西沒成時一定要點名已經建好的（不然人會重跑而多出重複的東西）', () => {
    const i = chat.indexOf('async function stepStoreDrafts')
    const block = chat.slice(i, i + 5000)
    expect(block).toContain('outcome.leftovers')
    expect(block).toContain('不要整個重來')
  })

  it('⛔ 知識庫不在對話裡直接寫進去（卡片內容要人看過）', () => {
    const i = chat.indexOf('async function applyOneDraft')
    const block = chat.slice(i, i + 2500)
    expect(block, '不可以在這裡就把卡片建進知識庫').not.toContain('bulk-create')
  })

  it('⭐ 採用的是他改過的那一版（`D-94`：草稿一開始就可以改）', () => {
    // 踩到會怎樣：他改了字，寫出去的卻是範本原文——最糟的那種假按鈕
    const i = chat.indexOf('async function stepStoreDrafts')
    const block = chat.slice(i, i + 6000)
    expect(block).toContain('draftEdits.get(cardId)')
    expect(block).toContain('body: finalBody')
    // 標籤只建有勾的那幾顆
    expect(block).toContain('t.on && t.name.trim()')
  })

  it('⛔ 「先不要」講一條真的走得到的路（不再說「組織與 LINE 頁的輪廓卡還找得到」）', () => {
    const i = chat.indexOf('async function stepStoreDrafts')
    const block = chat.slice(i, i + 6000)
    expect(stripComments(block)).not.toContain('輪廓卡還找得到')
  })

  it('採用一樣失敗不會中斷其他樣（這幾樣彼此獨立）', () => {
    const i = chat.indexOf('async function applyOneDraft')
    const block = chat.slice(i, i + 2500)
    // 失敗回一筆 failed，而不是往外拋
    expect(block).toContain("status: 'failed'")
    expect(block).not.toContain('throw')
  })

  it('標籤代號由系統生、撞號自動換（畫面上沒有那一格，不可以叫他改代號）', () => {
    const i = chat.indexOf('async function applyOneDraft')
    const block = chat.slice(i, i + 2500)
    expect(block).toContain('suggestTagCode')
    expect(block).toContain('taken')
  })
})

describe('只做輪廓那一趟（補 C-219 的死路）', () => {
  it('`?focus=profile` 這條路存在，而且只跑輪廓不跑接線', () => {
    // 踩到會怎樣：組織頁那顆按鈕會把人帶進續走模式，而續走只跑接線那四步——
    // 已經接好 LINE 的人會看到「歡迎回來」然後直接跳到成績單，五題一句都沒問。
    expect(chat).toContain('async function runProfileOnly')
    expect(chat).toContain("focus === 'profile'")
  })

  it('輪廓卡的出口一定要帶 focus=profile', () => {
    const cardVue = readFileSync(`${APP_DIR}components/admin/AdminStoreProfileCard.vue`, 'utf8')
    expect(cardVue).toContain('focus=profile')
  })

  it('這一趟結束要給得出出路（不要停在沒有按鈕的對話上）', () => {
    const i = chat.indexOf('async function finishProfileOnly')
    expect(i).toBeGreaterThan(-1)
    const block = chat.slice(i, i + 1600)
    expect(block).toContain("value: 'back', escape: true")
  })
})

describe('老店反推（C-222）', () => {
  it('⛔ 按「都對」要把 AI 猜的轉成「你說的」', () => {
    // 踩到會怎樣：`profileReady` 的口徑是「商家親自答了三題」。不轉的話，
    // 老店走完整趟仍被判成「還不認識」，輪廓卡繼續顯示空狀態——
    // 做完一件事卻看不到任何變化，是最傷信任的那種 bug。
    const i = chat.indexOf('async function offerInference')
    expect(i).toBeGreaterThan(-1)
    const block = chat.slice(i, i + 3500)
    expect(block).toContain("v.source === 'ai'")
    expect(block).toContain("apiFetch<{ profile: StoreProfileDoc }>('/api/store-profile'")
  })

  it('猜不出來要誠實講，不可以硬生一份', () => {
    const i = chat.indexOf('async function offerInference')
    const block = chat.slice(i, i + 3500)
    expect(block).toContain('res.filled?.length')
    expect(block).toContain('直接問你幾題')
  })

  it('已經認識的帳號不再猜一次', () => {
    const i = chat.indexOf('async function offerInference')
    const block = chat.slice(i, i + 1200)
    expect(block).toContain('if (r.ready) return null')
  })
})

describe('就緒度', () => {
  it('⛔「認識你的店」不算必要項，也不進「要不要把人拉回精靈」的判斷', () => {
    // 踩到會怎樣：它是可以跳過的。算進去的話，跳過的人每次進後台都被拉回精靈一次。
    const i = setupStatus.indexOf('const onboardingIncomplete')
    const block = setupStatus.slice(i, i + 400)
    expect(block).not.toContain('profileReady')
  })

  it('小幫手的「下一步」不會指到可跳過的步驟', () => {
    const tutorialAgent = readFileSync(`${APP_DIR}components/TutorialAgent.vue`, 'utf8')
    expect(tutorialAgent).toContain('!st.done && !st.optional')
  })
})
