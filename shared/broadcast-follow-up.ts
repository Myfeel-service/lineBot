/**
 * 推播「補發給沒打開的人／發給點了連結的人／發給沒點連結的人」（`D-154`②③，2026-10-28 老闆拍板）。
 *
 * ── LINE 給什麼、不給什麼（2026-10-28 查證，記憶 reference_line_open_tracking_limits）────
 * - LINE 不給「哪位客人打開了」。但可以請它把某一則推播「看過的人」「點過連結的人」圈成一份名單，
 *   再拿去發——名單裡是誰我們看不到（`getAudienceData` 只回人數）。
 * - 只有用 narrowcast（先上傳名單再發給名單）送的推播 LINE 才肯圈；一般群發、一人一則送都不行。
 * - 圈出來的名單至少要 50 人才能用；發完 60 天內才能圈。
 * - 所以這三種對象一律是「LINE 幫你挑人、大家收到同一份內容」：⛔ 不能放客人名字、
 *   ⛔ 不能放「點了就貼標」的按鈕（那兩樣要一人一則送，見 broadcast-send.ts）。
 *
 * ── 老闆拍板 ──────────────────────────────────────────────────────────
 * ②③ 二選一時選「LINE 圈名單」（不是「自己記誰點了」）：看得到人數、看不到名字、不能貼標。
 * 用了客人名字的推播＝一人一則送＝不能補發，報表上照實講原因（不出現按鈕）。
 */
import type { BroadcastFollowUpTarget } from './types/tag-broadcast'

const DAY = 86_400_000

export const FOLLOW_UP_TARGETS: BroadcastFollowUpTarget[] = ['unopened', 'clicked', 'unclicked']

/** LINE 圈出的「看過／點過的人」名單最少要這麼多人才能用 */
export const FOLLOW_UP_MIN_AUDIENCE = 50
/**
 * 少於這麼多人的推播照舊用一般群發：它不可能圈得出 50 位看過的人，改用 narrowcast 只會
 * 多等一兩分鐘（名單要先準備好）、多一份名單佔 LINE 的名額，什麼都換不到。
 */
export const NARROWCAST_MIN_RECIPIENTS = FOLLOW_UP_MIN_AUDIENCE
/** 發完幾天內才能請 LINE 圈名單 */
export const FOLLOW_UP_MAX_AGE_DAYS = 60

/** 「沒打開的人」這種對象名稱（畫面、草稿名字都用這一份） */
export const FOLLOW_UP_LABEL: Record<BroadcastFollowUpTarget, string> = {
  unopened: '沒打開的人',
  clicked: '點了連結的人',
  unclicked: '沒點連結的人',
}

/** 按鈕上的字 */
export const FOLLOW_UP_BUTTON: Record<BroadcastFollowUpTarget, string> = {
  unopened: '補發給沒打開的人',
  clicked: '發給點了連結的人',
  unclicked: '發給沒點連結的人',
}

/** 補發的那一則放了一人一則才做得到的東西 */
export const FOLLOW_UP_PERSONALIZED_ERROR
  = '這一則是 LINE 幫你挑人、大家收到同一份內容，沒辦法放客人名字或「點了就貼標」的按鈕。請把它們拿掉再發。'

export function isFollowUpTarget(v: unknown): v is BroadcastFollowUpTarget {
  return typeof v === 'string' && (FOLLOW_UP_TARGETS as string[]).includes(v)
}

export interface FollowUpSourceInfo {
  status: string
  sendMode?: string | null
  /** 這一則自己就是補發的 */
  isFollowUp: boolean
  lineRequestId?: string | null
  uploadAudienceGroupId?: number | null
  /** 本來要用 narrowcast、改用一般方式送的原因 */
  narrowcastFallback?: string | null
  completedMs: number | null
  sentCount: number
  /** LINE 打開的人數（人數少於 20 時 LINE 不給＝null） */
  opened: number | null
  /** LINE 點連結的人數 */
  clicked: number | null
  nowMs: number
}

