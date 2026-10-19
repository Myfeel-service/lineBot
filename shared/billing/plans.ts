// ═══════════════════════════════════════════════════════════════════
//  計費方案目錄（Single Source of Truth）
//
//  對外賣「每月 AI 回覆則數」，訂閱掛在「LINE 官方帳號（workspace）」層——
//  每個帳號各自選一個方案、額度各自獨立、不跨帳號共用。前端（方案頁 / 升級
//  提示）與後端（額度攔截 / 功能開關）都讀這一份，改價或改額度只動這裡、
//  重新部署即生效，不綁資料庫。
//
//  ⚠️ 此檔會 bundle 到前端，只放「對外可見」的定價與權益。
//     每則成本、毛利等內部數字一律不進此檔。
//  ⚠️ 數字暫定、可調。
//
//  訂閱掛在「帳號（OA / workspace）」層，與「組織 organization」的分組概念不同——
//  組織只做帳號分組與帳務歸屬，本身不再有方案／額度。
// ═══════════════════════════════════════════════════════════════════

import type { EmailAttempt } from './email-retry'

/** 計費方案 ID（掛在 workspace/OA 訂閱層）。test/internal 僅供 super admin 指派。 */
export type BillingPlanId = 'free' | 'lite' | 'starter' | 'growth' | 'pro' | 'enterprise' | 'test' | 'internal'

/** 數據報表等級：基本 → 進階 → 進階＋匯出。 */
export type ReportTier = 'basic' | 'advanced' | 'export'

/** 群發 / 分眾行銷等級：無 → 基本 → 進階分眾。 */
export type BroadcastTier = 'none' | 'basic' | 'advanced'

