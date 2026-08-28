/**
 * 「壞掉的就是這一格」——把頁面上那個出事的欄位／區塊標出來。
 *
 * 為什麼要有這個（2026-08-28 老闆回饋）：提醒帶已經會在每一頁頂端講「這一頁現在有什麼事」，
 * 但人往下捲之後，畫面上二十幾個欄位長得一模一樣——「LINE 官方帳號還沒接上」講完了，
 * 要填的是哪兩格（Channel Access Token、Channel Secret）完全看不出來。
 * 「帶我看」的聚光燈能指，但那要**按了才會發生**；沒按的人到頁面等於自己重找一遍。
 *
 * 這支只做一件事：算出「這一頁要標哪些選擇器、什麼顏色、掛哪一句話」。
 * 真的去 DOM 上標的動作在 `AdminPageAlertStrip`（同一個元件已經在決定這一頁有哪些事，
 * ⛔別在頁面裡各自實作——每頁自刻正是這整案要修掉的毛病）。
 *
 * 純函式抽在這裡是為了**測得到**：規則（誰該標、誰不該標、撞格子怎麼辦）以後一定會再改，
 * 而元件裡的 computed 沒有測試守著（見 `nav-alert-dot.ts` 同一個理由）。
 */

/** 標記顏色：跟提醒帶、側欄那顆點同一把尺，⛔沒有綠色也沒有建議色 */
export type AlertMarkTone = 'critical' | 'warning'

export interface AlertFieldMark {
  /** 要標的 CSS 選擇器（可用逗號列多個：跨頁的異常在哪一頁就標哪一頁有的那個） */
  selector: string
  tone: AlertMarkTone
  /** 掛在**第一個**命中元素上的小標籤文字（同一顆異常標到好幾格時，只有第一格掛字） */
  label: string
}

/**
 * 算標記需要的最小輸入。刻意不吃 `ResolvedAlert` 整包：
 * 開通帶（還沒接 LINE）不是一顆「異常」，但要走同一條路標同一種樣子。
 */
export interface AlertMarkSource {
  /** 只用來去重／除錯 */
  id: string
  /** 標籤文字＝提醒帶上那一句（ALERT_LABELS／開通帶標題）。⛔別在這裡另外寫一套措辭 */
  title: string
  severity: 'critical' | 'warning' | 'suggestion'
  /** 'system' ＝系統這邊的狀況，使用者動不了手（SYSTEM_OWNED_ALERTS） */
  owner?: 'system'
  /** 有一鍵修的話，使用者就有事可做 */
  fixOpId?: string
  /** 壞掉的那一格；沒填就沿用 `anchor`（「能處理它的區塊」通常就是那一格） */
  mark?: string
  anchor?: { selector: string }
}

/**
 * 這一頁要標的格子。輸入是提醒帶已經算好的「這一頁現在有的事」，順序即優先序（紅在前）。
 *
 * 三條規則（改之前先讀）：
 *
 * 1. **標不出來就不標**：沒有 `mark` 也沒有 `anchor` 的異常一律略過。與其在頁面上圈一個
 *    「大概在這附近」的區塊，不如什麼都不圈——圈錯的地方比沒圈更糟（同側欄狀態點的教訓）。
 * 2. **系統這邊的狀況不標**（除非有一鍵修）：`llmError`、`maintenanceStalled` 這類使用者
 *    動不了手的項目，圈起來只會讓人對著一個沒有東西可按的區塊找半天。它們照樣在提醒帶上
 *    講「不用你操作」——那才是對的位置。有 `fixOpId` 的例外（有按鈕可按就不是「動不了手」）。
 * 3. **建議類不標**：沒有東西壞掉，圈起來會變裝飾（同 2026-08-26「建議不上側欄」拍板）。
 *
 * 同一個選擇器只留一次（先到＝比較嚴重的那顆先講）。
 */
export function alertFieldMarks(sources: AlertMarkSource[]): AlertFieldMark[] {
  const out: AlertFieldMark[] = []
  const seen = new Set<string>()
  for (const s of sources) {
    if (s.severity === 'suggestion')
      continue
    if (s.owner === 'system' && !s.fixOpId)
      continue
    const selector = s.mark ?? s.anchor?.selector
    if (!selector || seen.has(selector))
      continue
    seen.add(selector)
    out.push({
      selector,
      tone: s.severity === 'critical' ? 'critical' : 'warning',
      label: s.title,
    })
  }
  // 紅先標：撞到同一格時紅蓋過琥珀（與側欄狀態點同一條規則）
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'critical' ? -1 : 1))
}

/** 顏色（'critical' / 'warning'）。樣式全部掛在這個屬性上，見 `_alert-field-mark.scss` */
export const ALERT_MARK_ATTR = 'data-alert-mark'
/** 框下緣那一句話（用 `::after` 的 `attr()` 印出來） */
export const ALERT_MARK_LABEL_ATTR = 'data-alert-mark-label'
/** 元素原本是 static 時才掛：⛔別無條件覆蓋頁面自己的 sticky／absolute 定位 */
export const ALERT_MARK_REL_ATTR = 'data-alert-mark-rel'

/** 把上一輪的標記全部收乾淨。⛔重標之前一定要先清，不然修好的格子會一直圈著 */
export function clearAlertFieldMarks(root: Document | HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${ALERT_MARK_ATTR}]`))) {
    el.removeAttribute(ALERT_MARK_ATTR)
    el.removeAttribute(ALERT_MARK_LABEL_ATTR)
    el.removeAttribute(ALERT_MARK_REL_ATTR)
  }
}

/**
 * 把一顆異常的框畫到 DOM 上，回傳實際圈到幾格（0＝這一頁沒有這個區塊）。
 *
 * 抽成函式是為了**驗得到**：畫框這段沒有測試守著的話，失效方式跟「一切正常」長得一樣
 * （屬性沒掛上去，畫面就只是一個普通頁面，不會有任何錯誤訊息）。
 *
 * ⛔ 只加屬性，不改 inline style、不塞 DOM 節點：這些格子是 Vue 在管的，
 *    外部插節點會在下一次 patch 時打架；改 style 則會在某一頁把版面擠歪。
 */
export function paintAlertFieldMark(root: Document | HTMLElement, mark: AlertFieldMark): number {
  const els = Array.from(root.querySelectorAll<HTMLElement>(mark.selector))
  let painted = 0
  let labelled = false
  for (const el of els) {
    const cur = el.getAttribute(ALERT_MARK_ATTR)
    // 一格只由一顆異常標：先到先得，但紅色可以把琥珀升上來
    // （同側欄狀態點的「紅蓋過琥珀」，⛔不要反過來）
    if (cur && !(cur === 'warning' && mark.tone === 'critical'))
      continue
    el.setAttribute(ALERT_MARK_ATTR, mark.tone)
    if (el.ownerDocument.defaultView?.getComputedStyle(el).position === 'static')
      el.setAttribute(ALERT_MARK_REL_ATTR, '')
    // 一顆異常圈到好幾格時（憑證 Token＋Secret）只有第一格掛字：
    // 同一句話印兩次是雜訊，框本身已經說得出「這幾格是一組」
    if (!labelled) {
      el.setAttribute(ALERT_MARK_LABEL_ATTR, mark.label)
      labelled = true
    }
    painted++
  }
  return painted
}
