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
  it('存生日、記一行客人動作、回一句；禮物只在功能開著時講', () => {
    const fn = between(handler, 'async function handleBirthdayPostback', '\n}\n')
    expect(fn).toContain('saveCustomerBirthday(')
    expect(fn).toContain("actionType: 'birthday_set'")
    expect(fn).toContain('settings?.birthday?.enabled ? settings.birthday.gift')
    expect(fn).toContain('birthdayConfirmText(')
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
  it('一次回覆最多 5 則：放不下就不附（⛔ 不切店家自己的訊息）', () => {
    expect(handler.match(/\.length \+ append\.length <= 5/g)?.length).toBe(2)
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
  it('好友頁「生日」：建「問生日」模組（讀不到清單⛔ 不給建立鈕，免得建出第二個）', () => {
    expect(dialog).toContain('buildBirthdayModuleMessages(form.gift)')
    expect(dialog).toContain("'/api/flow/create'")
    expect(dialog).toContain("can('marketing.write')")
    expect(dialog.indexOf('v-else-if="moduleLoadError"')).toBeLessThan(dialog.indexOf('v-else-if="canCreateModule"'))
  })
})

describe('早上報告的生日（`D-170`）', () => {
  const cronSrc = read('server/utils/cron-maintenance.ts')
  const broadcasts = read('app/pages/admin/[workspaceId]/broadcasts.vue')
  const listGet = read('server/api/broadcast/list.get.ts')
  const links = read('server/utils/notify-links.ts')
  it('摘要排程一起查生日、查不到要講、塞進 buildDigestLines', () => {
    const fn = between(cronSrc, 'export async function dailyBacklogDigest', '\n}\n')
    expect(fn).toContain('loadBirthdayDigest(db, ws, coverDays, today)')
    expect(fn).toContain("unknownNotes.push('生日的部分')")
    expect(fn).toContain('birthday: {')
  })
  it('今天有壽星才查方案、才產連結；連結帶日期（⛔ 不靠 sessionStorage：從 LINE 點開是新的瀏覽器）', () => {
    const fn = between(cronSrc, 'export async function dailyBacklogDigest', '\n}\n')
    expect(fn).toMatch(/const birthdayLink = birthdayToday && birthdayCanSend/)
    expect(fn).toContain('birthdayBroadcastPath(ws, today)')
    expect(links).toContain('/broadcasts?from=birthday&day=')
  })
  it('推播頁接 ?from=birthday：自己撈那天的壽星、寫好祝福、⛔ 不存檔（markClean）', () => {
    const fn = between(broadcasts, 'async function applyBirthdayHandoff', '\n}\n')
    expect(fn).toContain("query: { part: 'birthday', day }")
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