export interface BillingPlan {
  id: BillingPlanId
  /** 顯示名稱（繁中） */
  name: string
  /**
   * 每月 AI 回覆則數額度。
   *
   * **一則＝AI 出手回答一次**（2026-09-07 老闆拍板，見 `docs/STATUS.md` `D-69`）：
   *   · 正常答出 → 算一則。
   *   · 反問澄清（「你問的是 A 款還是 B 款？」）→ **也算一則**：它幫客人釐清了需求，
   *     也真的花了我們的錢；不算的話「故意設計成一直反問再轉真人」就能白吃服務。
   *   · 「這題我不確定，幫你請真人回覆」→ **不算**。這是對外的賣點（答不出不扣額度），
   *     也是誘因對齊：答不出的成本我們自己吸收，我們才有動機把知識庫做好。
   *
   * ⛔ 數的是「AI 出手幾次」，不是 LINE 訊息則數——一次回答可能拆成文字＋圖卡＋按鈕
   * 好幾則訊息，那仍然只算一則。（記帳看 `UsageDelta.billable`，不是 `answered`：
   * `answered` 是品質指標「AI 自己答完的比率」，兩者刻意分開，見 server/utils/ai-usage.ts。）
   *
   * null = 客製 / 面談（enterprise）；實際額度由訂閱層的 quotaOverride 指定。
   */
  answeredQuota: number | null
  /**
   * 月費（TWD，**含稅**）——這就是實際向信用卡請款的金額,也是電子發票的 TotalAmt。
   * 銷售額與稅額由此反推（見 shared/billing/tax.ts）。null = 客製報價。
   */
  priceMonthly: number | null
  /** 超量加購單價（TWD/則）。null = 不提供超量（免費層須升級；enterprise 走合約）。 */
  overagePerReply: number | null
  /** 團隊成員席次上限。null = 不限。 */
  seats: number | null
  /**
   * AI 知識量上限：**知識卡張數**（chunk 數），對外叫「AI 知識量 X 條」。
   *
   * 2026-09-07 老闆拍板從「知識庫幾份資料」改成「幾條」（`D-69`）。為什麼換單位：
   *   · 份數擋不住量——十份文件併成一個 PDF 就是「1 份」。
   *   · 份數會誤傷學習迴圈——手寫一張卡、採用一則 AI 建議，各自都會生一個 manual
   *     來源（見 knowledge/create.post.ts、suggestions/[id]/accept.post.ts），照份數算
   *     免費帳號傳完一份菜單就再也不能教 AI，而那是這個產品最重要的日常動作。
   *   · 條數天生對齊價值與成本，而且只要鎖 `createKnowledgeChunk` 一個入口就全鎖。
   *
   * null = 不限。「幾份資料」仍在來源列表顯示，但**不再是限制**。
   */
  knowledgeChunks: number | null
  /**
   * 數據報表等級。
   * ⚠️ 2026-10-19 `D-59` 收斂：**全站沒有任何地方照這一欄擋**（報表每個方案都看得到），
   *    所以官網、付款彈窗、條款都**不展示**它——不擋的東西寫成方案差異＝對客戶說了不存在的事。
   *    哪天真的要做報表分級，先做擋、再同時加回官網方案卡與付款彈窗。
   */
  reports: ReportTier
  /**
   * 推播（群發）等級——**真的會擋**：送出端 `broadcast-send.ts`、驗證／送出／排程端點都照它（`D-131`）。
   * 對外說法一律走下面的 `BROADCAST_TIER_CELL`／`broadcastTierSpec`／`broadcastLockText`，⛔ 別各頁自己造句。
   */
  broadcast: BroadcastTier
  /**
   * 腳本 / 流程自動化。
   * ⚠️ 2026-09-26 老闆拍板「**統一就都開放腳本功能**」：**所有方案都是 true**。
   *    起因＝開帳精靈的「加好友歡迎訊息」存成一條 follow 腳本，免費／輕量按「採用」會被
   *    `assertPlanAllows(planAllowsScripting)` 擋成 403——精靈承諾的東西兌現不了。
   *    欄位與閘門留著（之後若要重新收費分級，只改這裡的值），⛔ 但不要只把免費改回 false
   *    而不回頭看精靈：那一步會再次壞掉。
   */
  scripting: boolean
  /**
   * API 串接。
   * ⚠️ 2026-10-19 `D-59` 收斂：目前**沒有對外的 API 可用、也沒有地方照這一欄擋**，
   *    付款彈窗原本的「API」欄（檯面上四個方案整排「—」）已拿掉，理由同 `reports`。
   */
  api: boolean
  /** 客製方案（需業務報價 + 手動開通）；前端顯示「聯繫我們」而非「立即訂閱」。 */
  custom: boolean
  /** 僅供 super admin 直接指派（測試 / 內部帳號）；不對外顯示於方案頁 / 升級對話框、不可自助結帳。 */
  internal?: boolean
  /**
   * 售價未向 PAYUNi 申報：官網與後台升級對話框都不露出，也不可線上結帳
   * （API 層擋在 isCheckoutablePlan，2026-08-16 B-39 補的——只濾 UI 會被直接打 API 繞過）。
   *
   * ⚠️ 這不是產品決策而是金流合規:PAYUNi 特店申報的售價階段是 399 / 799 / 1499,
   * 風控會拿官網顯示的價格與申報資料互相核對,門面多出一個未申報的價格會被退件。
   * 若日後向 PAYUNi 補申報了更高階的售價,把這個旗標拿掉即可恢復露出。
   */
  landingHidden?: boolean
}

/**
 * 統一超量加購單價（TWD/則）；付費非客製方案共用，改這裡即全站生效。
 *
 * 2026-09-07 從 0.8 調到 1.5（`D-69`）：額度縮小後 0.8 會讓超量**永遠比升級便宜**
 * （輕量想多用 300 則＝399＋240＝639 < 入門 799），客人就永遠卡在低階方案。
 * 1.5 讓「偶爾超一點不心痛、長期超量比升級貴」，階梯才推得動人。
 */
export const OVERAGE_PER_REPLY_TWD = 1.5

/**
 * 方案由低到高的排序，供顯示與升降級比較用。
 * 這份陣列與 BILLING_PLANS 的 key 必須一致（見檔尾的 dev 自我檢查）。
 */
export const BILLING_PLAN_ORDER: BillingPlanId[] = ['free', 'lite', 'starter', 'growth', 'pro', 'enterprise', 'test', 'internal']

