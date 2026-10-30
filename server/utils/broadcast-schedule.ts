import type { Timestamp } from 'firebase-admin/firestore'
import { BROADCAST_SCHEDULE_MIN_LEAD_MS } from '~~/shared/broadcast-schedule-time'

export { BROADCAST_SCHEDULE_MIN_LEAD_MS }

/** 無時區字串視為 Asia/Taipei 牆上時間（與後台 date-picker 一致） */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000

const NAIVE_LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

function parseNaiveDateTimeAsTaipei(value: string): Date | null {
  const m = NAIVE_LOCAL_DATETIME_RE.exec(value.trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6] ?? '0')
  if ([year, month, day, hour, minute, second].some((n) => Number.isNaN(n))) return null
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - TAIPEI_OFFSET_MS
  const d = new Date(utcMs)
  return Number.isNaN(d.getTime()) ? null : d
}

function hasExplicitTimezone(value: string): boolean {
  return /[zZ]$/.test(value) || /[+-]\d{2}:?\d{2}$/.test(value)
}

export type BroadcastScheduleParseResult =
  | { ok: true; date: Date }
  | { ok: false; reason: 'empty' | 'invalid' | 'past' }

export function broadcastScheduleAtToDate(value: unknown): Date | null {
  if (value == null) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  const ts = value as Timestamp
  if (typeof ts.toDate === 'function') {
    const d = ts.toDate()
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof value === 'string') {
    const s = value.trim()
    if (NAIVE_LOCAL_DATETIME_RE.test(s) && !hasExplicitTimezone(s)) {
      return parseNaiveDateTimeAsTaipei(s)
    }
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d
}

export function parseBroadcastScheduleAtInput(value: unknown): BroadcastScheduleParseResult {
  if (value === null || value === undefined || value === '') {
    return { ok: false, reason: 'empty' }
  }
  const d = broadcastScheduleAtToDate(value)
  if (!d) return { ok: false, reason: 'invalid' }
  if (d.getTime() <= Date.now() + BROADCAST_SCHEDULE_MIN_LEAD_MS) {
    return { ok: false, reason: 'past' }
  }
  return { ok: true, date: d }
}

export function broadcastScheduleErrorMessage(reason: 'empty' | 'invalid' | 'past'): string {
  if (reason === 'empty') return '請選擇排程時間'
  if (reason === 'invalid') return '排程時間格式不正確'
  return '排程時間須至少一分鐘後'
}

/**
 * `D-167`②：草稿記住的預計時間（還沒排上）。空的＝不記，格式壞掉就擋。
 * ⛔ 不要求是未來：只是記著，排上那一步（`assertFutureBroadcastScheduleAt`）才擋過去的時間。
 */
export function parsePlannedBroadcastScheduleAt(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = broadcastScheduleAtToDate(value)
  if (!d) throw createError({ statusCode: 400, statusMessage: broadcastScheduleErrorMessage('invalid') })
  return d
}

export function assertFutureBroadcastScheduleAt(value: unknown): Date {
  const parsed = parseBroadcastScheduleAtInput(value)
  if (!parsed.ok) {
    throw createError({
      statusCode: 400,
      statusMessage: broadcastScheduleErrorMessage(parsed.reason),
    })
  }
  return parsed.date
}
