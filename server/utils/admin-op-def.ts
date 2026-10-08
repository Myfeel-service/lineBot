/**
 * 小幫手代辦（`C-31` Phase 2）的共用型別、錯誤類別，與兩批操作都要用的查找。
 *
 * 為什麼從 `admin-ops.ts` 拆出來（2026-09-29 `D-109`）：第二批操作放在 `admin-ops-content.ts`，
 * 它要用 `AdminOpUserError`，而 `admin-ops.ts` 的註冊表又要 import 它——兩支互相 import，
 * 只要哪天有人先載入 `admin-ops-content`，註冊表就會拿到還沒初始化的東西（ESM 循環相依）。
 * 放在一支**不 import 那兩支**的小檔裡，兩邊都從這裡拿，就沒有循環。
 * ⛔ `admin-ops.ts` **不** re-export 這裡的名字（server/utils 的匯出會被 Nitro 自動匯入，
 *    同一個名字從兩支檔案匯出，dev 一啟動就警告重複）——要用的人一律從 `./admin-op-def` import。
 */
import type { Firestore } from 'firebase-admin/firestore'
import type { Capability } from '~~/shared/permissions'
import type { AdminOpPreview, AdminOpResult } from '~~/shared/types/admin-ops'
import { SCRIPTS_COLLECTION } from './ai-scripts'

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
   * 選填：檢查參數是不是**使用者自己講過的**（`D-116`，2026-10-08）。不合格就丟 `AdminOpUserError`，
   * 訊息回給模型、讓它照著去問。
   *
   * 為什麼要有：`freeTextFields` 只擋「從查到的資料照抄」，擋不住「模型自己寫」——
   * 推播草稿實測自己寫了「國慶日快樂！」、沒問就選全部好友 9,076 人。
   * @param userSaid 使用者講過的話（這一輪＋先前輪次他自己打的；⛔不含助理的話）
   */
  checkUserWords?: (raw: Record<string, unknown>, userSaid: readonly string[]) => void
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

/**
 * 名字 → 一條自動回應（原始文件，含 `id`）。上下架（`admin-ops`）與改關鍵字／回覆字
 * （`admin-ops-content`）共用這一支——以前兩邊各寫一份，找不到時一邊列清單、一邊叫模型去查，
 * 撞名的判法也各一套（2026-09-30 code review）。
 *
 * ⛔ 模型不生 ID，也⛔不猜「最接近的那一條」：對不到就讓它反問，撞名就要求講得更清楚。
 * `docs`：呼叫端已經撈過整份清單時傳進來（上下架預覽要拿它算影響）——有清單才列得出現有的名字。
 */
export async function resolveScriptDoc(
  ctx: AdminOpCtx,
  name: string,
  docs?: Record<string, any>[],
): Promise<Record<string, any>> {
  // ⛔ 只是要「用名字找一條」時不要掃整個集合：單欄位等值查詢吃 Firestore 自動建的索引，
  //    不用開新的複合索引，而讀取數從「全部流程」降到「同名的那幾筆」。
  //    （2026-08-11 讀取費暴衝就是這種無上限掃描累積出來的。）
  const raw = docs ?? await (async () => {
    const snap = await ctx.db.collection(SCRIPTS_COLLECTION)
      // ⛔ 工作區要進**查詢條件**，不可以只靠事後過濾：只查 name 的話會撈到別的租戶，
      //    撞名的租戶多過 limit 就把自己這筆擠掉——症狀是提議時好好的
      //    （那一步有帶整份清單），**按下確定才失敗**。
      // ⚠️ 兩個都是等值條件，Firestore 用既有的單欄位索引就查得動，不必開新的複合索引。
      .where('workspaceId', '==', ctx.workspaceId)
      .where('name', '==', name.trim())
      .limit(10)
      .get()
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as Record<string, any>) } as Record<string, any>))
  })()
  // 保留這道：查詢已經擋掉了，這是第二層防線（傳進來的清單也一樣要過）
  const mine = raw.filter(d => d.workspaceId === ctx.workspaceId)
  const want = name.trim().toLowerCase()
  const hits = mine.filter(d => String(d.name ?? '').trim().toLowerCase() === want)

  if (hits.length === 1) return hits[0]!
  if (hits.length > 1)
    throw new AdminOpUserError(`有 ${hits.length} 條自動回應都叫「${name}」，我沒辦法確定是哪一條——請他到自動回應頁改掉其中一個名字，或直接在頁面上改。`)

  // 對不到：把現有的名字列出來讓它反問。只用名字查的那條路（提議時先算的指紋就是這條）要另外撈一次清單——
  // ⛔ 以前這裡直接講「這個工作區還沒有任何自動回應」：查不到**同名的**不等於一條都沒有，那句是假話，
  //    模型也就拿不到清單可以反問。只拿名字、只在失敗時才多這一次查詢。
  const pool = docs ? mine : await listScriptNames(ctx)
  if (!pool.length)
    throw new AdminOpUserError('這個帳號還沒有任何自動回應。')
  const names = pool.map(d => `「${String(d.name || '(未命名流程)')}」`).slice(0, 8).join('、')
  const more = pool.length >= SCRIPT_NAME_LIST_LIMIT && !docs ? ` 等 ${SCRIPT_NAME_LIST_LIMIT} 條以上` : ` 等 ${pool.length} 條`
  throw new AdminOpUserError(`找不到叫「${name}」的自動回應。目前有：${names}${pool.length > 8 ? more : ''}。請確認是哪一條（⛔ 不要猜最接近的）。`)
}

const SCRIPT_NAME_LIST_LIMIT = 50

/** 這個帳號的自動回應名字（只拿 name：流程文件裡有範例句向量，整份撈回來很肥） */
async function listScriptNames(ctx: AdminOpCtx): Promise<Record<string, any>[]> {
  const snap = await ctx.db.collection(SCRIPTS_COLLECTION)
    .where('workspaceId', '==', ctx.workspaceId)
    .select('name', 'workspaceId')
    .limit(SCRIPT_NAME_LIST_LIMIT)
    .get()
  return snap.docs
    .map(d => d.data() as Record<string, any>)
    .filter(d => d.workspaceId === ctx.workspaceId)
}