/**
 * 檯面上主打的方案。官網定價區、商品資訊售價列、後台升級對話框的方案目錄**都吃這一份**。
 *
 * 為什麼放這裡：這份清單原本只寫在首頁頁面層級，升級對話框沒跟到——2026-08-17
 * 老闆抓到付款彈窗仍列出 799／1,499。凡是「對客戶展示的方案目錄」一律引用這個常數，
 * 不要再各頁自己維護一份。
 *
 * 沿革：2026-08-14 老闆拍板「先隱藏就好，目前只 show 399」＝ ['free', 'lite']；
 * 2026-09-04 老闆改口「定價區要呈現免費／399／799／1,499」，四個方案全部回到檯面上
 * （`D-14` 的「只 show 399」到此結束，這裡不留舊值以免兩種說法並存）。
 *
 * ⛔ 跟 `landingHidden` 是兩回事，不要互相借用：那個旗標＝「售價未申報，合規上不可
 *    露出也不可收費」；這份清單＝「申報過、收得到，但行銷上現在主不主打」。
 *    專業版 4,990 是前者（未申報），永遠不能靠加進這份清單來露出。
 */
export const FEATURED_PLAN_IDS: BillingPlanId[] = ['free', 'lite', 'starter', 'growth']

/** 未訂閱 / 找不到方案時的預設：每個帳號自動享有的免費額度。 */
export const DEFAULT_BILLING_PLAN_ID: BillingPlanId = 'free'

/**
 * 方案目錄。改價 / 改額度 / 調功能界線只改這裡。
 */
export const BILLING_PLANS: Record<BillingPlanId, BillingPlan> = {
  free: {
    id: 'free',
    name: '免費',
    // 50 而不是 200：免費與 399 同量的話，付 399 只多買到一個席次，付費方案賣不動。
    // 50 則＝每天 1–2 個客人提問，夠體驗「AI 真的會回」但不夠拿來營運。
    answeredQuota: 50,
    priceMonthly: 0,
    overagePerReply: null, // 撞頂 → 引導升級，不開放加購
    seats: 1,
    knowledgeChunks: 50,
    reports: 'basic',
    broadcast: 'none',
    scripting: true,
    api: false,
    custom: false,
  },
  lite: {
    id: 'lite',
    name: '輕量',
    answeredQuota: 200,
    priceMonthly: 399,
    overagePerReply: OVERAGE_PER_REPLY_TWD,
    seats: 2,
    knowledgeChunks: 200,
    reports: 'basic',
    broadcast: 'basic',
    scripting: true,
    api: false,
    custom: false,
  },
  starter: {
    id: 'starter',
    name: '入門',
    answeredQuota: 500,
    priceMonthly: 799,
    overagePerReply: OVERAGE_PER_REPLY_TWD,
    seats: 3,
    knowledgeChunks: 500,
    reports: 'basic',
    broadcast: 'basic',
    scripting: true,
    api: false,
    custom: false,
  },
  growth: {
    id: 'growth',
    name: '成長',
    answeredQuota: 1_500,
    priceMonthly: 1_499,
    overagePerReply: OVERAGE_PER_REPLY_TWD,
    seats: 5,
    knowledgeChunks: 1_500,
    reports: 'advanced',
    broadcast: 'advanced',
    scripting: true,
    api: false,
    custom: false,
  },
  pro: {
    id: 'pro',
    name: '專業',
    answeredQuota: 6_000,
    priceMonthly: 4_990,
    overagePerReply: OVERAGE_PER_REPLY_TWD,
    seats: 10,
    knowledgeChunks: 6_000,
    reports: 'advanced',
    broadcast: 'advanced',
    scripting: true,
    api: true,
    custom: false,
    landingHidden: true, // 4,990 未向 PAYUNi 申報，先不在官網露出（見 landingHidden 說明）
  },
  enterprise: {
    id: 'enterprise',
    name: '企業',
    answeredQuota: null, // 30,000+ 客製，實際額度走訂閱層 quotaOverride
    priceMonthly: null, // 面談
    overagePerReply: null, // 走合約
    seats: null,
    knowledgeChunks: null,
    reports: 'export',
    broadcast: 'advanced',
    scripting: true,
    api: true,
    custom: true,
  },
  // ── 內部方案:僅 super admin 指派,不對外顯示、不可自助結帳。額度 null = 無上限。 ──
  test: {
    id: 'test',
    name: '測試（無限）',
    answeredQuota: null,
    priceMonthly: 0,
    overagePerReply: null,
    seats: null,
    knowledgeChunks: null,
    reports: 'export',
    broadcast: 'advanced',
    scripting: true,
    api: true,
    custom: false,
    internal: true,
  },
  internal: {
    id: 'internal',
    name: '內部（無限）',
    answeredQuota: null,
    priceMonthly: 0,
    overagePerReply: null,
    seats: null,
    knowledgeChunks: null,
    reports: 'export',
    broadcast: 'advanced',
    scripting: true,
    api: true,
    custom: false,
    internal: true,
  },
}

