/**
 * 建立圖文選單前那句確認文案（`C-193`）。
 *
 * ⛔ 以前不分情況都說「建立後會立即部署到 LINE，**所有好友的圖文選單會即時更新**」，
 *    但沒打開「設為預設」的話，一個好友的畫面都不會變——建立只是把它放上去，
 *    不會有人看到。每次建立都嚇一次，等於把唯一安全的中間狀態
 *    （建好但不上線）講得跟上線一樣危險，難怪沒人敢拿它存半成品。
 *
 * 抽成純函式的理由：這段在畫面上很難走到（送出前還要過名稱、區塊動作那幾道檢查，
 * 那些跟這句話無關），但講錯的代價是店家誤以為自己剛剛動到了所有客人的畫面。
 */
export interface RichMenuConfirmCopy {
  message: string
  title: string
  confirmButtonText: string
  cancelButtonText: string
  type: 'warning' | 'info'
}

export function richMenuCreateConfirmCopy(goesLive: boolean): RichMenuConfirmCopy {
  return goesLive
    ? {
        message: '這張選單會設成預設，所有好友的圖文選單會立刻換成它。確定嗎？',
        title: '確認上線',
        confirmButtonText: '建立並上線',
        cancelButtonText: '再檢查一下',
        type: 'warning',
      }
    : {
        // ⛔ 2026-09-29（`D-109`）：原本叫人「再到清單上把它設為預設」——清單上根本沒有那顆按鈕。
        //    現在那顆在「打開這張之後，上面那一排」，這句話照實指過去
        message: '會先建立起來，但客人還看不到——你要讓客人看到的時候，打開這張、按上面的「設為預設（上線）」。',
        title: '確認建立',
        confirmButtonText: '建立（先不上線）',
        cancelButtonText: '再檢查一下',
        type: 'info',
      }
}

/**
 * 按「設為預設（上線）」之前那句（`D-109`）：跟建立並上線同一種後果，所以同一種講法。
 * 有還沒存的改動時多講一句：上線的是**存好的那一版**（設預設走的是 LINE 上已經建好的那張）。
 */
export function richMenuSetDefaultConfirmCopy(p: { name: string, hasUnsavedChanges: boolean }): RichMenuConfirmCopy {
  const name = p.name?.trim() ? `「${p.name.trim()}」` : '這張選單'
  return {
    message: `${name}會設成預設，所有好友的圖文選單會立刻換成它。確定嗎？`
      // ⛔ 不用換行：確認框是純文字（沒開 HTML），\n 會被併成空白，所以直接接在同一段
      + (p.hasUnsavedChanges ? '（⚠️ 你剛改的還沒存——上線的會是存好的那一版；要連剛改的一起上線，先按「儲存變更」。）' : ''),
    title: '確認上線',
    confirmButtonText: '設為預設並上線',
    cancelButtonText: '再檢查一下',
    type: 'warning',
  }
}
