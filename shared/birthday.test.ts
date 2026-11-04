import { describe, expect, it } from 'vitest'
import {
  BIRTHDAY_ASK_NOTE,
  BIRTHDAY_BUTTON_LABEL,
  BIRTHDAY_BUTTON_TYPE,
  BIRTHDAY_GIFT_MAX,
  BIRTHDAY_POSTBACK_DATA,
  birthdayAskText,
  birthdayConfirmText,
  birthdayGreetingText,
  birthdayKeysForDay,
  birthdayPickerAction,
  buildBirthdayAskMessage,
  buildBirthdayModuleMessages,
  normalizeBirthdaySettings,
  parseBirthdayDate,
  taipeiMonth,
} from './birthday'

describe('parseBirthdayDate（⛔ 年份丟掉、只存月日）', () => {
  it('LINE 給的 YYYY-MM-DD → 月、日', () => {
    expect(parseBirthdayDate('1990-03-12')).toEqual({ month: 3, day: 12 })
    expect(parseBirthdayDate('2000-02-29')).toEqual({ month: 2, day: 29 })
  })
  it('格式不對、不是真的日子 → null', () => {
    expect(parseBirthdayDate('')).toBeNull()
    expect(parseBirthdayDate(undefined)).toBeNull()
    expect(parseBirthdayDate('1990-3-12')).toBeNull()
    expect(parseBirthdayDate('2001-02-29')).toBeNull()
    expect(parseBirthdayDate('1990-13-01')).toBeNull()
    expect(parseBirthdayDate('1990-03-12T10:00')).toBeNull()
  })
})

describe('設定', () => {
  it('預設關、禮物空', () => {
    expect(normalizeBirthdaySettings(undefined)).toEqual({ enabled: false, gift: '' })
    expect(normalizeBirthdaySettings({ enabled: 'true' })).toEqual({ enabled: false, gift: '' })
  })
  it('禮物去換行、修頭尾空白、超過上限截掉', () => {
    expect(normalizeBirthdaySettings({ enabled: true, gift: '  來店\n招待一杯飲料 ' })).toEqual({ enabled: true, gift: '來店 招待一杯飲料' })
    expect([...normalizeBirthdaySettings({ gift: '送'.repeat(50) }).gift]).toHaveLength(BIRTHDAY_GIFT_MAX)
  })
})

describe('對客人說的話', () => {
  it('⛔ 沒寫禮物就不提禮物', () => {
    expect(birthdayAskText('')).toBe('告訴我們你的生日 🎂')
    expect(birthdayAskText('')).not.toMatch(/送|招待|禮/)
    expect(birthdayConfirmText(3, 12, '', false)).toBe('收到，你的生日是 3 月 12 日 🎂')
  })
  it('寫了禮物：卡片與回覆都接在「生日當月」後面', () => {
    expect(birthdayAskText('來店招待一杯飲料')).toBe('告訴我們你的生日，生日當月來店招待一杯飲料！')
    expect(birthdayConfirmText(3, 12, '來店招待一杯飲料', false)).toBe('收到，你的生日是 3 月 12 日 🎂\n生日當月來店招待一杯飲料，到時候見！')
  })
  it('改過生日講「改成」', () => {
    expect(birthdayConfirmText(7, 1, '', true)).toBe('好，生日改成 7 月 1 日了 🎂')
  })
})

describe('那張卡', () => {
  it('Flex＋LINE 內建選日期（只選日期、不預設今天、上限今天）', () => {
    const m = buildBirthdayAskMessage('來店招待一杯飲料', '2026-11-04') as any
    expect(m.type).toBe('flex')
    expect(m.altText).toBe('告訴我們你的生日，生日當月來店招待一杯飲料！')
    const action = m.contents.footer.contents[0].action
    expect(action).toMatchObject({ type: 'datetimepicker', data: BIRTHDAY_POSTBACK_DATA, mode: 'date', initial: '2000-01-01', max: '2026-11-04' })
    expect([...action.label].length).toBeLessThanOrEqual(20)
    expect(JSON.stringify(m).length).toBeLessThan(30_000)
  })
})

describe('模組的「問生日」按鈕（`C-57` 甲）', () => {
  it('選日期動作跟加好友那張卡同一個 postback；沒寫字用預設、超過 20 字截掉', () => {
    expect(birthdayPickerAction('', '2026-11-04')).toMatchObject({ type: 'datetimepicker', label: BIRTHDAY_BUTTON_LABEL, data: BIRTHDAY_POSTBACK_DATA, mode: 'date', max: '2026-11-04' })
    expect([...(birthdayPickerAction('留下你的生日'.repeat(5), '2026-11-04').label as string)]).toHaveLength(20)
  })
  it('一鍵建的模組：一則文字＋一顆「問生日」按鈕；⛔ 沒寫禮物不提禮物', () => {
    const [m] = buildBirthdayModuleMessages('') as any[]
    expect(m).toEqual({ type: 'text', text: `告訴我們你的生日 🎂\n${BIRTHDAY_ASK_NOTE}`, buttons: [{ type: BIRTHDAY_BUTTON_TYPE, label: BIRTHDAY_BUTTON_LABEL }] })
    expect((buildBirthdayModuleMessages('來店招待一杯飲料')[0] as any).text).toContain('生日當月來店招待一杯飲料')
  })
})

describe('早上報告（`D-170`）', () => {
  it('哪幾種生日算今天：平年 2/28 連 2/29 的一起祝，閏年不用', () => {
    expect(birthdayKeysForDay('2026-11-05')).toEqual([{ month: 11, day: 5 }])
    expect(birthdayKeysForDay('2027-02-28')).toEqual([{ month: 2, day: 28 }, { month: 2, day: 29 }])
    expect(birthdayKeysForDay('2028-02-28')).toEqual([{ month: 2, day: 28 }])
    expect(birthdayKeysForDay('2028-02-29')).toEqual([{ month: 2, day: 29 }])
    expect(birthdayKeysForDay('2100-02-28')).toHaveLength(2) // 2100 不是閏年
    expect(birthdayKeysForDay('bad')).toEqual([])
  })
  it('生日祝福：一人一則換名字；⛔ 沒寫禮物不提禮物、⛔ 不替店家編領取方式', () => {
    expect(birthdayGreetingText('')).toMatch(/^\{\{displayName\}\}，生日快樂 🎂\n/)
    expect(birthdayGreetingText('')).not.toMatch(/送|招待|禮|領/)
    expect(birthdayGreetingText('來店招待一杯飲料')).toBe('{{displayName}}，生日快樂 🎂\n生日當月來店招待一杯飲料。')
  })
})

describe('taipeiMonth', () => {
  it('照台北時間算（UTC 10/31 17:00＝台北 11/1 01:00）', () => {
    expect(taipeiMonth(new Date('2026-10-31T17:00:00Z'))).toBe(11)
    expect(taipeiMonth(new Date('2026-10-31T15:00:00Z'))).toBe(10)
  })
})
