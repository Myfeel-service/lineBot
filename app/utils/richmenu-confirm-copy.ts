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
        message: '會先建立起來，但客人還看不到——你要讓客人看到的時候，再到清單上把它設為預設。',
        title: '確認建立',
        confirmButtonText: '建立（先不上線）',
        cancelButtonText: '再檢查一下',
        type: 'info',
      }
}