// ═══════════════════════════════════════════════════════════════════
//  訂閱（掛在 WorkspaceDoc.subscription，見開發清單 A2）
//  Phase 1 由 super admin 手動開通；Phase 2 起接金流 webhook 自動維護。
// ═══════════════════════════════════════════════════════════════════

/** 訂閱狀態。 */
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled'

export interface WorkspaceSubscription {
  planId: BillingPlanId
  status: SubscriptionStatus
  /**
   * 本期起訖（YYYY-MM-DD，**起訖皆含當日**）；則數額度以「本期」為單位重置。
   * 週期由錨定日決定（見 shared/time.ts），不是日曆月。
   */
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  /**
   * 錨定日（1–31）：客戶開始訂閱的那一天,每期都在這天續期。
   * 單獨存起來而不從 currentPeriodStart 反推,是為了讓「錨定日 31」經過 2 月被夾成 28 之後
   * 還能回到 31,不會一路往前漂（見 shared/time.ts anchoredPeriod）。
   *
   * 也是藍新定期定額的 `PeriodPoint`（每月幾號扣款）——藍新對短月的夾法與我們相同,
   * 兩邊的「續期日」因此永遠對得起來。
   */
  anchorDay?: number
  /**
   * @deprecated 藍新定期定額的委託單號（PeriodNo）。**藍新定期定額程式已於 2026-07-30 移除**
   * （它從未真正開通:`recurringEnabled` 一律 false + 金鑰未設 → 不存在真實委託）。
   * 欄位保留只為讓萬一存在的歷史文件仍能通過型別檢查,**不要在新程式碼裡讀寫它**。
   * 現行自動扣款看 {@link payuniCardToken}。
   */
  periodNo?: string
  /** @deprecated 同 {@link periodNo}——藍新遺留,勿使用。 */
  periodOrderNo?: string
  /**
   * PAYUNi 信用卡**約定 Token**（`CreditHash`）——目前使用中的自動扣款模型。
   *
   * 有值 = 這張卡已同意約定,我方每期可拿它打 `/api/credit` 幕後扣款、**金額每期自訂**
   * （折抵／降級只是這期少扣一點）。與藍新的 `periodNo` 語意不同:藍新是「金流按它自己的
   * 排程扣固定金額」,PAYUNi 是「我方主動扣、金額我方決定」——失敗方向因此更安全
   * （排程掛掉 = 這期沒扣到,不會變成「服務停了卡還在扣」）。
   *
   * ⚠️ 這是敏感憑證:**不得**外洩到前端（buildPlanView 只回布林 hasMandate 與末四碼）。
   */
  payuniCardToken?: string
  /** 約定卡末四碼（`Card4No`）——UI 顯示「扣款卡 •••• 1234」用,非憑證。 */
  payuniCardLast4?: string
  /** 約定卡有效期（`CreditLife`,MMYY）。卡過期前可據此提醒客戶換卡。 */
  payuniCardExpiry?: string
  /**
   * 是否自動續訂（背後有生效中的定期定額委託）。
   *
   * ⚠️ 這個旗標會改變「到期」的處理：**自動續訂的訂閱到期不會立刻降級**,而是進入
   * past_due 寬限期等藍新的扣款通知（藍新是在錨定日當天才扣款,通知可能晚幾小時才到;
   * 若一到期就降級,客戶每個月都會斷線幾小時）。見 period.ts 的 GRACE_DAYS。
   */
  autoRenew?: boolean
  /**
   * 客戶已按下取消,但保留到本期結束（訂閱制的標準做法:取消不是立刻斷）。
   * 期末 roll 時直接降回免費層,不走寬限期。
   */
  cancelAtPeriodEnd?: boolean
  /**
   * 已排程於**期末生效**的方案變更（降級用；見 shared/billing/recurring.ts）。
   *
   * 降級不立即換方案——客戶已經付了這一期的錢,剩餘天數不該蒸發。按下降級只寫這個欄位,
   * 期末續扣時才以它為準扣款並開通,然後清掉。null / 與 planId 相同 = 沒有排程變更。
   *
   * ⚠️ 只有「背後有自動續扣」的訂閱才有意義:單次付款沒有期末扣款那一刻,排了也不會生效。
   */
  pendingPlanId?: BillingPlanId | null
  /**
   * 可折抵下期扣款的餘額（含稅元,整數）。
   *
   * 用途:升級／異動的差額退費**改成折抵下期**而不退現金（老闆 2026-07-29 拍板）——
   * 避開退款 API 與發票折讓,稅務上乾淨:折抵是「下期少收錢」,下期發票就開少收後的實收
   * 金額,原發票完全不動。可累積、逐期折到用完。
   */
  creditBalance?: number
  /**
   * ── 每期自動續扣的狀態（PAYUNi Token 模型；由 chargeDueRecurring 維護）───────
   *
   * `lastChargeDate` 同時扮演兩個角色，都很關鍵：
   *   ① **每日只重試一次**的節流（寬限期 3 天 → 最多 3~4 次，不會打爆客戶的卡）。
   *   ② **併發搶鎖**：排程與 middleware tick 可能同時跑,claim 時在 transaction 內把它
   *      寫成今天,另一路就會看到「今天已試過」而跳過 → 不會重複扣款。
   */
  lastChargeDate?: string | null
  /** 本期已嘗試扣款次數（搭配 chargePeriodStart 判斷是否要歸零）。 */
  chargeAttempts?: number
  /** chargeAttempts 屬於哪一期（= 當時的 currentPeriodStart）；換期即歸零。 */
  chargePeriodStart?: string | null
  /** 最後一次扣款失敗的原因（PAYUNi Message）；成功續扣後清掉。給客戶與客服看。 */
  lastChargeError?: string | null
  /** 例外額度：覆蓋方案預設則數（企業客製 / 業務談定的特例）。 */
  quotaOverride?: number | null
  /** 內部備註（開通原因、合約號等），不對客戶顯示。 */
  note?: string
  /**
   * 已寄過「續扣前提醒」信的那一期（值 = 寄送當下的 currentPeriodEnd）。
   * 續扣提醒由每日對帳寄，靠這個欄位防止同一期每天重寄。
   */
  renewalReminderSentFor?: string | null
  /**
   * 已寄過額度通知信的「本期起日:類型」（例 `2026-07-20:near`）。
   * 額度信由每日對帳寄，靠這個防止同期同門檻重寄；near→over 會因值不同而各寄一次。
   */
  quotaEmailSentFor?: string | null
  /**
   * 已寄出「自動扣款失敗」信的那一期（值 = 當期 currentPeriodStart；`B-49`）。
   * 以前首次失敗寄一封、寄失敗也沒人知道；現在寄成功才記，沒記到的由每日對帳補寄。
   */
  chargeFailedEmailSentFor?: string | null
  /** 上面那期其實沒寄：找不到帳務信箱（超管清單要分得出「寄了」跟「沒有信箱可寄」） */
  chargeFailedEmailNoRecipientFor?: string | null
  /**
   * 各種帳務信「寄失敗、還在重試」的紀錄（`B-49`）。寄成功的不會留在這裡（那種記在各自的 SentFor）。
   * 規則（冷卻、上限）在 shared/billing/email-retry.ts。⚠️ 寫入一律走點狀路徑
   * `subscription.emailAttempts.<種類>`，不可整包覆寫訂閱。
   */
  emailAttempts?: {
    renewal?: EmailAttempt
    quota?: EmailAttempt
    chargeFailed?: EmailAttempt
    downgrade?: EmailAttempt
  }
  /**
   * 因為自動扣款一直沒成功（寬限期滿）被降回免費方案的紀錄（`B-16`）。
   * 由每日對帳在「真的降級落地」那一刻寫入（payment.ts runPaymentReconcile），
   * 「已降回免費」通知信照它寄、超管扣款失敗清單與帳單頁照它講「哪天、從哪個方案降下來」。
   * 客戶重新付款開通時整份訂閱重建，這筆會跟著消失。
   */
  nonPaymentDowngrade?: {
    /** 降級前的方案 */
    fromPlanId: BillingPlanId
    /** 降級落地的那一天（台北日期） */
    on: string
    /** 通知信處理完了沒（寄成功，或根本沒有帳務信箱可寄，才標 true） */
    emailSent: boolean
    /** true＝其實沒寄：找不到帳務信箱 */
    noRecipient?: boolean
  } | null
}

