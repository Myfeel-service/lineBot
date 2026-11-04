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
