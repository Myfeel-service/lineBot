/**
 * 傳到成員手機上的 LINE 通知**文案**（`D-103`／`C-270`，2026-09-27）。
 *
 * 為什麼放 shared：後台「設定 → LINE 通知」右邊那支手機要畫出「你會收到這樣的訊息」。
 * ⛔ 預覽跟送出端各寫一份，遲早對不上（推播預覽 `D-96` 踩過：預覽畫的卡一個字都沒送出去）——
 *    所以送出端（`server/utils/ai-handoff-notify.ts`、綁定成功的回覆）與預覽**呼叫同一支函式**。
 *
 * 規矩（改文案前先讀）：
 * - 有連結就放「👉 …」＋下一行網址；**沒有連結**（本機、`PUBLIC_BASE_URL` 沒設）才退回
 *   「請至後台『對話』頁回覆。」——⛔ 不放相對路徑，那在 LINE 裡點不開。
 * - 連結一律是短網址（`/c/xxxx`，見 `server/routes/c/[code].get.ts`），在 LINE 裡點會轉去手機的
 *   Safari／Chrome：後台是 Google 登入，LINE 內建瀏覽器登不進去。
 */
import { isServiceDayOff, type ServiceHoursLike } from './time'

/** 「什麼時候通知」那幾格（跟 `AiSettingsDoc['handoffNotify']` 同名，只取文案要用的） */
export interface NotifyTimingLike {
  mode: 'always' | 'missed_only'
  slaRemindMinutes: number
  digestHour: number
  criticalAlertPush: boolean
}

export type NotifyServiceHoursLike = ServiceHoursLike

const TAIPEI_OFFSET_MS = 8 * 3600_000
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

function hh(hour: number): string {
  const h = Math.max(0, Math.min(23, Math.round(hour)))
  return `${h < 10 ? '0' : ''}${h}:00`
}

/** 摘要時間的講法：中午以前加「早上」（「每天早上 10:00」），之後只講時間（⛔ 不寫「早上 14:00」） */
export function digestTimeLabel(hour: number): string {
  return hour < 12 ? `早上 ${hh(hour)}` : hh(hour)
}

/**
 * 下一則摘要什麼時候到：「今天早上 10:00」「明天早上 10:00」「週一早上 10:00」。
 * 跟排程同一套規則：過了設定的整點那一輪才發、休假日（服務時間開著＋週六日休息）整天不發。
 */
export function nextDigestPhrase(nowMs: number, digestHour: number, serviceHours: NotifyServiceHoursLike | null | undefined): string {
  const taipeiHour = new Date(nowMs + TAIPEI_OFFSET_MS).getUTCHours()
  const label = digestTimeLabel(digestHour)
  // 今天還沒到那個整點＝今天就會發（前提是今天不是休假日）
  let offset = taipeiHour < digestHour ? 0 : 1
  for (let i = 0; i < 7; i++) {
    const day = new Date(nowMs + offset * 86_400_000)
    if (!isServiceDayOff(serviceHours, day)) break
    offset++
  }
  if (offset === 0) return `今天${label}`
  if (offset === 1) return `明天${label}`
  const dow = new Date(nowMs + offset * 86_400_000 + TAIPEI_OFFSET_MS).getUTCDay()
  return `週${WEEKDAY[dow]}${label}`
}

/**
 * 「這支手機之後會收到什麼」——綁定成功的回覆與後台的「好了」都講這幾行。
 * ⚠️ 跟真的會發生的事同一套：「只通知沒人接手的」模式下，當下不傳、等 N 分鐘沒人接才傳。
 */
export function notifyWhatYouGetLines(cfg: NotifyTimingLike, serviceHours: NotifyServiceHoursLike | null | undefined): string[] {
  const lines = [cfg.mode === 'missed_only'
    ? `・客人要找真人、等超過 ${cfg.slaRemindMinutes} 分鐘沒人接手時`
    : '・客人要找真人時（馬上）']
  const weekend = serviceHours?.enabled && serviceHours.weekendOff ? '（週末不傳）' : ''
  lines.push(`・每天${digestTimeLabel(cfg.digestHour)} 的摘要${weekend}`)
  if (cfg.criticalAlertPush) lines.push('・出大事的時候')
  return lines
}

export type NotifyConfirmResult = 'added' | 'already' | 'full' | 'failed'

/**
 * 綁定成功之後回給那支手機的那一則（用 reply 送，不花官方帳號的訊息額度）。
 * - `friendUnknown`：讀不到他的 LINE 個人資料。LINE 只給已加好友的人的資料，所以
 *   **可能**還不是好友（也可能只是一時讀不到）——⛔ 不確定就不講死，附加好友連結請他確認。
 */