// ── helpers ────────────────────────────────────────────────────────

/** 取方案；未知 / 缺省 ID 一律退回免費層（永遠不會回 undefined）。 */
export function getBillingPlan(id: string | null | undefined): BillingPlan {
  return BILLING_PLANS[(id ?? '') as BillingPlanId] ?? BILLING_PLANS[DEFAULT_BILLING_PLAN_ID]
}

/**
 * 本方案實際生效的月額度：優先用訂閱層 quotaOverride（例外 / 企業客製），
 * 否則用方案預設；兩者皆無（客製未設）回 null = 不設額度上限。
 */
export function effectiveAnsweredQuota(plan: BillingPlan, quotaOverride?: number | null): number | null {
  if (quotaOverride != null) return quotaOverride
  return plan.answeredQuota
}

/**
 * 是否為「客戶自己刷卡買得到」的付費方案（lite / starter / growth / pro）。
 *
 * 只有這種方案到期沒續費才會自動降回免費層。免費層本來就不會過期；
 * enterprise（走合約）與 test / internal（super admin 指派）由人管理,不該被排程自動降級。
 */
export function isSelfServePaidPlan(id: BillingPlanId): boolean {
  const p = BILLING_PLANS[id]
  return !!p && !p.internal && !p.custom && p.priceMonthly != null && p.priceMonthly > 0
}

