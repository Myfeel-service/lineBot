/**
 * 早上那則 LINE 摘要：今天要提醒哪一檔、那一檔排了沒（`D-122`①②，2026-10-19）。
 *
 * ── 這支在補的洞 ───────────────────────────────────────────────
 * 節日前 7／3／1 天的提醒（`C-223`）只記得「提醒過哪幾次」，**不知道卡片上發生了什麼**：
 * - 卡片上按了「這次不做」的那一檔，早上照樣叫他準備（賣工具機的不做情人節）；
 * - 已經排好推播的，3 天前照樣叫他「今天就到後台排進去」——他明明排好了；
 * - 店家自己加的檔期（週年慶、新品開賣）根本不在提醒的名單上。
 * 卡片講一套、LINE 講另一套，店家會覺得系統沒在聽他說話。
 *
 * ── 三條鐵律 ───────────────────────────────────────────────────
 * ① **跟卡片讀同一份資料、用同一支判斷**：收起來的看 `marketingCalendarSkips`、
 *    排了沒看 `plannedForFestival`、自己的檔期看 `marketingCalendarEvents`。⛔ 不在這裡另寫一套。
 * ② **不花 AI 費用**：這裡只讀資料庫（每個帳號一天最多 1＋1＋1 份：自己的檔期、收起來的、推播掃一趟），
 *    而且只在「今天真的有一檔要講」時才讀後兩份。
 * ③ **讀不到就退回原本的講法**，⛔ 不可以讓整段消失：收起來的讀不到＝當作沒收（跟卡片同一個預設）、
 *    推播讀不到＝不講排在哪天（照舊提醒去排）、自己的檔期讀不到＝只講節日。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getMarketingEvents } from './marketing-events'
import { getMarketingSkips } from './marketing-skips'
import { loadCalendarBroadcasts } from './marketing-calendar-broadcasts'
import { pickPlanned, plannedForFestival } from '~~/shared/marketing-calendar'
import { ownEventFestival } from '~~/shared/marketing-events'
import {
  hasFestivalInWindow,
  pickFestivalReminder,
  type FestivalReminder,
  type ReminderPlan,
  type SentMilestones,
  type TaiwanFestival,
} from '~~/shared/taiwan-festivals'

export interface DigestFestivalPick {
  /** 今天要講的那一檔；沒有就是 null */
  reminder: FestivalReminder | null
  /** 已經為那一檔建好的推播（挑最該講的那一則）；沒有或查不到就是 null */
  plan: ReminderPlan | null
  /** 這個帳號自己的檔期（記里程碑時要用：⛔ 不在節日表上的 id 不可以被當成過期清掉） */
  ownFestivals: TaiwanFestival[]
}

/**
 * @param festivalWindowOpen 節日表上今天有沒有任何一檔進入 7 天內（呼叫端一輪算一次）
 * @param loadSent 讀這個帳號「提醒到第幾天」的紀錄（呼叫端整輪只讀一次 `cronState/festival-digest`）
 */
export async function pickDigestFestival(
  db: Firestore,
  workspaceId: string,
  today: string,
  opts: { festivalWindowOpen: boolean, loadSent: () => Promise<SentMilestones> },
): Promise<DigestFestivalPick> {
  const ownFestivals = await getMarketingEvents(db, workspaceId)
    .then(list => list.map(ownEventFestival))
    .catch((e) => {
      console.warn('[festival-digest] 自己的檔期讀不到，今天只講節日：', workspaceId, e)
      return [] as TaiwanFestival[]
    })
  const none: DigestFestivalPick = { reminder: null, plan: null, ownFestivals }

  // 便宜的閘門：節日表與自己的檔期都沒有一檔在 7 天內 → 連提醒紀錄都不用讀
  if (!opts.festivalWindowOpen && !hasFestivalInWindow(today, ownFestivals)) return none
  const sent = await opts.loadSent()
  if (!pickFestivalReminder(today, sent, { extra: ownFestivals })) return none

  // ① 收起來的那幾檔不講（讀不到＝當作沒收，跟卡片同一個預設）
  const skipped = await getMarketingSkips(db, workspaceId).catch((e) => {
    console.warn('[festival-digest] 收起來的檔期讀不到，照常提醒：', workspaceId, e)
    return {}
  })
  const reminder = pickFestivalReminder(today, sent, { extra: ownFestivals, skipped })
  if (!reminder) return none

  // ② 那一檔排了沒（跟卡片「✓ 已排程 …」同一支判斷）
  const bc = await loadCalendarBroadcasts(db, workspaceId)
  const plan = bc.failed ? null : pickPlanned(plannedForFestival(bc.planned, reminder.festival))
  return { reminder, plan, ownFestivals }
}
