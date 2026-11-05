import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ConfigRef } from './config-references'
import { INACTIVE_TAG_CODE_SHARED, tagHowApplied } from './tag-how-applied'

/** `C-463`（`D-171` 示意頁 v2 下面那張表）：標籤管理頁每一顆旁邊「怎麼貼上去」 */
const ON = { aiReading: true, birthdayOn: true }
const ref = (kind: ConfigRef['kind'], label: string, extra: Partial<ConfigRef> = {}): ConfigRef => ({ kind, id: label, label, ...extra })
const texts = (...a: Parameters<typeof tagHowApplied>) => tagHowApplied(...a).map(l => l.text)

describe('tagHowApplied（怎麼貼上去）', () => {
  it('示意頁那五種', () => {
    expect(texts({ aiMode: 'suggest' }, [], ON)).toEqual(['客人聊到就提醒你貼'])
    expect(texts({ code: 'sys_inactive' }, [], ON)).toEqual(['系統每天自己貼，客人回來就自己摘掉'])
    expect(texts({ code: 'sys_birthday_month' }, [], ON)).toEqual(['系統每個月 1 號自己換'])
    expect(texts({}, [ref('richmenu', '菜單')], ON)).toEqual(['客人按圖文選單「菜單」就貼'])
    expect(tagHowApplied({}, [], ON)).toEqual([{ text: '要你在「好友」頁自己貼', tone: 'manual' }])
  })
  it('AI 直接貼；開關關著要講（⛔ 不知道＝null 不講）', () => {
    expect(texts({ aiMode: 'auto' }, [], ON)).toEqual(['客人聊到就直接貼上'])
    expect(texts({ aiMode: 'suggest' }, [], { aiReading: false, birthdayOn: true })).toEqual(['客人聊到就提醒你貼（「AI 讀對話」關著，現在不會）'])
    expect(texts({ aiMode: 'suggest' }, [], { aiReading: null, birthdayOn: true })).toEqual(['客人聊到就提醒你貼'])
    expect(texts({ code: 'sys_birthday_month' }, [], { aiReading: true, birthdayOn: false })).toEqual(['系統每個月 1 號自己換（要先在「好友」頁打開「生日」）'])
    expect(texts({ code: 'sys_birthday_month' }, [], { aiReading: true, birthdayOn: null })).toEqual(['系統每個月 1 號自己換'])
  })
  it('⛔ 推播是拿它挑人、不是貼上去——只有推播用到的＝還是要你自己貼', () => {
    expect(tagHowApplied({}, [ref('broadcast', '雙 11 檔期')], ON)[0]!.tone).toBe('manual')
  })
  it('⛔ 關掉的自動回應／活動帶不了客人進來，不算', () => {
    expect(tagHowApplied({}, [ref('campaign', '舊活動', { closed: true })], ON)[0]!.tone).toBe('manual')
    // 停用的模組按鈕已經送到客人聊天室、按了還是會貼（同 refStillReaches），照算
    expect(texts({}, [ref('flow', '問生日', { inactive: true })], ON)).toEqual(['客人按模組「問生日」的按鈕就貼'])
  })
  it('一處點名、多處講幾處；幾種貼法都列', () => {
    expect(texts({ aiMode: 'suggest' }, [ref('richmenu', '菜單'), ref('richmenu', '主選單'), ref('campaign', '開幕')], ON)).toEqual([
      '客人聊到就提醒你貼',
      '客人按圖文選單就貼（2 處）',
      '客人從活動「開幕」加好友就貼',
    ])
    expect(texts({}, [ref('script', '退換貨'), ref('supportPreset', '已出貨')], ON)).toEqual([
      '自動回應「退換貨」走到就貼',
      '客服送出預存回覆「已出貨」時貼',
    ])
  })
  it('「N 天沒互動」的代號跟伺服器那支同一個（⛔ 兩邊各寫一份會改一邊漏一邊）', () => {
    const server = readFileSync(fileURLToPath(new URL('../server/utils/inactive-tag.ts', import.meta.url)), 'utf8')
    expect(server).toContain(`export const INACTIVE_TAG_CODE = '${INACTIVE_TAG_CODE_SHARED}'`)
  })
})
