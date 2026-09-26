/**
 * LINE 通知文案（`C-270`）。這支同時被送出端與「設定 → LINE 通知」的手機預覽呼叫，
 * 所以這裡守的是「讀的人看到什麼」：第一則幾點到算對、模式講對、有連結才放連結。
 */
import { describe, expect, it } from 'vitest'
import {
  buildCriticalAlertText,
  buildHandoffNotifyText,
  buildNotifyConfirmText,
  buildOverdueBatchText,
  digestTimeLabel,
  nextDigestPhrase,
  notifyWhatYouGetLines,
} from './line-notify-messages'

/** 台北時間 → epoch ms（台灣沒有夏令時間，固定 +8） */
const taipei = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)
const OFF = { enabled: false, start: '09:00', end: '18:00', weekendOff: false }
const WEEKEND_OFF = { enabled: true, start: '09:00', end: '18:00', weekendOff: true }
const cfg = (over: Partial<Parameters<typeof notifyWhatYouGetLines>[0]> = {}) => ({
  mode: 'always' as const, slaRemindMinutes: 30, digestHour: 10, criticalAlertPush: true, ...over,
})

describe('digestTimeLabel', () => {
  it('中午以前加「早上」，之後只講時間（⛔ 不寫「早上 14:00」）', () => {
    expect(digestTimeLabel(9)).toBe('早上 09:00')
    expect(digestTimeLabel(14)).toBe('14:00')
  })
})

describe('nextDigestPhrase：第一則摘要什麼時候到', () => {
  it('今天還沒到那個整點 → 今天', () => {
    expect(nextDigestPhrase(taipei(2026, 9, 28, 8), 10, OFF)).toBe('今天早上 10:00')
  })
  it('今天已經過了 → 明天（跟排程「過了整點那一輪才發」同一套）', () => {
    expect(nextDigestPhrase(taipei(2026, 9, 28, 10, 30), 10, OFF)).toBe('明天早上 10:00')
  })
  it('週末休息的帳號：週五下午綁的 → 週一（⛔ 不可以講「明天」）', () => {
    expect(nextDigestPhrase(taipei(2026, 10, 2, 15), 10, WEEKEND_OFF)).toBe('週一早上 10:00')
  })
  it('服務時間沒開，週末照發', () => {
    expect(nextDigestPhrase(taipei(2026, 10, 2, 15), 10, OFF)).toBe('明天早上 10:00')
  })
})

describe('notifyWhatYouGetLines：這支手機之後會收到什麼', () => {
  it('「每次都通知」講馬上；「只通知沒人接手的」講等幾分鐘', () => {
    expect(notifyWhatYouGetLines(cfg(), OFF)[0]).toBe('・客人要找真人時（馬上）')
    expect(notifyWhatYouGetLines(cfg({ mode: 'missed_only', slaRemindMinutes: 60 }), OFF)[0])
      .toBe('・客人要找真人、等超過 60 分鐘沒人接手時')
  })
  it('週末休息才講「週末不傳」；出大事關掉就不列', () => {
    expect(notifyWhatYouGetLines(cfg(), WEEKEND_OFF)).toContain('・每天早上 10:00 的摘要（週末不傳）')
    expect(notifyWhatYouGetLines(cfg(), OFF)).toContain('・每天早上 10:00 的摘要')
    expect(notifyWhatYouGetLines(cfg({ criticalAlertPush: false }), OFF)).not.toContain('・出大事的時候')
  })
})

