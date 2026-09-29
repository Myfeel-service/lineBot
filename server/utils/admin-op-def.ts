/**
 * 小幫手代辦（`C-31` Phase 2）的共用型別與錯誤類別。
 *
 * 為什麼從 `admin-ops.ts` 拆出來（2026-09-29 `D-109`）：第二批操作放在 `admin-ops-content.ts`，
 * 它要用 `AdminOpUserError`，而 `admin-ops.ts` 的註冊表又要 import 它——兩支互相 import，
 * 只要哪天有人先載入 `admin-ops-content`，註冊表就會拿到還沒初始化的東西（ESM 循環相依）。
 * 放在一支誰都不 import 的小檔裡，兩邊都從這裡拿，就沒有循環。
 * `admin-ops.ts` 照樣 re-export 這幾個名字，既有的 import 路徑都不用改。
 */
import type { Firestore } from 'firebase-admin/firestore'
import type { Capability } from '~~/shared/permissions'
import type { AdminOpPreview, AdminOpResult } from '~~/shared/types/admin-ops'

export interface AdminOpCtx {
  db: Firestore
  workspaceId: string
  uid: string
  /**
   * 呼叫者的 Authorization header：要走既有端點的 op 用（權限與驗證由那支端點自己把關，
   * 口徑零第二份）。與 `alert-fix-ops` 同一招。
   */
  authHeader?: string
}

/**
 * 參數不合格／東西找不到時丟這個：訊息會**原樣**回給模型，讓它照著反問使用者。
 * ⛔ 所以訊息一律寫成「人看得懂、且指得出下一步」的句子，不要寫 stack 或欄位名。
 */
export class AdminOpUserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdminOpUserError'
  }
}

export interface AdminOpDef {
  /** 執行門檻：掛既有 capability 表，⛔不在這裡另外訂一套角色 */
  capability: Capability
  /** 給模型的參數說明（會灌進 prompt，所以要寫得像講給人聽的） */
  argsHint: string
  /**
   * 哪些參數是**自由文字**（會變成客人看得到的內容、或變成設定的內容）。
   *
   * 這些欄位會被檢查來源：一字不差地出現在「剛查到的資料」裡、卻不在使用者自己講的話裡
   * → 擋下來。⛔ 這是機制，不是 prompt 的請求——查到的資料是別人寫的，
   * 裡面塞一句話就讓小幫手照抄出去，是這條路上唯一會真的傷到客人的攻擊。
   */
  freeTextFields?: string[]
  /**
   * 這個操作的參數是**數值或時間**（幾點、幾分鐘）。
   *
   * 標了的話，使用者自己講過的話裡必須出現得了一個數值，否則不准提議。
   * ⛔ 2026-09-16 實測：「晚上太晚有人敲我，幫我設一下」——一個數字都沒講，
   *    模型直接提議 22:00–08:00，還順手把使用者沒抱怨的早上也提前兩小時。
   *    prompt 裡早就寫著「⛔不要自己補一個常見值」，照樣中，所以改成機制
   *    （判斷在 `shared/agent-user-signal.ts`，與 `freeTextFields` 那道來源檢查同一個位置把關）。
   */
  needsUserNumber?: boolean
  /**
   * 這一次的參數**不需要**數字（配 `needsUserNumber` 用；2026-09-29 `D-109`）。
   *
   * 為什麼要有：「不要自動交還了」「關掉自動結束」一個數字都不會講，那是合理的要求——
   * 只有 `needsUserNumber` 的話會被整句擋下，變成「關不掉」。
   * ⛔ 只能對「關掉」這種明確、不必挑數值的參數回 true（例如 `{off:true}`）；
   *    回 true 的條件寬了，就等於把上面那道防線拆掉。
   */
  numberOptional?: (raw: Record<string, unknown>) => boolean
  /**
   * 這個操作「動的是哪一個東西」放在哪個參數（流程名字、要加的那個字…）。
   *
   * 用來分辨兩件事：使用者是在**改同一個提議**（「改成 30 分鐘」），
   * 還是**換成另一件事**（提議加「退費」之後說「順便把客訴也加進去」）。
   * ⛔ 只看參數有沒有變是不夠的——改時間也會讓參數變，結果每次修改都跳一句
   *    「上一個提議還沒有被執行」，憑空講出一個並不存在的待辦（實測踩到）。
   * 不填＝這個操作只改單一設定，沒有「動到哪一個」的概念。
   */
  targetField?: string
  /** 收斂＋驗證：吐出正規化後的參數，或一句要使用者補充的話 */
  normalize: (raw: Record<string, unknown>) => Record<string, unknown>
  /**
   * 選填：提議前先把「要做的東西」準備好，**回傳的參數就是之後真的會執行的那一份**。
   *
   * 為什麼需要：AI 生出來的內容（例如一整條客服流程）每次生都不一樣。
   * 如果執行時才重生，使用者按確定同意的，跟系統實際建出來的就是兩份東西——
   * 那樣確認流等於沒有。所以生成只發生一次，結果跟著憑證走。
   */
  prepare?: (ctx: AdminOpCtx, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** 現況指紋：提議當下與按下確定前各算一次，不同就代表世界變了 */
  fingerprint: (ctx: AdminOpCtx, args: Record<string, unknown>) => Promise<string>
  preview: (ctx: AdminOpCtx, args: Record<string, unknown>) => Promise<AdminOpPreview>
  execute: (ctx: AdminOpCtx, args: Record<string, unknown>) => Promise<AdminOpResult>
}
