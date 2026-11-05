/**
 * 客人生日（`C-57`）的接線守門：這幾條都長在 handler.ts 的大函式裡，拆不出純函式，照原始碼釘住。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TUTORIAL_TOPICS } from '~/utils/tutorial-topics'
import { AGENT_TEACHINGS } from '~~/shared/agent-teachings'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8')
const handler = read('server/utils/handler.ts')
const users = read('app/pages/admin/[workspaceId]/users.vue')
const dialog = read('app/components/admin/AdminBirthdayDialog.vue')
const settingsGet = read('server/api/ai/settings.get.ts')
const cron = read('server/api/cron/run-tasks.post.ts')

const between = (src: string, a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)))

describe('收到「告訴我生日」選的日期', () => {
  it('⚠️ 在「真人處理中靜音」判斷之前處理（按鈕的收據，不回他會一直按）', () => {
    const post = between(handler, 'export async function handlePostbackEvent', 'if (messageTrigger.text)')
    const i = post.indexOf('data === BIRTHDAY_POSTBACK_DATA')
    expect(i).toBeGreaterThan(-1)
    expect(i).toBeLessThan(post.indexOf('shouldSuppressInboundBotAutomationForSession'))
  })
  it('存生日、記一行客人動作、回一句；禮物有寫就講（code review 第 7 條：不看「加好友時問生日」開沒開）', () => {
    const fn = between(handler, 'async function handleBirthdayPostback', '\n}\n')
    expect(fn).toContain('saveCustomerBirthday(')
    expect(fn).toContain("actionType: 'birthday_set'")
    expect(fn).toContain("const gift = settings?.birthday?.gift ?? ''")
    expect(fn).not.toContain('settings?.birthday?.enabled ? settings.birthday.gift')
    expect(fn).toContain('birthdayConfirmText(')
  })
  it('code review 第 10 條：存失敗＝當場回一句請他再選（重送會被當重複略過）', () => {
    const fn = between(handler, 'async function handleBirthdayPostback', '\n}\n')
    const tryAt = fn.indexOf('try {')
    expect(tryAt).toBeGreaterThan(-1)
    expect(tryAt).toBeLessThan(fn.indexOf('saveCustomerBirthday('))
    expect(fn).toContain('BIRTHDAY_SAVE_FAILED_TEXT')
  })
})

describe('加好友時附「告訴我生日」卡', () => {
  it('⛔ 已經留過生日的不再問；沒開功能不附', () => {
    const fn = between(handler, 'async function followBirthdayCard', '\n}\n')
    expect(fn.indexOf('birthdayMonth) return []')).toBeGreaterThan(-1)
    expect(fn).toContain('if (!settings?.birthday?.enabled) return []')
  })
  it('文字、模組兩條路都附；沒有歡迎訊息／模組被刪就自己送；冷卻中跟著不送', () => {
    const fn = between(handler, 'async function runFollowWelcomeScript', '\n}\n')
    expect(fn).toContain('appendMessages: birthdayCard')
    expect(fn).toMatch(/result\.quickReplies, result\.link, birthdayCard\)/)
    expect(fn).toContain('if (!sent && birthdayCard.length) await replyBirthdayCardAlone(')
    const noScript = between(fn, 'if (!matched) {', 'return\n')
    expect(noScript).toContain('replyBirthdayCardAlone(')
    // 冷卻的 return 在任何送出之前
    expect(fn.indexOf('on cooldown → skip')).toBeLessThan(fn.indexOf('appendMessages: birthdayCard'))
  })
  it('附不附照同一支規則（最後一則有快速回覆不附、滿 5 則不附；規則與測試在 shared/line-reply-append）', () => {
    expect(handler.match(/appendBlockedReason\(/g)?.length).toBe(2)
  })
  it('code review 第 6 條：從活動連結加好友的人也問（活動那則是 push，replyToken 還沒用掉）', () => {
    const fn = between(handler, 'export async function handleFollowEvent', '\n}\n')
    const branch = fn.slice(fn.indexOf('claimOutcome.pushed) {'))
    expect(branch).toContain('followBirthdayCard(wid, userData)')
    expect(branch).toContain('replyBirthdayCardAlone(')
  })
})

describe('機器人模組的「問生日」按鈕（`C-57` 甲）', () => {
  const flow = read('app/pages/admin/[workspaceId]/flow.vue')
  const editor = read('app/components/flow/FlowActionEditor.vue')
  it('送出端：按鈕組法認得「問生日」，組成選日期', () => {
    const fn = between(handler, 'function buildFlexCarouselButtonAction', '\n}\n')
    expect(fn).toContain('if (type === BIRTHDAY_BUTTON_TYPE)')
    expect(fn).toContain('birthdayPickerAction(')
  })
  it('⛔ 只有文字＋按鈕、卡片訊息的按鈕給這個選項（其他幾種組法沒接，給了按下去沒反應）', () => {
    expect(flow.match(/:type-options="buttonActionTypeOptions"/g)?.length).toBe(2)
    const textBtn = between(flow, 'v-for="(btn, bIdx) in msg.buttons"', '</FlowActionEditor>')
    expect(textBtn).toContain('buttonActionTypeOptions')
    const quick = between(flow, "v-else-if=\"msg.type === 'quickReply'\"", "v-else-if=\"msg.type === 'userInput'\"")
    expect(quick).not.toContain('buttonActionTypeOptions')
  })
  it('編輯器：選了「問生日」講清楚按了會怎樣，沒寫字先填預設', () => {
    expect(editor).toContain('action.type === BIRTHDAY_BUTTON_TYPE')
    expect(editor).toContain('props.action.label = BIRTHDAY_BUTTON_LABEL')
  })
  it('好友頁「生日」：建「問生日」模組（讀不到清單、還在讀⛔ 不給建立鈕，免得建出第二個）', () => {
    expect(dialog).toContain("'/api/flow/create'")
    expect(dialog).toContain("can('marketing.write')")
    expect(dialog.indexOf('v-else-if="moduleLoadError"')).toBeLessThan(dialog.indexOf('v-else-if="canCreateModule"'))
    // code review 第 9 條：清單還沒讀回來那一瞬間不給建立鈕
    expect(dialog.indexOf('v-if="moduleLoading"')).toBeLessThan(dialog.indexOf('v-else-if="canCreateModule"'))
  })
  it('code review 第 7 條：建模組前先存，模組那句話寫的是存好的生日禮（⛔ 不用框裡還沒存的字）', () => {
    const fn = between(dialog, 'async function createModule', '\n}\n')
    expect(fn).toContain('await persist()')
    expect(fn).toContain('buildBirthdayModuleMessages(saved.value.gift)')
    expect(fn).not.toContain('buildBirthdayModuleMessages(form.gift)')
  })
})

describe('早上報告的生日（`D-170`）', () => {
  const cronSrc = read('server/utils/cron-maintenance.ts')
  const broadcasts = read('app/pages/admin/[workspaceId]/broadcasts.vue')
  const listGet = read('server/api/broadcast/list.get.ts')
  const links = read('server/utils/notify-links.ts')
  it('摘要排程一起查生日、查不到要講、塞進 buildDigestLines', () => {
    const fn = between(cronSrc, 'export async function dailyBacklogDigest', '\n}\n')
    expect(fn).toContain("unknownNotes.push('生日的部分')")
    expect(fn).toContain('birthday: {')
  })
  it('今天有壽星才查方案、才產連結；連結帶日期（⛔ 不靠 sessionStorage：從 LINE 點開是新的瀏覽器）', () => {
    const fn = between(cronSrc, 'export async function dailyBacklogDigest', '\n}\n')
    expect(fn).toMatch(/const birthdayLink = birthdayToday && birthdayCanSend/)
    expect(fn).toContain('birthdayBroadcastPath(ws, today, birthdaySince)')
    expect(links).toContain('/broadcasts?from=birthday&day=')
  })
  it('code review 第 2 條：能不能發照推播頁同一支規則（匯入名單）——入門方案也不給連結', () => {
    const fn = between(cronSrc, 'export async function dailyBacklogDigest', '\n}\n')
    expect(fn).toContain("broadcastEntryLockText(t, 'import')")
    const page = between(broadcasts, 'async function applyBirthdayHandoff', '\n}\n')
    expect(page).toContain("broadcastPlanBlockReason(planBroadcastTier.value, 'import')")
    expect(page.indexOf('if (lock)')).toBeLessThan(page.indexOf('openCreate()'))
    // 🔴 `C-466`（2026-11-05 實走）：方案是「清單載完」那個 watch 裡 ⛔ 沒被等的 loadDraftTotal 問的——
    //    只檢查上面那行字是假綠燈：走到這裡方案一定還是 null，那道檢查從來沒擋過。要先問到方案再判斷。
    expect(page).toContain('await loadDraftTotal()')
    expect(page.indexOf('await loadDraftTotal()')).toBeLessThan(page.indexOf("broadcastPlanBlockReason(planBroadcastTier.value, 'import')"))
  })
  it('code review 第 4 條：壽星講「上一則報告之後到今天」，推播頁也帶那幾天', () => {
    const fn = between(cronSrc, 'export async function dailyBacklogDigest', '\n}\n')
    expect(fn).toContain('const birthdayDays = [...coverDays.slice(1), today]')
    expect(fn).toContain('loadBirthdayDigest(db, ws, coverDays, birthdayDays)')
    expect(listGet).toContain('birthdayDayRange(since, day)')
    expect(between(broadcasts, 'async function applyBirthdayHandoff', '\n}\n')).toContain("query: { part: 'birthday', day, since }")
  })
  it('推播頁接 ?from=birthday：自己撈那天的壽星、寫好祝福、⛔ 不存檔（markClean）', () => {
    const fn = between(broadcasts, 'async function applyBirthdayHandoff', '\n}\n')
    expect(fn).toContain("form.value.audienceType = 'import'")
    expect(fn).toContain('birthdayGreetingText(')
    expect(fn).toContain('markClean()')
    expect(fn).not.toMatch(/create\.post|\/api\/broadcast\/create|sendNow|method: 'POST'/)
    expect(broadcasts).toContain('await applyBirthdayHandoff()')
    expect(listGet).toContain("query.part === 'birthday'")
  })
})

describe('後台', () => {
  it('好友頁有「生日」、框裡的字吃 shared/birthday（跟送出端同一份）', () => {
    expect(users).toContain('data-tour="usr-birthday"')
    expect(users).toContain('<AdminBirthdayDialog v-model="birthdayVisible" />')
    expect(dialog).toContain('birthdayAskText(form.gift)')
    expect(dialog).toContain('birthdayConfirmText(')
    // 改設定的權限＝存檔那支端點的權限
    expect(dialog).toContain("can('ai.settings.write')")
  })
  it('數字借 GET /api/ai/settings?part=birthday（⛔ 不多開路由：TS2589）', () => {
    expect(settingsGet).toContain("getQuery(event).part === 'birthday'")
    expect(dialog).toContain("query: { part: 'birthday' }")
  })
  it('每月貼標掛在排程上', () => {
    expect(cron).toContain("{ name: 'crm:birthday-tag', run: () => syncBirthdayMonthTag(db) }")
  })
  it('教學與「問小幫手」都叫得出來，⛔ 不鎖角色', () => {
    const topic = TUTORIAL_TOPICS.find(t => t.id === 'birthday')
    expect(topic?.steps.map(s => s.target)).toEqual(['[data-tour="usr-birthday"]'])
    expect(topic?.requires).toBeUndefined()
    expect(users).toContain("'birthday'")
    expect(Object.values(AGENT_TEACHINGS).some(t => t.ref === 'birthday')).toBe(true)
  })
})

/**
 * `C-468`（示意頁 v87／v88，老闆 2026-11-05「好 執行」）：問生日只發生在加好友那一刻，
 * 所以在「還沒有任何客人加好友」的時候讓他一鍵打開——①接完 LINE 成績單之前問一句 ②做邀請卡時生日還沒開就多一行。
 * ⛔ 兩支導覽都不加步（導覽只能指、不能做）。
 */
