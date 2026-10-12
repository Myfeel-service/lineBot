/**
 * 「第一次進這一頁要不要自動跑導覽」的判斷（2026-09-16 老闆拍板改成自動跑）。
 *
 * 抽成純函式是為了測得到：條件有六個，而它們在畫面上是**非同步陸續到齊**的
 * （角色、體檢狀態、後端記憶各自載入），靠人工開後台一頁頁試，試得到的只有其中幾種。
 * 元件那邊只負責把狀態餵進來、把結果接出去。
 */

export interface AutoTourInput {
  /** 「這個帳號看過哪幾頁」查完了沒（查失敗也算查完，那時會退回本機那一份） */
  seenReady: boolean
  /** 開通體檢載入了沒（沒載入就不知道這帳號是不是還在開通途中） */
  setupLoaded: boolean
  /**
   * 開通體檢**這次問不到**（查詢失敗，不是還在載入）。
   * ⛔ 沒有這一格的話，一次 5xx 就會讓判斷永遠停在「再等等」——
   *    連帶讓那句一次性的「這頁怎麼用？」提示也跟著永久消失，而且畫面上毫無錯誤。
   *    這正是這個專案一再吃虧的靜默死亡形狀。
   */
  setupFailed?: boolean
  /**
   * 這個帳號等一下**真的會被拉回開通對話**（接 LINE 接到一半就離開、下次進後台拉回一次，見 `onboarding-line-flag`）。
   * ⚠️ 2026-10-12（`D-124`）改：以前接的是「開通沒做完」（LINE 沒接／還沒用手機測試）。`C-250`（09-26）之後
   *    打造完就先進後台、LINE 是他自己挑時間接，**大部分沒接 LINE 的人根本不會被拉回去**——
   *    於是這批人在每一頁都不會自動跑導覽，09-16「第一次進一頁就帶一遍」對他們整個失效（新手走查時發現）。
   */
  pullingBackToOnboarding: boolean
  /** 這一頁對這個角色有沒有跑得動的教學 */
  hasTopics: boolean
  /** 現在已經有導覽開著 */
  tourOpen: boolean
  /** 這一頁的導覽，這個帳號看過了 */
  seen: boolean
}

/**
 * - `wait`：條件還沒到齊，等下一次狀態變動再問一次
 * - `start`：現在就排程開跑
 * - `skip`：這次進來不跑（原因各異，但對呼叫端來說都是「別再等了」）
 */
export type AutoTourDecision = 'wait' | 'start' | 'skip'

export function decideAutoTour(input: AutoTourInput): AutoTourDecision {
  // 還不知道答案的兩件事：不能當成「沒看過」去開導覽，也不能當成「看過」就放棄
  if (!input.seenReady)
    return 'wait'
  if (!input.setupLoaded) {
    // ⛔ 問不到就別再等：等下去的代價不只是這支導覽不跑，連原本那句一次性提示
    //    也會被一起卡住（呼叫端要等這裡說「別等了」才放行）。
    //    寧可這次不自動跑——那是可以忍受的；整頁的引導都無聲消失不是。
    return input.setupFailed ? 'skip' : 'wait'
  }
  // 等一下會被拉去開通對話的不插隊：那條流程結尾本來就會問他要不要「帶你認識後台」。
  // 在這裡搶先開一支，等於兩個引導同時對他說話。
  if (input.pullingBackToOnboarding)
    return 'skip'
  // 角色是非同步載進來的：這一瞬間沒有教學可跑 ≠ 這個角色沒有教學可跑
  if (!input.hasTopics)
    return 'wait'
  // 已經有導覽開著（開通結尾指定的那支、或他自己從小幫手開的）＝這一頁這次不用再自動跑。
  // ⛔ 不要改成「等它關掉再跑」：那會變成看完一支馬上被另一支蓋上，正是老闆當初
  //    否決自動導覽的那種騷擾。
  if (input.tourOpen)
    return 'skip'
  if (input.seen)
    return 'skip'
  return 'start'
}
