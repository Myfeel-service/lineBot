/**
 * 標籤上那行「最近 9/3・3 次」的文案（`D-55`）。
 *
 * 為什麼要有這一行：標籤本身是「有／沒有」的開關——三個月前問過一次出貨的人，
 * 跟這個月追了四次的人，在畫面上（與推播名單裡）長得一模一樣。次數是後台**唯一**
 * 看得到「這個意圖還熱不熱」的地方；日期客服雖然能從對話翻，但翻得出來不等於看得到。
 *
 * ⛔ 抽成純函式是為了測得到：塞在 `.vue` 的 computed 裡，「手動貼的標籤不該顯示次數」
 *   這種規則沒有任何東西守著（見記憶 `feedback_verify_new_code_actually_runs`）。
 */
import { calendarDate } from './relative-time'

export interface TagHitInput {
  /** 最近一次被自動判到（沒有值＝從來沒被自動判到過，例如客服手動貼的） */
  lastHitAtMs?: number | null
  /** 被自動判到幾次（沒有值讀成 0） */
  hitCount?: number | null
}

export interface TagHitLabel {
  /** 標籤旁邊那截小字；空字串＝不要顯示 */
  text: string
  /** 滑上去的完整說明；空字串＝不要掛 title */
  title: string
}

/**
 * ⛔ **沒有日期就整個不顯示**，不可以拿「第一次貼上的時間」頂替：那是兩件不同的事實
 *   （第一次貼上 vs 最後一次被判到），頂替就是在畫面上製造假資料。客服手動貼的標籤
 *   天生沒有值，那時候空著才是誠實的。
 * ⛔ **只有 1 次就不印次數**：每顆標籤後面都掛一個「1 次」是雜訊，而且「1 次」與
 *   「沒記錄」在畫面上會被讀成同一件事。1 次只印日期。
 */
export function tagHitLabel(input: TagHitInput, now: number = Date.now()): TagHitLabel {
  const at = Number(input.lastHitAtMs)
  // ⚠️ 這道與下面 `if (!date)` 是兩層防護（實測拿掉這道、行為由下面那道擋住，測試仍綠）。
  //    留著是因為它擋的是「`calendarDate` 哪天改成對 NaN 也回字串」，別因為「看起來多餘」就刪。
  if (!Number.isFinite(at) || at <= 0) return { text: '', title: '' }

  const rawCount = Number(input.hitCount)
  const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 1
  const date = calendarDate(at, now)
  if (!date) return { text: '', title: '' }

  return {
    text: count >= 2 ? `最近 ${date}・${count} 次` : `最近 ${date}`,
    title: count >= 2
      ? `客人最近一次符合這個標籤是 ${date}，累計 ${count} 次。只算客人自己觸發（按鈕、腳本、輸入）或 AI 從對話判到的，客服手動貼的不算。`
      : `客人最近一次符合這個標籤是 ${date}。只算客人自己觸發或 AI 從對話判到的，客服手動貼的不算。`,
  }
}