export interface FollowUpOption {
  target: BroadcastFollowUpTarget
  button: string
  /** 大約幾位（沒打開／沒點的是相減出來的，所以是「約」） */
  estimate: number
  approx: boolean
}

export interface FollowUpAvailability {
  options: FollowUpOption[]
  /** 一個都不能發時講原因；只少了「點了／沒點」那兩種時也講一句。都能發＝null */
  reason: string | null
}

/**
 * 成效報表上能出現哪幾顆「再發一則」、不能時講什麼。
 * ⛔ 報表與建草稿的端點用**同一支**：畫面說能發、按下去卻被擋，就是兩邊各判一份的下場。
 */
export function followUpAvailability(s: FollowUpSourceInfo): FollowUpAvailability {
  const none = (reason: string | null): FollowUpAvailability => ({ options: [], reason })
  if (s.status !== 'completed' || !(s.sentCount > 0)) return none(null)
  if (s.isFollowUp) return none('這則是補發的那一則，不能再從它補發；要再發一次，請回到原本那一則。')
  if (s.sendMode === 'perRecipient') {
    return none('這則放了客人名字（或「點了就貼標」的按鈕），是一人一則送的，LINE 不提供看過的人名單，所以不能補發。下次想補發，內容就別放這兩樣。')
  }
  if (s.sendMode !== 'narrowcast' || !s.lineRequestId || !s.uploadAudienceGroupId) {
    if (s.narrowcastFallback) return none(`這則用一般方式送出（${s.narrowcastFallback}），LINE 沒辦法圈出看過的人，所以不能補發。`)
    return none('這則是用以前的方式送出的，LINE 沒辦法圈出看過的人；之後新發、沒放客人名字的推播就可以補發。')
  }
  if (s.completedMs == null || s.nowMs - s.completedMs > FOLLOW_UP_MAX_AGE_DAYS * DAY) {
    return none(`發完超過 ${FOLLOW_UP_MAX_AGE_DAYS} 天，LINE 不再提供看過的人名單，所以不能補發。`)
  }

  const options: FollowUpOption[] = []
  const opened = s.opened
  const clicked = s.clicked
  if (opened != null && opened >= FOLLOW_UP_MIN_AUDIENCE && s.sentCount - opened > 0) {
    options.push({ target: 'unopened', button: FOLLOW_UP_BUTTON.unopened, estimate: s.sentCount - opened, approx: true })
  }
  const clicksUsable = clicked != null && clicked >= FOLLOW_UP_MIN_AUDIENCE
  if (clicksUsable) {
    options.push({ target: 'clicked', button: FOLLOW_UP_BUTTON.clicked, estimate: clicked!, approx: false })
    if (s.sentCount - clicked! > 0) {
      options.push({ target: 'unclicked', button: FOLLOW_UP_BUTTON.unclicked, estimate: s.sentCount - clicked!, approx: true })
    }
  }

  if (!options.length) {
    // LINE 算打開的人數要時間：剛發完通常還沒有數字，⛔ 不要講成「不到 50 位」
    if (opened == null && s.nowMs - s.completedMs < DAY) return none('發完隔天就能補發：LINE 要先算出誰打開了。')
    return none(`看過的人不到 ${FOLLOW_UP_MIN_AUDIENCE} 位，LINE 不提供名單，所以不能補發。`)
  }
  const reason = clicksUsable ? null : `點連結的人不到 ${FOLLOW_UP_MIN_AUDIENCE} 位，LINE 不提供名單，所以沒辦法分「點了／沒點」。`
  return { options, reason }
}

/**
 * 補發送出前：原本那一則還能不能拿來補發（不能＝回一句原因；能＝null）。
 * 送出端（broadcast-narrowcast.ts）與驗證視窗（validate.post.ts）共用。
 */
