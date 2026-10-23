import type { Firestore } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import type { messagingApi } from '@line/bot-sdk'
import { readLineMessageQuota } from './line'
import { getAiSettings } from './ai-settings'
import { pushToNotifyList } from './line-notify-delivery'
import { sendEmail } from './email'
import { brandName, resolveBillingRecipient } from './billing-emails'
import { notifyRecipients } from '~~/shared/line-notify-list'
import { LINE_OA_MANAGER_URL, lineQuotaLevel, lineQuotaResetLabel, lineQuotaWarnNotifyText } from '~~/shared/line-quota'
import { lineQuotaExhaustedEmail } from '~~/shared/billing/email-content'
import { taipeiHour, taipeiYyyyMm } from '~~/shared/time'

// ── LINE 訊息用到八成傳一則、用完寄信（`D-146`③，`C-384`）──────────────────────
// 傳給店家的 LINE 通知用的是店家自己的官方帳號、吃同一份則數：用完那一刻，連「用完了」都傳不出去。
// 所以八成時先用 LINE 講（勾「出大事」的人，跟「⚠️ AI 用量預警」同一套），用完只能寄信（`C-90` 的第一件）。
// LINE 不會主動告訴我們剩幾則，要問；掛在既有每 10 分鐘的排程上，一小時才整輪真的問一次。

/** 多久整輪問一次 LINE（同「出大事」那支的一小時） */
const CHECK_INTERVAL_MS = 60 * 60_000
/** 一次最多同時問幾個帳號（`C-395`）：一個一個排隊的話，帳號一多、LINE 一慢（每個最多等 4 秒），整支排程的回應就被拖住 */
const CONCURRENCY = 5
/** 傳不出去、寄不出去之後多久再試（同 AI 用量預警的 6 小時） */
const RETRY_MS = 6 * 3600_000
/** LINE 那則只在這個時段傳（台北時間）；信隨時寄（不會吵醒人，而且用完了等不了） */
const WARN_HOUR_FROM = 9
const WARN_HOUR_TO = 21
const WORKSPACE_CAP = 2000

/** 每個帳號一份：這個月傳過／寄過了沒（月份＝台北時間 yyyyMM），跟 aiQuotaAlerts 同一種做法 */
export const LINE_QUOTA_ALERTS_COLLECTION = 'lineQuotaAlerts'

interface LineQuotaAlertState {
  /** 八成那則這個月已經送到至少一個人 */
  warnMonth?: string
  warnAttemptMonth?: string
  warnAttemptAtMs?: number
  /** 用完那封信這個月已經寄出 */
  emailMonth?: string
  emailAttemptMonth?: string
  emailAttemptAtMs?: number
}

function inRetryWindow(attemptMonth: string | undefined, attemptAtMs: number | undefined, month: string, now: number): boolean {
  return attemptMonth === month && now - (attemptAtMs ?? 0) < RETRY_MS
}