describe('開帳之後帶到生日（`C-468`）', () => {
  const chat = read('app/composables/useOnboardingChat.ts')
  const invite = read('app/components/admin/AdminInviteCardDialog.vue')
  const renderer = read('app/components/agent/AgentMessageRenderer.vue')
  const landing = read('app/utils/onboarding-landing.ts')
  const ask = between(chat, 'async function stepBirthdayAsk', '\n  async function stepDone')
  const done = between(chat, 'async function stepDone', '\n  // ── 打造這一趟的結尾')

  it('接完 LINE：成績單之前問、只問一次（回去做傳話測試會再跑 stepDone）', () => {
    expect(done.indexOf('await stepBirthdayAsk()')).toBeGreaterThan(-1)
    expect(done.indexOf('await stepBirthdayAsk()')).toBeLessThan(done.indexOf("kind: 'summary'"))
    expect(ask).toContain('if (birthdayAsked) return birthdayOn')
  })
  it('已經開著、讀不到設定都不問（⛔ 不問一件不知道現況的事）', () => {
    expect(ask.indexOf("apiFetch<{ birthday?: Partial<BirthdaySettings> }>('/api/ai/settings')")).toBeLessThan(ask.indexOf('await say('))
    expect(ask.indexOf('if (current.enabled)')).toBeLessThan(ask.indexOf('await say('))
  })
  it('卡上的字吃 shared/birthday（跟送出端、好友頁「生日」框同一份）；⛔ 不自動打開：要他按', () => {
    expect(ask).toContain("kind: 'birthday-card'")
    expect(ask).toContain('title: birthdayAskText(current.gift)')
    expect(ask).toContain('note: BIRTHDAY_ASK_NOTE')
    expect(ask).toContain('button: BIRTHDAY_BUTTON_LABEL')
    expect(ask.indexOf("method: 'PUT'")).toBeGreaterThan(ask.indexOf("if (c !== 'yes')"))
    expect(renderer).toContain("entry.msg.kind === 'birthday-card'")
  })
  it('打開時生日禮照原本的帶著；沒存成要講、成績單也不列', () => {
    expect(ask).toContain('normalizeBirthdaySettings({ ...current, enabled: true })')
    expect(ask).toContain('這次沒打開成功')
    expect(done).toContain("...(bdOn ? [{ label: '客人加好友時會被問生日', done: true }] : [])")
  })
  it('⛔ 不承諾發生日祝福（新店家是免費方案、發不了推播）', () => {
    const says = [...ask.matchAll(/await say\(([\s\S]*?)\)\n/g)].map(m => m[1]).join('\n')
    // 先確認真的抓到那幾句（⛔ 抓到空字串＝下面那條永遠綠）
    expect(says).toContain('要不要順便問生日')
    expect(says).toContain('打開了 ✓')
    expect(says).not.toMatch(/祝福|推播/)
  })
  it('⛔ 兩支導覽都不加生日那一步', () => {
    expect(landing).not.toMatch(/生日|usr-birthday/)
  })
  it('邀請卡框：生日還沒打開、而且接上 LINE 了才多一行；能改設定的人才看得到', () => {
    expect(invite).toContain('data-invite="birthday"')
    expect(invite).toContain("if (!can('ai.settings.write')) return")
    expect(invite).toMatch(/showBirthdayRow = computed\(\(\) => !!invite\.value\?\.basicId\s*&& \(bdJustOn\.value \|\| \(bdCurrent\.value !== null && !bdCurrent\.value\.enabled\)\)\)/)
  })
  it('邀請卡框：每次開框都重看（⛔ 不跟著「畫過就不重抓」）；鈕 ⛔ 不用主色（框的主要動作是列印）', () => {
    const w = between(invite, 'watch(visible', '}, { immediate: true })')
    expect(w).toContain('void loadBirthday()')
    expect(between(invite, 'async function load()', '\n}\n')).not.toContain('loadBirthday')
    expect(invite).toMatch(/<el-button size="small" :loading="bdSaving" @click="turnOnBirthday">打開<\/el-button>/)
    expect(invite).toContain('normalizeBirthdaySettings({ ...bdCurrent.value, enabled: true })')
  })
})
