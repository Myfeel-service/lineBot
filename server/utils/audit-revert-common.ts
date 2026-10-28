/**
 * 「還原這一筆」每一種動作都共用的型別與判斷（2026-10-28 `D-156` 拆出來）。
 *
 * 為什麼要拆：還原從兩種動作（AI 設定、流程上下架）長到十幾種，每一種的護欄都不一樣
 * （權限不能改自己、排程快送出了、知識在回收桶裡…），全塞在 `audit-revert.ts` 會變成一支
 * 沒有人看得完的大 switch。這裡只放「每一種都要守」的那幾條。
 */
import type { Firestore } from 'firebase-admin/firestore'
import type { Capability } from '~~/shared/permissions'

/** 一筆稽核紀錄裡，還原用得到的部分 */
export interface AuditRecordForRevert {
  id: string
  action: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  targetId?: string
  /**
   * 這筆紀錄存的時候有東西被遮罩／截斷／砍掉（`writeAuditLog` 標的）。
   * ⛔ 有這個旗標就不准還原：寫回去會把 60 個敏感詞變成 50 個、把長字串變成
   *    「…(截斷,原 N 字)」，而畫面還會跟人說「已經改回原本的值」。
   */
  lossy?: boolean
}

export type RevertPlan =
  | { ok: true, capability: Capability, what: string }
  | { ok: false, reason: string }

export interface RevertCtx {
  db: Firestore
  workspaceId: string
  uid: string
  /** 成員權限那種要用：擁有者只有組織管理員／超管動得了、超管可以改自己（`G-96`／`G-101`） */
  isSuperAdmin?: boolean
  isOrgAdmin?: boolean
}

/**
 * 檢查做到多深（2026-10-28 `D-156`）。為什麼要分：拿 MYFEEL 真資料預演，新增類 118 個還原鈕裡
 * 大半按下去會被擋（模組建好後又改過、標籤已經貼了人、推播早就送出了）——
 * 畫面給了按鈕、按下去卻說不行，比沒有按鈕更糟。
 * - `list`：清單每一列都要算，只做便宜的（讀那一份、看狀態、數幾個），沒過就不給按鈕
 * - `confirm`：按下「還原」那一刻，貴的也做（掃「誰在用它」，60 秒內掃過的可以直接用）
 * - `apply`：按了「確定還原」、真的要動手之前，全部重查一次（不用掃過的結果）
 */
export type RevertStage = 'list' | 'confirm' | 'apply'

/** 還原做完之後要記進「還原了這一筆」那筆紀錄的東西 */
export interface RevertOutcome {
  /** 給人看的一句結果（畫面直接當提示顯示） */
  message: string
  /** 還原之前／之後（＝原紀錄的「改之後」／「改之前」） */
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

/** 檢查過了、真的動手的那一步 */
export type RevertCommit = () => Promise<RevertOutcome>

export interface RevertHandler {
  /** 這筆能不能還原（只看紀錄本身，不讀資料庫——清單每一列都要算一次） */
  plan: (row: AuditRecordForRevert) => RevertPlan
  /**
   * 現在還能不能還原：只讀，現況不對（被改過、被用到了）一律 throw，訊息是給人看的。
   * 過了就回傳「動手」那一步。
   * ⛔ 寫入只能放在回傳的那個函式裡：清單預查和按下去的預演只跑這一段、從不呼叫回傳的函式。
   *    10-28 第一版是同一支函式靠 18 處「預演就停」各自擋（code review `C-412`）——
   *    漏一處＝只是打開操作紀錄頁就真的還原，而且沒有確認框、沒有紀錄。
   * ⛔ 要在交易裡改的那幾種，回傳的函式自己在交易裡**再驗一次**（檢查跟動手之間可能隔了一次掃描）。
   */
  check: (row: AuditRecordForRevert, ctx: RevertCtx, stage: RevertStage) => Promise<RevertCommit>
}

/**
 * 現值是否仍與紀錄裡的「改之後」相符。
 * ⛔ 子物件只比**紀錄裡有寫到的那幾格**：稽核存的是「這次動到的部分」
 *   （例如只有 handoffNotify.slaRemindMinutes），拿它跟完整設定整包比一定不相等，
 *   結果會變成「永遠說被改過、永遠不能還原」。
 */
export function matchesRecorded(current: unknown, recorded: unknown): boolean {
  if (recorded && typeof recorded === 'object' && !Array.isArray(recorded)) {
    if (!current || typeof current !== 'object') return false
    return Object.entries(recorded as Record<string, unknown>)
      .every(([k, v]) => matchesRecorded((current as Record<string, unknown>)[k], v))
  }
  return JSON.stringify(current ?? null) === JSON.stringify(recorded ?? null)
}

/**
 * 「改之前」跟「改之後」一模一樣＝紀錄沒記到改了哪一格。
 * ⛔ 這種給了還原鈕，按下去什麼都沒變卻說「已經改回去了」——例：知識只解了鎖
 *   （紀錄裡狀態、期限前後相同，真正動到的鎖沒記），還原了鎖也回不來。
 */
export function recordsNoChange(row: AuditRecordForRevert): boolean {
  return JSON.stringify(row.before ?? {}) === JSON.stringify(row.after ?? {})
}

/** 紀錄的「改之前」只動到這幾格嗎（白名單：沒想過的欄位一律不寫回去） */
export function onlyKeys(rec: Record<string, unknown> | null | undefined, allowed: readonly string[]): boolean {
  const keys = Object.keys(rec ?? {})
  return keys.length > 0 && keys.every(k => allowed.includes(k))
}

/** 這段期間又被改過 → 不動手（拿舊判斷覆蓋新世界＝安靜地蓋掉別人的修改） */
export function changedSinceError(where: string): Error {
  return createError({
    statusCode: 409,
    statusMessage: `這段期間${where}又被改過了，所以我沒有還原（避免蓋掉別人後來的修改）。請直接到那一頁確認現在的狀態。`,
  })
}

/** 要還原的那份東西已經不在了（或是別的官方帳號的——跟不存在長得一樣，不證實它存在） */
export function goneError(what: string): Error {
  return createError({ statusCode: 404, statusMessage: `${what}已經不在了，沒有東西可以還原。` })
}
