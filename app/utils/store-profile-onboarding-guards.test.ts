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
    // ⚠️ **要限定在 `stepDone` 裡面找**：草稿那一段自己也有一張 summary 卡，
    //    用全檔 `indexOf` 會抓到它而永遠是紅的（第一版就是這樣，當場改掉）。
    const i = chat.indexOf('async function stepDone')
    expect(i).toBeGreaterThan(-1)
    const block = chat.slice(i, chat.indexOf('// ── 入口', i))
    const reveal = block.indexOf('await revealStoreProfile()')
    const summary = block.indexOf("kind: 'summary'")
    expect(reveal, 'stepDone 裡沒有揭曉').toBeGreaterThan(-1)
    expect(summary, 'stepDone 裡沒有成績單').toBeGreaterThan(-1)
    expect(summary).toBeGreaterThan(reveal)
  })

  it('草稿接在揭曉後面（先讓他看認識的內容，再給從它長出來的東西）', () => {
    const i = chat.indexOf('async function stepDone')
    const block = chat.slice(i, chat.indexOf('// ── 入口', i))
    expect(block.indexOf('stepStoreDrafts')).toBeGreaterThan(block.indexOf('await revealStoreProfile()'))
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
    expect(block).toContain('knowledgeHandoffUrl')
    expect(block, '不可以在這裡就把卡片建進知識庫').not.toContain('bulk-create')
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
