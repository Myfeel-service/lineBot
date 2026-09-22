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
import { ONBOARDING_PROGRESS_LABELS, ONBOARDING_STEP } from '~/composables/useOnboardingChat'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const chat = readFileSync(`${APP_DIR}composables/useOnboardingChat.ts`, 'utf8')
const landing = readFileSync(`${APP_DIR}pages/index.vue`, 'utf8')
const setupStatus = readFileSync(`${APP_DIR}composables/useSetupStatus.ts`, 'utf8')

describe('進度條', () => {
  it('六格，而且「認識你的店」排在「取得連線資訊」之前', () => {
    // 踩到會怎樣：順序反過來就變成「先叫人去 LINE 拿金鑰、卡住的人才被問五題」——
    // 而那正是這一版要修掉的事（卡在金鑰的人原本空手離開）。
    expect(ONBOARDING_PROGRESS_LABELS).toHaveLength(6)
    expect(ONBOARDING_PROGRESS_LABELS.indexOf('認識你的店'))
      .toBeLessThan(ONBOARDING_PROGRESS_LABELS.indexOf('取得連線資訊'))
  })

  it('索引常數跟標籤對得起來', () => {
    // 踩到會怎樣：`ONBOARDING_STEP` 是為了不要在劇本裡散落 magic number 才存在的，
    // 它自己跟標籤飄掉的話，進度條會停在錯的格子而畫面完全正常。
    expect(ONBOARDING_PROGRESS_LABELS[ONBOARDING_STEP.create]).toBe('建立帳號')
    expect(ONBOARDING_PROGRESS_LABELS[ONBOARDING_STEP.profile]).toBe('認識你的店')
    expect(ONBOARDING_PROGRESS_LABELS[ONBOARDING_STEP.credentials]).toBe('取得連線資訊')
    expect(ONBOARDING_PROGRESS_LABELS[ONBOARDING_STEP.receive]).toBe('接收 LINE 訊息')
    expect(ONBOARDING_PROGRESS_LABELS[ONBOARDING_STEP.testMessage]).toBe('傳訊息測試')
    expect(ONBOARDING_PROGRESS_LABELS[ONBOARDING_STEP.done]).toBe('完成')
  })

  it('⛔ 劇本裡不可以再出現寫死的 progress 數字', () => {
    // 踩到會怎樣：加一格就要全檔重數一次，而漏掉的那一處不會報錯、只會停在錯的格子。
    const hardcoded = chat.match(/progress\.value\s*=\s*\d/g) ?? []
    expect(hardcoded, `這幾處要改用 ONBOARDING_STEP：${hardcoded.join('、')}`).toEqual([])
  })

  it('官網示範那份抄過去的標籤要跟這邊一字不差', () => {
    // 踩到會怎樣：官網演五格、產品是六格。抄字不 import 是刻意的（免得把整支
    // composable 拖進官網 bundle），代價就是要有人守著它們一致。
    const m = landing.match(/const OB_PROGRESS_LABELS = \[([^\]]+)\]/)
    expect(m, '官網那份 OB_PROGRESS_LABELS 不見了').toBeTruthy()
    const copied = m![1]!.split(',').map(s => s.trim().replace(/^'|'$/g, ''))
    expect(copied).toEqual([...ONBOARDING_PROGRESS_LABELS])
  })
})

describe('五題問答', () => {
  it('放在「建立帳號」之後、「已經有 LINE 官方帳號了嗎」之前', () => {
    // 踩到會怎樣：擺到接線之後，就回到「卡在金鑰的人什麼都沒留下」的舊世界。
    const create = chat.indexOf('await stepCreate()')
    const profile = chat.indexOf('await stepStoreProfile()')
    const hasOA = chat.indexOf('await stepHasOA()')
    expect(create).toBeGreaterThan(-1)
    expect(profile).toBeGreaterThan(create)
    expect(hasOA).toBeGreaterThan(profile)
  })

  it('⛔ 選項不可以有 primary（這幾題沒有「建議答案」）', () => {
    // 踩到會怎樣：把某個選項染成主要動作＝暗示那是對的，收上來的輪廓會往那邊偏。
    const i = chat.indexOf('async function stepStoreProfile')
    const j = chat.indexOf('async function stepConnectGate')
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    const block = chat.slice(i, j)
    expect(block).toContain('def.options.map(o => ({ label: o, value: o }))')
  })

  it('五題答完先存，再去讀網站', () => {
    // 踩到會怎樣：讀網站失敗時，他剛答的五題會跟著陪葬——而那五題才是最貴的東西
    //（AI 猜得到網站上的事，猜不到「你現在最想解決什麼」）。
    const i = chat.indexOf('async function stepStoreProfile')
    const block = chat.slice(i, chat.indexOf('async function stepConnectGate'))
    const save = block.indexOf("apiFetch('/api/store-profile'")
    const read = block.indexOf('/api/store-profile/read-site')
    expect(save).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(save)
  })

  it('沒有網站的人跳得掉', () => {
    const i = chat.indexOf('async function stepStoreProfile')
    const block = chat.slice(i, chat.indexOf('async function stepConnectGate'))
    // skipLabel 沒配 skippable 不會長出那顆鈕——兩個都要在
    expect(block).toContain('skippable: true')
    expect(block).toContain('沒有網站')
  })
})

describe('接不接 LINE 的閘門', () => {
  it('主要動作是接 LINE，不是開放式問句', () => {
    const i = chat.indexOf('async function stepConnectGate')
    const block = chat.slice(i, chat.indexOf('async function revealStoreProfile'))
    expect(block).toContain("value: 'go', primary: true")
    expect(block, '次要出口要在').toContain("value: 'later'")
  })

  it('⛔「先進後台」一定要講後果', () => {
    // 踩到會怎樣：沒接 LINE 的後台是空殼。把它講成一條同等的路，人會以為自己已經好了。
    const i = chat.indexOf('async function stepConnectGate')
    const block = chat.slice(i, chat.indexOf('async function revealStoreProfile'))
    expect(block).toContain('客人傳訊息我收不到')
    expect(block, '要講得出怎麼回來').toContain('取得連線資訊')
  })
})

describe('揭曉', () => {
  it('擺在成績單之前', () => {
    // 踩到會怎樣：成績單是這一段的句點，句點後面再加內容，人已經在找離開的按鈕了。
    const reveal = chat.indexOf('await revealStoreProfile()')
    const summary = chat.indexOf("kind: 'summary'")
    expect(reveal).toBeGreaterThan(-1)
    expect(summary).toBeGreaterThan(reveal)
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
