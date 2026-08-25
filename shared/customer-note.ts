/**
 * 客人備註（G-27 功能缺口①）——客服之間交接用的自由文字。
 *
 * 為什麼要有：LINE 官方帳號後台右側面板有「記事本」，寫的是
 * 「這位客人堅持要原廠保固，已回報廠商，等回覆」這種**留給下一個同事**的話。
 * 我們原本只有 AI 產的接手摘要，人自己沒有地方寫——所以客服只能寫在對話裡
 * （客人看得到）或寫在系統外面（下一個人找不到）。
 *
 * ⛔ **絕對不會送給客人**：它只存在後台，webhook／送訊息那條路完全不碰這個欄位。
 * ⛔ 一位客人只有一則（照 LINE 的做法），不是留言串——留言串要處理刪除、權限、
 *    分頁，而客服交接要的就是「現在的狀況是什麼」一句話。改寫時直接覆蓋，
 *    但會記下**是誰、什麼時候**改的，出事追得回來。
 */

/** 和 LINE 記事本同一個上限，字數提示才對得上客服的既有習慣 */
export const CUSTOMER_NOTE_MAX_CHARS = 1000

export interface CustomerNote {
  text: string
  /** 最後編輯者的顯示名稱（沒有名字就退回 email；兩者都沒有才空） */
  updatedByName: string
  updatedAtMs: number
}

/**
 * 存檔前的正規化：修掉尾端空白、統一換行、砍掉超過上限的部分。
 *
 * ⛔ 這裡**不 trim 開頭的空白**只 trim 尾端：客服會用縮排排版清單，
 *    開頭的空白是他自己排的，不該幫他改掉。
 */
export function normalizeCustomerNote(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd()
    .slice(0, CUSTOMER_NOTE_MAX_CHARS)
}

/** 空備註＝沒有備註（存進 Firestore 時要能判斷「該不該清掉這幾個欄位」） */
export function isEmptyCustomerNote(text: string): boolean {
  return text.trim().length === 0
}
