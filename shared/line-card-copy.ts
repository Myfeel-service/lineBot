/**
 * 按鈕卡片上「我們代店家寫的那句話」：**單一事實來源**（`C-228`）。
 *
 * ⛔ 為什麼要獨立成一支檔案：店家在推播／自動回應／客服預存／活動選「開啟網址」或
 * 「觸發機器人模組」時，他只給了一個網址或一個模組編號——**卡片上那句話與按鈕上那
 * 幾個字是我們替他寫的，而他從來沒被問過，畫面上也沒有一處講過它存在**。
 *
 * 2026-09-23（`D-87` 全模組預覽評估）掃出來的實際狀況：
 *
 *   1. 推播的模組卡寫「請點擊下方按鈕以進入機器人模組。」
 *      → **「機器人模組」是後台自用的詞，直接送到客人手機上**。客人不知道那是什麼。
 *   2. 同一件事兩套文案：推播寫「請點擊下方按鈕開啟連結。」，
 *      自動回應／客服預存／活動寫「請點擊下方連結」。同一家店的客人會收到兩種講法。
 *   3. 按鈕文字寫死「開啟網址」——也是我們替他決定的。
 *
 * ⛔ 別再在別處寫死這幾句話。要改措辭改這裡一個地方，四個頁面一起改到。
 *
 * ⚠️ 這裡的值是**預設**，不是規定：`C-228` 的後半段會在編輯器加兩格讓店家自己寫
 * （UI 那半要等 `D-86` 的共用選模組欄位先進 main，見 `STATUS.md`）。送出端已經先接好
 * 覆寫參數，UI 落地時只要把值傳進來，這支檔案不用再動。
 *
 * ⛔ **不要拿「推播名稱」當預設**：那是給店家自己管理用的內部名字（畫面上寫「方便後續
 * 管理」），不是寫給客人看的。
 */

/**
 * 卡片本文的預設：網址與模組共用同一句。
 *
 * ⭐ 兩種動作對客人來說是**同一件事**——「下面有一顆按鈕，按了會看到東西」。
 * 客人不需要（也不該）知道按下去的是一個網頁還是一組我們準備好的訊息。
 */
export const LINE_CARD_BODY_DEFAULT = '點下面的按鈕看看'

/** 「開啟網址」的按鈕預設字。⛔ 原本寫死「開啟網址」——「網址」是我們的詞不是客人的。 */
export const LINE_CARD_BUTTON_LABEL_URI_DEFAULT = '看詳情'

/** 「觸發機器人模組」的按鈕預設字。⛔ 按鈕上與本文都不可以出現「模組」兩個字。 */
export const LINE_CARD_BUTTON_LABEL_MODULE_DEFAULT = '開始'

/**
 * altText＝客人在通知列與聊天列表看到的那一行（卡片本身畫不出來時也是它頂替）。
 * ⛔ 同樣不可以出現「模組」。
 */
export const LINE_CARD_ALT_TEXT_URI = '有一則訊息'
export const LINE_CARD_ALT_TEXT_MODULE = '有一則訊息'

/** LINE 的 action label 上限就是 20 字，超過整則會被退件 */
export const LINE_ACTION_LABEL_MAX = 20

/**
 * `C-228` 以前由系統代寫、店家從沒同意過的那幾句話。
 *
 * ⛔ **存在的唯一理由是「讀回來時要認得出它不是店家寫的」**：草稿存在 Firestore 裡的是
 * 組好的 LINE 訊息，讀回編輯器時會把卡片本文還原成「店家自訂的文案」。若不認這幾句，
 * 2026-09-23 以前建的草稿一讀回來就會被當成店家親手寫的，**那句「請點擊下方按鈕以進入
 * 機器人模組。」就會被永久保存下來**，改了預設也救不到它們——等於這次修了個寂寞。
 *
 * ⛔ 不要拿它們去比對「客人收到的訊息」做任何統計或稽核：已經送出去的訊息是歷史紀錄，
 * 不該因為我們換了措辭就被改寫或重新詮釋。
 * ⛔ 這份清單只增不改：哪天又換一次措辭，把舊的那句加進來，不要把既有的字改掉。
 */
export const LEGACY_AUTO_WRITTEN_CARD_BODIES: readonly string[] = [
  '請點擊下方按鈕開啟連結。',
  '請點擊下方按鈕以進入機器人模組。',
  '請點擊下方連結',
]

/** 這句話是不是我們以前代寫的（＝不是店家寫的，讀回編輯器時要當成「沒寫」） */
export function isLegacyAutoWrittenCardBody(text: unknown): boolean {
  const s = typeof text === 'string' ? text.trim() : ''
  if (!s) return true
  return LEGACY_AUTO_WRITTEN_CARD_BODIES.includes(s)
}

/**
 * 把店家自訂值套上預設。
 *
 * ⚠️ 只有 **trim 後仍非空** 才算數：空字串、只有空白、`undefined` 一律退回預設。
 * ⛔ 不可以讓空字串直接出去——LINE 收到空的 label 會整則退件，而那時店家看到的
 * 是「發送失敗」四個字，完全對不上「我把那一格清空了」。
 */
export function resolveCardCopy(custom: unknown, fallback: string): string {
  const s = typeof custom === 'string' ? custom.trim() : ''
  return s || fallback
}

/** 按鈕文字：套完預設再照 LINE 的 20 字上限截斷 */
export function resolveCardButtonLabel(custom: unknown, fallback: string): string {
  return resolveCardCopy(custom, fallback).slice(0, LINE_ACTION_LABEL_MAX)
}