/**
 * 是否開放**線上結帳／排程改期**的方案 = isSelfServePaidPlan 再排除 `landingHidden`。
 *
 * ⚠️ 兩者不能混用：landingHidden（pro 4,990）是「售價未向 PAYUNi 申報,不可收費」,
 * 但已在此方案上的訂閱到期仍要正常降級、續扣邏輯也照舊——所以到期／降級判斷用
 * isSelfServePaidPlan,**收錢入口**（建單、預約期末變更）用這支。
 * 2026-08-16 稽核（B-39）抓到 UI 有濾但 API 沒擋:繞過畫面直接打建單端點仍能刷 4,990。
 */
export function isCheckoutablePlan(id: BillingPlanId): boolean {
  const p = BILLING_PLANS[id]
  return isSelfServePaidPlan(id) && !p.landingHidden
}

// ── 方案功能閘門（2026-09-07 `D-69` 拍板④：這些權益以前只印在方案表上，後端零攔截）──
//
// ⚠️ 純函式放這裡是刻意的：前端用同一份判斷把買不到的功能**藏起來**，後端用同一份判斷
//    擋 API。只擋後端會變成「看得到卻 403」（違反 shared/permissions.ts 的既有政策），
//    只濾前端則直接打 API 就繞過（2026-08-16 `B-39` 已經踩過一次）。

/** 群發等級高低（none < basic < advanced），供 `planAllowsBroadcast` 比較。 */
const BROADCAST_TIER_LEVEL: Record<BroadcastTier, number> = { none: 0, basic: 1, advanced: 2 }

/** 報表等級高低（basic < advanced < export），供 `planAllowsReport` 比較。 */
const REPORT_TIER_LEVEL: Record<ReportTier, number> = { basic: 0, advanced: 1, export: 2 }

/** 這個方案的推播權限是否達到 `min` 等級。`advanced` = 分眾（標籤／受眾／匯入名單）。 */
export function planAllowsBroadcast(plan: BillingPlan, min: BroadcastTier): boolean {
  return BROADCAST_TIER_LEVEL[plan.broadcast] >= BROADCAST_TIER_LEVEL[min]
}

/** 這個方案的報表權限是否達到 `min` 等級。 */
export function planAllowsReport(plan: BillingPlan, min: ReportTier): boolean {
  return REPORT_TIER_LEVEL[plan.reports] >= REPORT_TIER_LEVEL[min]
}