export function buildNotifyConfirmText(input: {
  result: NotifyConfirmResult
  cfg: NotifyTimingLike
  serviceHours: NotifyServiceHoursLike | null | undefined
  nowMs: number
  friendUnknown?: boolean
  addFriendUrl?: string
}): string {
  const out: string[] = []
  if (input.result === 'full') {
    out.push('綁好了，但通知名單已經滿了（最多 10 位），這支手機這次沒有加進去。')
    out.push('請管理員到後台「設定 → LINE 通知」關掉一位，再加一次。')
  }
  else if (input.result === 'failed') {
    out.push('綁好了，但加進通知名單時出了錯。')
    out.push('請到後台「設定 → LINE 通知」再按一次「把我的手機加進來」。')
  }
  else {
    out.push('好了 ✓ 這支手機之後會收到：')
    out.push(...notifyWhatYouGetLines(input.cfg, input.serviceHours))
    if (input.serviceHours?.enabled) out.push('（下班時段不吵你，上班後再傳）')
    out.push('', `${nextDigestPhrase(input.nowMs, input.cfg.digestHour, input.serviceHours)} 會收到第一則。`)
  }
  if (input.friendUnknown && input.addFriendUrl) {
    out.push('', `⚠️ 如果還沒加這個官方帳號好友，請先加好友，不然收不到通知：\n${input.addFriendUrl}`)
  }
  return out.join('\n')
}

/** 有連結放「👉 …＋網址」，沒有就退回一句「去哪」（⛔ 不放相對路徑） */
function tail(link: string | undefined, label: string, fallback: string): string[] {
  return link ? [`👉 ${label}`, link] : [fallback]
}

const REPLY_FALLBACK = '請至後台「對話」頁回覆。'

export interface HandoffNotifyTextInput {
  customerName: string
  customerMessage: string
  /** 已翻成白話的原因（例「客人要求真人」） */
  reasonLabel: string
  summary?: string
  /** 有值＝「等了 N 分鐘沒人接手」那種（「只通知沒人接手的」模式的唯一一則，或「每次都通知」的再提醒） */
  slaReminderMinutes?: number
  /** 打開這位客人的對話的短網址 */
  link?: string
}

/**
 * 找真人／沒人接手的那一則。
 * - 有摘要或客人原話 → 完整版（客服看完就能接手）
 * - 再提醒且沒有內容（「每次都通知」模式第一則已經講過了）→ 短版一行
 */
export function buildHandoffNotifyText(p: HandoffNotifyTextInput): string {
  const summary = String(p.summary ?? '').trim()
  const message = String(p.customerMessage ?? '').trim().slice(0, 200)
  const hasContext = Boolean(summary || message)
  if (p.slaReminderMinutes && !hasContext) {
    return [
      `⏰ 提醒：${p.customerName}還在等真人（超過 ${p.slaReminderMinutes} 分鐘）`,
      ...(p.link ? [`👉 ${p.link}`] : [REPLY_FALLBACK]),
    ].join('\n')
  }
  return [
    p.slaReminderMinutes ? `🙋 真人客服請求（已等超過 ${p.slaReminderMinutes} 分鐘沒人接手）` : '🙋 真人客服請求',
    `客人：${p.customerName}`,
    ...(summary ? [`📋 摘要：${summary}`] : []),
    ...(message ? [`訊息：${message}`] : []),
    `原因：${p.reasonLabel}`,
    ...tail(p.link, '打開這段對話', REPLY_FALLBACK),
  ].join('\n')
}

/** 「等 N 分鐘」的白話寫法：一小時內講分鐘，超過講小時（不寫「1.8 小時」這種要換算的數字） */
export function waitedText(waitedMs: number): string {
  const minutes = Math.max(1, Math.round(waitedMs / 60_000))
  if (minutes < 60) return `等 ${minutes} 分鐘`
  return `等 ${Math.max(1, Math.round(minutes / 60))} 小時`
}

/** 多位客人同時逾時 → 一則清單（見 `notifyOverdueHandoffBatch`） */
export function buildOverdueBatchText(p: {
  slaReminderMinutes: number
  total: number
  items: { customerName: string, waitedMs: number, reasonLabel: string }[]
  rest: number
  link?: string
}): string {
  return [
    `🙋 ${p.total} 位客人在等真人客服（都已超過 ${p.slaReminderMinutes} 分鐘沒人接手）`,
    ...p.items.map(i => `・${i.customerName} — ${waitedText(i.waitedMs)}${i.reasonLabel ? `・${i.reasonLabel}` : ''}`),
    ...(p.rest > 0 ? [`・另有 ${p.rest} 位客人在等（完整名單請看後台）`] : []),
    ...tail(p.link, '打開後台「對話」', REPLY_FALLBACK),
  ].join('\n')
}

/** 出大事那一則（`pushCriticalAlerts`）：前面的清單由呼叫端組好 */
export function buildCriticalAlertText(p: { count: number, lines: string[], more: number, link?: string }): string {
  return [
    p.count === 1 ? '🔴 有 1 件事正在影響客人' : `🔴 有 ${p.count} 件事正在影響客人`,
    ...p.lines,
    ...(p.more > 0 ? [`・還有 ${p.more} 件，請到後台看`] : []),
    '請開後台，右下角的小幫手會告訴你每一件要怎麼處理。',
    ...(p.link ? [`👉 ${p.link}`] : []),
  ].join('\n')
}