export function followUpSourceProblem(
  src: {
    workspaceId?: string
    sendMode?: string | null
    lineRequestId?: string | null
    uploadAudienceGroupId?: number | null
    completedMs: number | null
  } | null,
  workspaceId: string,
  nowMs: number,
): string | null {
  if (!src || src.workspaceId !== workspaceId) return '原本那則推播已經不在了'
  if (src.sendMode !== 'narrowcast' || !src.lineRequestId || !(Number(src.uploadAudienceGroupId) > 0)) {
    return '原本那則不是用可以補發的方式送的'
  }
  if (src.completedMs == null || nowMs - src.completedMs > FOLLOW_UP_MAX_AGE_DAYS * DAY) {
    return `原本那則發完超過 ${FOLLOW_UP_MAX_AGE_DAYS} 天，LINE 不再提供名單`
  }
  return null
}

/**
 * 一般推播（不是補發）要不要用 narrowcast 送。不用時回一句原因（存在推播上，報表講「為什麼不能補發」）。
 * 一人一則送的（放了名字／點了就貼標）不走這裡判：那種原因報表另外講。
 */
export function planNarrowcastSend(input: {
  /** 系統總開關關掉了（正式站出事時的退路） */
  disabled: boolean
  recipientCount: number
  completionTagCount: number
}): { use: true; fallback: null } | { use: false; fallback: string } {
  if (input.disabled) return { use: false, fallback: '系統暫時改用一般方式送' }
  // 發完貼記號要「只貼給送成功的人」：narrowcast 只回人數、不回是誰沒收到（`C-213`）
  if (input.completionTagCount > 0) return { use: false, fallback: '有設定「發完貼記號」，要知道每一位有沒有收到' }
  if (input.recipientCount < NARROWCAST_MIN_RECIPIENTS) return { use: false, fallback: `發給不到 ${NARROWCAST_MIN_RECIPIENTS} 人` }
  return { use: true, fallback: null }
}

/** 補發要送給誰（LINE narrowcast 的 recipient）。uploadGid＝原本那則上傳的名單、derivedGid＝LINE 圈出的那份 */
export function followUpRecipient(target: BroadcastFollowUpTarget, uploadGid: number, derivedGid: number): Record<string, unknown> {
  const audience = (id: number) => ({ type: 'audience', audienceGroupId: id })
  if (target === 'clicked') return audience(derivedGid)
  // 沒打開／沒點＝原本那份名單扣掉 LINE 圈出的那份
  return { type: 'operator', and: [audience(uploadGid), { type: 'operator', not: audience(derivedGid) }] }
}

/** 請 LINE 圈哪一種名單：沒打開＝看過的人、點了／沒點＝點過的人 */
export function followUpAudienceKind(target: BroadcastFollowUpTarget): 'impression' | 'click' {
  return target === 'unopened' ? 'impression' : 'click'
}

/** 補發草稿的名字 */
export function followUpDraftName(sourceName: string, target: BroadcastFollowUpTarget): string {
  const base = String(sourceName || '').trim().slice(0, 60) || '推播'
  return `${base}－${FOLLOW_UP_BUTTON[target]}`
}

/** 發送對象那一格：補發給「小滑手_開賣」沒打開的人 */
export function followUpAudienceText(sourceName: string | undefined, target: BroadcastFollowUpTarget | undefined): string {
  if (!target || !isFollowUpTarget(target)) return '補發（對象不明）'
  const verb = target === 'unopened' ? '補發給' : '發給'
  return `${verb}「${String(sourceName || '').trim() || '原本那則推播'}」${FOLLOW_UP_LABEL[target]}`
}

/** narrowcast 送失敗時給人看的原因（LINE 的 errorCode，見 getNarrowcastProgress） */
export function narrowcastFailureText(errorCode?: number | null, failedDescription?: string | null): string {
  if (errorCode === 2) return '人數不夠，LINE 沒有送出'
  if (errorCode === 4) return `LINE 圈出的「看過／點過的人」不到 ${FOLLOW_UP_MIN_AUDIENCE} 位，沒有送出`
  if (errorCode === 5) return 'LINE 為了避免只送到一部分人，整則取消了（多半是這個月的訊息則數不夠）'
  const d = String(failedDescription || '').trim()
  return `LINE 沒有送出${d ? `（${d.slice(0, 120)}）` : ''}`
}
