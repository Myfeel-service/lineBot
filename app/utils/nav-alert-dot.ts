/**
 * 側欄那一顆點：該不該亮、什麼顏色、滑過去講什麼。
 *
 * 純函式抽在這裡是為了**測得到**——這顆點的規則已經被老闆改過三次，每次都是
 * 「哪些情況該亮」的判斷在變，而元件裡的 computed 沒有測試守著（2026-08-23 教訓：
 * typecheck 綠 + 既有測試綠 ≠ 新規則真的跑到）。
 *
 * 訊號來源＝ `useWorkspaceAlerts().navAlerts`，跟右下角小幫手**同一份資料**、不打新查詢。
 * 規則全部在這支函式裡，⛔別在呼叫端各自加條件：
 *
 * 1. **只畫壞掉的**：紅＝客人正在受影響、琥珀＝該處理但客人還沒被影響。
 *    建議類（「AI 可以幫你更好」）不上側欄——老闆 `2026-08-26` 拍板，理由是建議常年都有，
 *    掛上去一個月後那顆點永遠亮著，整排會被當成裝飾。
 * 2. **沒事、查不到、沒權限＝什麼都不畫**，也不寫「正常」。系統沒在檢查的頁面畫綠燈
 *    就是說謊（`2026-08-09` 踩過：背景載入失敗被吞掉→回空陣列→綠燈照亮）。
 * 3. **開通還沒做完時只亮一顆**：「組織與 LINE」那一列（＝回答「LINE 接上了沒」的那一頁），
 *    其餘整排不畫。
 *    - `08-26` 原本是「開通期整排都不畫」，理由是那段路已經有滿版開通引導＋小幫手英雄卡在帶。
 *    - `08-27` 老闆問「側欄是不是也該亮」→ 改成單一顆。理由是頂端那條開通帶住在**會捲動的
 *      內容區**裡（不是吸頂的），往下滑就不見了；捲走之後整個左半邊沒有任何訊號，唯一還在
 *      講話的是右下角那顆——而這整案的起點正是「異常都躲在小幫手裡沒人看」。
 *      只給一顆是為了守住同一把尺：一多就變裝飾（開通帶同日也是只給一條、不逐項列）。
 *    - ⛔ 仍要求體檢狀態 `loaded` 才畫：不然新帳號會先閃一排點再消失。
 *
 * ⛔ 不顯示數字（`08-26` 拍板）：點只回答「去哪一頁」，數量進到頁面才有意義；掛在側欄
 *    等於逼使用者記住一個他當下無法核對的數。
 */

import type { AlertSeverity } from '~~/shared/types/alerts'

export interface NavAlertDot {
  /** 只有兩種顏色（⛔沒有綠色、沒有建議色，見上面規則 1／2） */
  severity: 'critical' | 'warning'
  /** 滑過去那一句白話（已含前綴，呼叫端直接用，別再自己拼） */
  tip: string
}

export interface NavAlertDotInput {
  /** 這個側欄項的路徑（就是 NuxtLink 的 to，不帶查詢字串） */
  path: string
  /** 體檢狀態載入完了嗎（`useSetupStatus().loaded`） */
  setupLoaded: boolean
  /** 開通（接 LINE＋收到第一則訊息）還沒做完 */
  onboardingIncomplete: boolean
  /** 開通期唯一允許亮的那一列的路徑（`useSetupStatus().onboardingNavPath`） */
  onboardingNavPath: string
  /** 開通期那顆點要說的話（`useSetupStatus().onboardingBand.navTip`） */
  onboardingTip: string
  /** 營運期的異常展開（`useWorkspaceAlerts().navAlerts`） */
  navAlerts: Record<string, { severity: AlertSeverity, titles: string[] }>
}

export function navAlertDot(input: NavAlertDotInput): NavAlertDot | undefined {
  // 查不到狀態就什麼都不畫（規則 2）；也避免新帳號先閃一排點再消失（規則 3）
  if (!input.setupLoaded)
    return undefined

  // 開通期：只有「組織與 LINE」那一列亮，其餘整排安靜（規則 3）
  if (input.onboardingIncomplete) {
    if (!input.onboardingNavPath || input.path !== input.onboardingNavPath)
      return undefined
    return { severity: 'critical', tip: input.onboardingTip }
  }

  const hit = input.navAlerts[input.path]
  // titles 空的時候不畫：一顆點卻講不出是哪件事，等於逼人到處點看看
  if (!hit || hit.titles.length === 0)
    return undefined
  // 建議類不上側欄（規則 1）。navAlerts 上游已濾掉，這裡是最後一道，不靠上游好心
  if (hit.severity === 'suggestion')
    return undefined

  const severity = hit.severity === 'critical' ? 'critical' : 'warning'
  const lead = severity === 'critical' ? '客人正在受影響' : '有事情要處理'
  return { severity, tip: `${lead}：${hit.titles.join('、')}` }
}
