/**
 * 店家自己的檔期（`D-122`②）：名稱＋日期怎麼驗、資料庫拿到髒東西怎麼洗、過完多久不留。
 */
import { describe, expect, it } from 'vitest'
import {
  MARKETING_EVENT_KEEP_DAYS,
  MARKETING_EVENT_NAME_MAX,
  eventDeleteConfirmText,
  eventList,
  isEventDateDisabled,
  isOwnEventId,
  isValidDateKey,
  normalizeEventMap,
  ownEventFestival,
  pruneEventMap,
  validateEventInput,
} from './marketing-events'
import { addDays } from './time'
import { TAIWAN_FESTIVALS } from './taiwan-festivals'

const TODAY = '2026-10-19'
const ID = 'own-1f0c2b7a-9d1e-4c55-8a0b-2f3e4d5c6b7a'

describe('驗名稱＋日期（前後端同一支）', () => {
  it('正常的：名稱去頭尾空白、連續空白收成一個', () => {
    expect(validateEventInput({ name: '  週年慶   早鳥 ', date: '2026-10-24' }, TODAY))
      .toEqual({ ok: true, name: '週年慶 早鳥', date: '2026-10-24' })
  })

  it('名稱空的、太長的擋下來，講得出原因', () => {
    expect(validateEventInput({ name: '   ', date: '2026-10-24' }, TODAY)).toEqual({ ok: false, message: '請填檔期名稱' })
    const long = '週'.repeat(MARKETING_EVENT_NAME_MAX + 1)
    expect(validateEventInput({ name: long, date: '2026-10-24' }, TODAY).ok).toBe(false)
    expect(validateEventInput({ name: '週'.repeat(MARKETING_EVENT_NAME_MAX), date: '2026-10-24' }, TODAY).ok).toBe(true)
  })

  it('⛔ 過去的日子不收（過完的只在回顧裡出現，改不到也刪不到）', () => {
    const r = validateEventInput({ name: '週年慶', date: '2026-10-18' }, TODAY)
    expect(r).toEqual({ ok: false, message: '日期已經過了，只能加今天以後的檔期' })
    expect(validateEventInput({ name: '週年慶', date: TODAY }, TODAY).ok).toBe(true)
  })

  it('⛔ 90 天以外不收（卡片只看未來 90 天，加了會看不到）', () => {
    expect(validateEventInput({ name: '週年慶', date: addDays(TODAY, 90) }, TODAY).ok).toBe(true)
    const r = validateEventInput({ name: '週年慶', date: addDays(TODAY, 91) }, TODAY)
    expect(r.ok).toBe(false)
    expect(isEventDateDisabled(addDays(TODAY, 91), TODAY)).toBe(true)
    expect(isEventDateDisabled(addDays(TODAY, -1), TODAY)).toBe(true)
    expect(isEventDateDisabled(TODAY, TODAY)).toBe(false)
  })

  it('不存在的日子（2/30）、格式不對的都擋', () => {
    expect(isValidDateKey('2027-02-30')).toBe(false)
    expect(isValidDateKey('2026/10/24')).toBe(false)
    expect(validateEventInput({ name: '週年慶', date: '' }, TODAY)).toEqual({ ok: false, message: '請選日期' })
  })
})

describe('id', () => {
  it('own- 開頭才算；節日表的 id 一個都不會被當成自己的', () => {
    expect(isOwnEventId(ID)).toBe(true)
    expect(isOwnEventId('midautumn-2026')).toBe(false)
    expect(isOwnEventId('own-a.b')).toBe(false) // ⛔ 含「.」會被 Firestore 當成巢狀欄位
    expect(TAIWAN_FESTIVALS.filter(f => isOwnEventId(f.id))).toEqual([])
  })
})

describe('資料庫拿到的東西洗乾淨', () => {
  it('壞掉的丟掉、好的留著，⛔ 不讓一筆髒資料炸掉整張卡', () => {
    const map = normalizeEventMap({
      [ID]: { name: '週年慶', date: '2026-10-24', createdAt: 1 },
      'own-bad-date-000': { name: '壞日期', date: '2026-13-01', createdAt: 1 },
      'midautumn-2026': { name: '不是自己的 id', date: '2026-10-24', createdAt: 1 },
      'own-no-name-000': { name: '', date: '2026-10-24', createdAt: 1 },
    })
    expect(Object.keys(map)).toEqual([ID])
    expect(normalizeEventMap(null)).toEqual({})
    expect(normalizeEventMap([1, 2])).toEqual({})
  })

  it('清單照日期排', () => {
    const list = eventList({
      'own-bbbbbbbb': { name: '後', date: '2026-11-20', createdAt: 1 },
      'own-aaaaaaaa': { name: '前', date: '2026-10-24', createdAt: 2 },
    })
    expect(list.map(e => e.name)).toEqual(['前', '後'])
  })

  it('過完很久的才拿掉：回顧還看得到的那段要留著', () => {
    const map = {
      'own-keepkeep': { name: '回顧期內', date: addDays(TODAY, -MARKETING_EVENT_KEEP_DAYS), createdAt: 1 },
      'own-dropdrop': { name: '太久了', date: addDays(TODAY, -MARKETING_EVENT_KEEP_DAYS - 1), createdAt: 1 },
    }
    expect(Object.keys(pruneEventMap(map, TODAY))).toEqual(['own-keepkeep'])
  })
})

describe('轉成節日的形狀', () => {
  it('沒有通用切角、帶 own 記號（月曆、提醒、回顧、擬文案都認這個）', () => {
    expect(ownEventFestival({ id: ID, name: '週年慶', date: '2026-10-24' }))
      .toEqual({ id: ID, date: '2026-10-24', name: '週年慶', angle: '', own: true })
  })
})

describe('刪除前問的那一句', () => {
  it('⛔ 一定講推播不會跟著刪', () => {
    expect(eventDeleteConfirmText('週年慶')).toContain('推播不會跟著刪')
  })
})