/** 一個帳號：問 LINE、該傳就傳、該寄就寄 */
async function checkWorkspace(db: Firestore, wid: string, nowMs: number): Promise<{ warned: boolean, emailed: boolean }> {
  const now = new Date(nowMs)
  const month = taipeiYyyyMm(now)
  const hour = taipeiHour(now)
  const daytime = hour >= WARN_HOUR_FROM && hour < WARN_HOUR_TO
  const none = { warned: false, emailed: false }

  // 現問、不看快取：這一支是「該不該發通知」的依據，⛔ 不能拿 5 分鐘前畫面上那份
  const read = await readLineMessageQuota(wid)
  // 沒接 LINE、這次問不到 → 這輪不發（⛔ 問不到不是用完；下一個小時再問）
  if (read.kind !== 'ok') return none
  const level = lineQuotaLevel(read.quota)
  if (level !== 'near' && level !== 'over') return none

  const ref = db.collection(LINE_QUOTA_ALERTS_COLLECTION).doc(wid)
  const st = ((await ref.get()).data() ?? {}) as LineQuotaAlertState

  // ── 八成：LINE 傳一則（這個月一次）。已經用完了就不傳——一定送不出去，改寄信 ──
  if (level === 'near' && daytime && st.warnMonth !== month
    && !inRetryWindow(st.warnAttemptMonth, st.warnAttemptAtMs, month, nowMs)) {
    const settings = await getAiSettings(wid, db).catch(() => null)
    const to = settings?.handoffNotify ? notifyRecipients(settings.handoffNotify, 'crit') : []
    if (!to.length) return none
    // 先記「嘗試過」再傳：併發最壞重複一則，可接受（同 AI 用量預警）
    await ref.set({ warnAttemptMonth: month, warnAttemptAtMs: nowMs }, { merge: true })
    const msg: messagingApi.TextMessage = { type: 'text', text: lineQuotaWarnNotifyText(read.quota, now) }
    const results = await pushToNotifyList(wid, to, [msg], db)
    // ⛔ 至少送到一個人才記「這個月講過了」：全滅就留著，6 小時後再試（同 AI 用量預警 `C-89`）
    if (!results.some(r => r.status === 'fulfilled')) {
      console.warn('[line-quota-notices] 八成那則一個人都沒送到:', wid)
      return none
    }
    await ref.set({ warnMonth: month, warnedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { warned: true, emailed: false }
  }

  // ── 用完：寄信給帳號負責人（這個月一次）──
  if (level === 'over' && st.emailMonth !== month
    && !inRetryWindow(st.emailAttemptMonth, st.emailAttemptAtMs, month, nowMs)) {
    await ref.set({ emailAttemptMonth: month, emailAttemptAtMs: nowMs }, { merge: true })
    // 收件人跟收據同一個（發票上的 Email，沒有就組織負責人）
    const { email, workspaceName } = await resolveBillingRecipient(wid, db)
    if (!email) {
      console.warn('[line-quota-notices] LINE 訊息用完了，但這個帳號查不到可以寄的信箱:', wid)
      return none
    }
    const content = lineQuotaExhaustedEmail({
      brandName: brandName(),
      workspaceName,
      limit: read.quota.limit,
      resetLabel: lineQuotaResetLabel(now),
      lineManagerUrl: LINE_OA_MANAGER_URL,
    })
    const r = await sendEmail({ to: email, ...content })
    // ⛔ 沒設寄信（skipped）、寄失敗都不記「寄過了」：6 小時後再試
    if (!r.ok) return none
    await ref.set({ emailMonth: month, emailedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { warned: false, emailed: true }
  }
  return none
}

export async function notifyLineQuotaLevels(db: Firestore, nowMs: number = Date.now()) {
  // 一小時整輪跑一次（`C-395`）：還沒到就連 workspaces 都不讀。以前每 10 分鐘把整個 workspaces 讀一遍
  // （一份算一次讀取）才逐一看節流記號跳過，一天 144 輪×帳號數；資料庫讀取已經是最大的一筆費用（`E-38`）
  const checkRef = db.collection('cronState').doc('line-quota-notices')
  const roundAt = Number((await checkRef.get()).data()?.roundAt ?? 0)
  if (roundAt && nowMs - roundAt < CHECK_INTERVAL_MS) return { checked: 0, warned: 0, emailed: 0, skipped: 'not-due' as const }
  // 先佔這一輪再問（寫不進去就整輪不跑、10 分鐘後再來）：問到一半被砍掉時，下一輪不會把全部帳號再問一次
  await checkRef.set({ roundAt: nowMs }, { merge: true })

  // 只帶權杖那一格（一份照樣算一次讀取）：沒接 LINE 的帳號當場跳過，不用再去讀它的設定、也不佔下面的名額
  const wsSnap = await db.collection('workspaces').select('channelAccessToken').limit(WORKSPACE_CAP).get()
  const queue = wsSnap.docs.filter(d => String(d.data()?.channelAccessToken ?? '').trim()).map(d => d.id)

  let checked = 0
  let warned = 0
  let emailed = 0
  const checkedAt: Record<string, { checkedAt: number }> = {}
  const worker = async () => {
    for (let wid = queue.shift(); wid; wid = queue.shift()) {
      checkedAt[wid] = { checkedAt: nowMs }
      checked++
      // 一個帳號出錯不拖累其他帳號（以前一個 throw 整輪就停在那裡）
      const r = await checkWorkspace(db, wid, nowMs).catch((err) => {
        console.warn('[line-quota-notices] check failed:', wid, err)
        return null
      })
      if (r?.warned) warned++
      if (r?.emailed) emailed++
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  // 每個帳號問過的時間併成一次寫入（以前每個帳號各寫一次同一份文件，整點擠在同一輪會互相卡住）；只留給人查，不拿來節流
  if (checked) {
    await checkRef.set(checkedAt, { merge: true })
      .catch(err => console.warn('[line-quota-notices] checkedAt write failed:', err))
  }
  return { checked, warned, emailed }
}