// ── 推播分級的對外說法（`D-131`，2026-10-19 拍板照建議做）─────────────────────────
//
// 以前後端真的擋（免費不能發、輕量／入門不能分眾），但官網方案卡、付款彈窗、條款都沒寫，推播頁也沒鎖——
// 輕量方案的人排好一則依標籤的推播，按送出（或到了排程時間）才失敗。
// ⛔ 下面幾句是**唯一的說法**：官網方案卡、付款彈窗、條款、推播頁鎖住時的說明、驗證視窗、
//    送出／排程被擋、排程到時間才被擋（方案中途降級），全部用這幾支，別各處自己造句。

/**
 * 這種發送對象要哪一級。全部好友＝`basic`；依標籤、匯入名單、受眾＝`advanced`（分眾）。
 * ⛔ 跟送出端同一條規則（`broadcast-send.ts` 照 `audienceSource.type !== 'all'` 判），別另寫一份。
 */
export function broadcastTierNeededFor(audienceType: string | null | undefined): BroadcastTier {
  return audienceType === 'all' ? 'basic' : 'advanced'
}

/** 方案能不能發這種發送對象（前端鎖選項、後端擋端點都用這一支）。 */
export function tierAllowsAudience(tier: BroadcastTier, audienceType: string | null | undefined): boolean {
  return BROADCAST_TIER_LEVEL[tier] >= BROADCAST_TIER_LEVEL[broadcastTierNeededFor(audienceType)]
}

/** 付款彈窗方案表的「推播」欄（欄名已經是「推播」，格子裡只寫發得到誰）。 */
export const BROADCAST_TIER_CELL: Record<BroadcastTier, string> = {
  none: '—',
  basic: '全部好友',
  advanced: '全部好友＋分眾',
}

/** 「分眾」是什麼：付款彈窗「推播」欄名旁的 ⓘ。字跟推播頁的兩個選項同名，客人在那一頁找得到。 */
export const BROADCAST_SEGMENT_HINT = '分眾＝在推播頁用「依標籤篩選」或「匯入名單」挑人發，只發給挑出來的人。'

/** 官網方案卡的那一列（跟付款彈窗那一格同一組字，只是卡片上沒有欄名，要自己帶「推播：」）。 */
export function broadcastTierSpec(tier: BroadcastTier): string {
  return tier === 'none' ? '不含推播' : `推播：${BROADCAST_TIER_CELL[tier]}`
}

/**
 * 檯面上（`FEATURED_PLAN_IDS`）最便宜、而且推播達到這一級的方案名。
 * 讀方案表導出來，不寫死「成長」：哪天改了分級，鎖住時講的方案名跟著對。
 */
export function lowestFeaturedPlanNameForBroadcast(tier: BroadcastTier): string | null {
  const hit = BILLING_PLAN_ORDER
    .filter(id => FEATURED_PLAN_IDS.includes(id))
    .map(id => BILLING_PLANS[id])
    .find(p => BROADCAST_TIER_LEVEL[p.broadcast] >= BROADCAST_TIER_LEVEL[tier])
  return hit?.name ?? null
}

/**
 * 推播頁鎖住時的那一句，也是驗證視窗、送出／排程被擋、排程到時間被擋時的原因。null＝這一級沒有被鎖的東西。
 *
 * ⛔ **不寫目前是哪個方案**：推播頁客服（agent）也進得去，而方案名屬於計費資訊（`G-103`）——
 *    只講「目前的方案」＋「要哪個方案以上」，兩件事就夠他決定改對象或找管理員升級。
 */
export function broadcastLockText(tier: BroadcastTier): string | null {
  if (tier === 'none') {
    const need = lowestFeaturedPlanNameForBroadcast('basic')
    return `目前的方案不能發推播${need ? `，要${need}以上的方案才能發` : ''}。`
  }
  if (tier === 'basic') {
    const need = lowestFeaturedPlanNameForBroadcast('advanced')
    return `目前的方案只能發給全部好友；依標籤篩選、匯入名單${need ? `要${need}以上的方案才能用` : '暫不開放'}。`
  }
  return null
}

/** 這個方案發這種對象會被擋的話回那一句（同 `broadcastLockText`），發得了回 null。 */
export function broadcastPlanBlockReason(tier: BroadcastTier, audienceType: string | null | undefined): string | null {
  return tierAllowsAudience(tier, audienceType) ? null : broadcastLockText(tier)
}