describe('buildNotifyConfirmText：綁好之後回給手機的那一則', () => {
  const now = taipei(2026, 9, 28, 15)
  it('加進來了：列出會收到什麼＋第一則幾點', () => {
    const t = buildNotifyConfirmText({ result: 'added', cfg: cfg({ mode: 'missed_only', slaRemindMinutes: 60 }), serviceHours: OFF, nowMs: now })
    expect(t.startsWith('好了 ✓ 這支手機之後會收到：')).toBe(true)
    expect(t).toContain('等超過 60 分鐘沒人接手時')
    expect(t).toContain('明天早上 10:00 會收到第一則。')
  })
  it('有設服務時間 → 補一句下班時段不吵（⛔ 不承諾半夜也會傳）', () => {
    const t = buildNotifyConfirmText({ result: 'added', cfg: cfg(), serviceHours: WEEKEND_OFF, nowMs: now })
    expect(t).toContain('下班時段不吵你')
  })
  it('🔴 名單滿了 → 照實講沒加進去，⛔ 不列「會收到什麼」', () => {
    const t = buildNotifyConfirmText({ result: 'full', cfg: cfg(), serviceHours: OFF, nowMs: now })
    expect(t).toContain('名單已經滿了')
    expect(t).not.toContain('之後會收到')
  })
  it('讀不到他的 LINE 資料 → 附加好友連結，⛔ 但不講死「你還沒加好友」', () => {
    const t = buildNotifyConfirmText({
      result: 'added', cfg: cfg(), serviceHours: OFF, nowMs: now, friendUnknown: true, addFriendUrl: 'https://line.me/R/ti/p/%40demo',
    })
    expect(t).toContain('如果還沒加這個官方帳號好友')
    expect(t).toContain('https://line.me/R/ti/p/%40demo')
  })
})

describe('找真人／沒人接手／出大事：有連結才放連結', () => {
  const base = { customerName: '阿明', customerMessage: '我訂的禮盒可以改寄公司嗎', reasonLabel: '客人要求真人', summary: '想改寄公司' }
  it('有連結 → 「👉 打開這段對話」＋下一行網址；沒有 → 退回講去哪（⛔ 不放相對路徑）', () => {
    const withLink = buildHandoffNotifyText({ ...base, link: 'https://x.test/c/Ab3dE7x' })
    expect(withLink.split('\n').slice(-2)).toEqual(['👉 打開這段對話', 'https://x.test/c/Ab3dE7x'])
    const noLink = buildHandoffNotifyText(base)
    expect(noLink.split('\n').at(-1)).toBe('請至後台「對話」頁回覆。')
    expect(noLink).not.toContain('/c/')
  })
  it('「只通知沒人接手的」那一則：標題講等多久、內容完整', () => {
    const t = buildHandoffNotifyText({ ...base, slaReminderMinutes: 60 })
    expect(t.split('\n')[0]).toBe('🙋 真人客服請求（已等超過 60 分鐘沒人接手）')
    expect(t).toContain('📋 摘要：想改寄公司')
  })
  it('再提醒（沒有內容）是一行短版', () => {
    const t = buildHandoffNotifyText({ customerName: '阿明', customerMessage: '', reasonLabel: '', slaReminderMinutes: 30, link: 'https://x.test/c/Ab3dE7x' })
    expect(t).toBe('⏰ 提醒：阿明還在等真人（超過 30 分鐘）\n👉 https://x.test/c/Ab3dE7x')
  })
  it('多位一起等：連結開到清單', () => {
    const t = buildOverdueBatchText({ slaReminderMinutes: 30, total: 2, items: [{ customerName: '甲', waitedMs: 3_600_000, reasonLabel: '' }], rest: 1, link: 'https://x.test/c/Zz9yX8w' })
    expect(t).toContain('👉 打開後台「對話」')
    expect(t).toContain('・另有 1 位客人在等')
  })
  it('出大事：清單在前、連結在最後', () => {
    const t = buildCriticalAlertText({ count: 1, lines: ['・機器人收不到客人訊息'], more: 0, link: 'https://x.test/c/Qq1wE2r' })
    expect(t.split('\n')[0]).toBe('🔴 有 1 件事正在影響客人')
    expect(t.split('\n').at(-1)).toBe('👉 https://x.test/c/Qq1wE2r')
  })
})
