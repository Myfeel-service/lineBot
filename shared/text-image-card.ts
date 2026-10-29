/**
 * 模組「＋文字」加了圖片＝送成一張卡（`C-416`，`D-160` ②）。前後端同一份規則。
 *
 * 為什麼是「文字那格可以加圖」而不是另外一種訊息：店家要的是「一段字，上面放張圖、下面放按鈕」，
 * 以前「＋文字」放不進圖，只好圖一格、字一格分兩則送（MYFEEL 91 個自建模組裡 65 個是這樣）。
 * 想分開的人照舊拉兩格就好——分兩則送不多算則數（LINE 只看送給幾個人，`H-28` 更正）。
 * 「＋卡片訊息」留給好幾張左右滑。
 *
 * 送出去的樣子跟卡片訊息的單張卡一樣（大圖、粗體標題、內文、按鈕），差在：
 *   ① 圖照上傳時量到的原比例、不裁（`aspectMode: fit`）——卡片訊息要選四種比例之一、會置中裁切
 *   ② 內文上限跟純文字一樣 5000（LINE 驗證端點實測 5000 字＋圖＋按鈕 15.5 KB 收）
 *   ③ 按鈕最多 4 顆（跟「文字＋按鈕」一樣）；沒存樣式的算綠色——這條路是新的，沒有舊按鈕要維持原樣
 *   ④ 客人點圖片＝按第 1 顆按鈕（沒有按鈕就不能點）
 */
import { CARD_TITLE_MAX, type CardButtonStyle } from './card-message'

export const TEXT_IMAGE_TITLE_MAX = CARD_TITLE_MAX

/** LINE 的圖片元件：高最多是寬的 3 倍（驗證端點實測 1:4 退：`aspect ratio must be in the range (0 < (h/w) <= 3)`） */
const MAX_HEIGHT_PER_WIDTH = 3

/** 這則文字有沒有放圖（空白當沒有） */
export function textMessageImageUrl(msg: { imageUrl?: unknown } | null | undefined): string {
  return String(msg?.imageUrl ?? '').trim()
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

/**
 * 圖片比例：照上傳時量到的寬高。量不到（舊資料、量失敗）就用正方形，送出端用 `fit` 不裁、上下或左右留白。
 * 比 1:3 還長的圖收在 1:3（一樣不裁，兩邊留白）。
 * 回 LINE 要的 `寬:高` 與 CSS 的 `寬 / 高`，預覽跟送出同一個數字。
 */
export function textImageAspect(width: unknown, height: unknown): { lineAspectRatio: string, css: string } {
  let w = Math.round(Number(width) || 0)
  let h = Math.round(Number(height) || 0)
  if (!(w > 0 && h > 0)) {
    w = 1
    h = 1
  }
  else if (h > w * MAX_HEIGHT_PER_WIDTH) {
    w = 1
    h = MAX_HEIGHT_PER_WIDTH
  }
  else {
    const d = gcd(w, h)
    w /= d
    h /= d
  }
  return { lineAspectRatio: `${w}:${h}`, css: `${w} / ${h}` }
}

/** 按鈕樣式：明講「文字連結」的才是連結，其他都是綠色按鈕（跟卡片訊息的舊按鈕規則不同，見檔頭 ③） */
export function textImageButtonStyle(action: { style?: unknown } | null | undefined): CardButtonStyle {
  return action?.style === 'link' ? 'link' : 'primary'
}

/** 有圖時多出來的那幾格的存檔檢查（文字本身、按鈕的檢查照「＋文字」原本那套）；沒問題回空字串。前後端同一支 */
export function textImageError(msg: { imageUrl?: unknown, title?: unknown } | null | undefined): string {
  if (!textMessageImageUrl(msg)) return ''
  if (String(msg?.title ?? '').length > TEXT_IMAGE_TITLE_MAX) return `文字模組：標題最多 ${TEXT_IMAGE_TITLE_MAX} 字`
  return ''
}