/**
 * `C-352`①：**帶著發送對象進推播頁的入口**（好友頁「推播給這 N 位」、好友統計「發推播給這群」、
 * 檔期「為這一檔擬推播」、活動精靈「順手留一張推播草稿」、小幫手擬草稿）在入口就先問這一支：
 * 這個方案發不了那種對象 → 回推播頁鎖住時**同一句**（`broadcastLockText`），入口當場講、按鈕鎖住；
 * 發得了、或讀不到方案（`null`＝fail-open，同推播頁與送出端）→ 回 null。
 *
 * ⛔ 入口一律「鎖住＋講原因」，**不改成發給全部好友**：這幾個入口帶的就是那群人（勾的人、那顆標籤），
 *    換成全部好友＝換了收件人（例如只給 VIP 的優惠發給所有人），要他自己決定；
 *    進了推播頁才發現送不出去，整則推播就白寫了。
 *    唯一例外是檔期：那一顆按鈕要的是文案，標籤只是 MiniMe 的建議——方案不能分眾時不帶標籤（`marketing-calendar/draft`），
 *    所以檔期問的是 `'all'`（只有免費方案會鎖）。
 */
export function broadcastEntryLockText(
  tier: BroadcastTier | null | undefined,
  audienceType: string | null | undefined,
): string | null {
  return tier ? broadcastPlanBlockReason(tier, audienceType) : null
}

/** 檯面上的方案照推播等級分組（下面那句照它寫，跟方案卡同一份來源）。 */
export function featuredPlanNamesByBroadcastTier(): Record<BroadcastTier, string[]> {
  const out: Record<BroadcastTier, string[]> = { none: [], basic: [], advanced: [] }
  for (const id of BILLING_PLAN_ORDER) {
    if (!FEATURED_PLAN_IDS.includes(id)) continue
    const p = BILLING_PLANS[id]
    out[p.broadcast].push(p.name)
  }
  return out
}

/**
 * 各方案的推播一句話講完（條款「推播」那一條、`/product-info`）：
 * 「免費方案不含推播；輕量、入門方案可推播給全部好友；成長方案另可依標籤篩選或匯入名單挑人發（分眾）。」
 * 照方案表導出來，跟方案卡同一組詞（不含推播／全部好友／分眾）。⛔ 別在頁面上寫死方案名。
 */
export function broadcastTierSummary(): string {
  const g = featuredPlanNamesByBroadcastTier()
  const names = (list: string[]) => list.join('、')
  const parts: string[] = []
  if (g.none.length) parts.push(`${names(g.none)}方案不含推播`)
  if (g.basic.length) parts.push(`${names(g.basic)}方案可推播給全部好友`)
  if (g.advanced.length) parts.push(`${names(g.advanced)}方案另可依標籤篩選或匯入名單挑人發（分眾）`)
  return parts.length ? `${parts.join('；')}。` : ''
}

/**
 * 這個方案能不能用腳本／流程自動化。
 * 2026-09-26 起所有方案都開放（舊註解寫「免費與輕量沒有」已過期）；函式留著是為了日後要再分級時只改方案表。
 */
export function planAllowsScripting(plan: BillingPlan): boolean {
  return plan.scripting
}

/**
 * 撞到上限時給客人看的話。**要講三件事**：現在幾個、上限幾個、怎麼解決。
 * 只寫「已達上限」的話客人只能來問客服（`C-94` 那次的教訓：沒說清楚就等於沒說）。
 */
export function planLimitMessage(what: string, used: number, limit: number, planName: string, unit = ''): string {
  // 量詞要帶上（「50／50 條」）：知識量一次加一條撞上限時，跟一批撞上限那句（「目前 50 條…上限 50 條」）講同一種話
  return `${what}已達${planName}方案上限（${used}／${limit}${unit ? ` ${unit}` : ''}）。刪掉不需要的，或升級方案以取得更多額度。`
}

// dev 自我檢查：BILLING_PLAN_ORDER 必須剛好涵蓋 BILLING_PLANS 的所有 key。
if (import.meta.dev && BILLING_PLAN_ORDER.length !== Object.keys(BILLING_PLANS).length) {
  console.warn('[billing] BILLING_PLAN_ORDER 與 BILLING_PLANS 的方案數不一致，請同步更新。')
}
