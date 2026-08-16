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
   * 每月 AI 回覆則數額度（對應 aiUsage 的 answered 計數）。
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
  /** 知識庫來源數上限。null = 不限。 */
  knowledgeSources: number | null
  /** 數據報表等級。 */
  reports: ReportTier
  /** 群發 / 分眾行銷等級。 */
  broadcast: BroadcastTier
  /** 腳本 / 流程自動化。 */
  scripting: boolean
  /** API 串接。 */
  api: boolean
  /** 客製方案（需業務報價 + 手動開通）；前端顯示「聯繫我們」而非「立即訂閱」。 */
  custom: boolean
  /** 僅供 super admin 直接指派（測試 / 內部帳號）；不對外顯示於方案頁 / 升級對話框、不可自助結帳。 */
  internal?: boolean
  /**
   * 不在「官網門面定價區」露出（後台升級對話框仍可見、仍可自助結帳）。
   *
   * ⚠️ 這不是產品決策而是金流合規:PAYUNi 特店申報的售價階段是 399 / 799 / 1499,
   * 風控會拿官網顯示的價格與申報資料互相核對,門面多出一個未申報的價格會被退件。
   * 若日後向 PAYUNi 補申報了更高階的售價,把這個旗標拿掉即可恢復露出。
   */
  landingHidden?: boolean
}

/** 統一超量加購單價（TWD/則）；付費非客製方案共用，改這裡即全站生效。 */
export const OVERAGE_PER_REPLY_TWD = 0.8

/**
 * 方案由低到高的排序，供顯示與升降級比較用。
 * 這份陣列與 BILLING_PLANS 的 key 必須一致（見檔尾的 dev 自我檢查）。
 */
export const BILLING_PLAN_ORDER: BillingPlanId[] = ['free', 'lite', 'starter', 'growth', 'pro', 'enterprise', 'test', 'internal']

/** 未訂閱 / 找不到方案時的預設：每個帳號自動享有的免費額度。 */
export const DEFAULT_BILLING_PLAN_ID: BillingPlanId = 'free'

/**
 * 方案目錄。改價 / 改額度 / 調功能界線只改這裡。
 */
export const BILLING_PLANS: Record<BillingPlanId, BillingPlan> = {
  free: {
    id: 'free',
    name: '免費',
    answeredQuota: 200,
    priceMonthly: 0,
    overagePerReply: null, // 撞頂 → 引導升級，不開放加購
    seats: 1,
    knowledgeSources: 1,
    reports: 'basic',
    broadcast: 'none',
    scripting: false,
    api: false,
    custom: false,
  },
  lite: {
    id: 'lite',
    name: '輕量',
    answeredQuota: 700,
    priceMonthly: 399,
    overagePerReply: OVERAGE_PER_REPLY_TWD,
    seats: 2,
    knowledgeSources: 2,
    reports: 'basic',
    broadcast: 'basic',
    scripting: false,
    api: false,
    custom: false,
  },
  starter: {
    id: 'starter',
    name: '入門',
    answeredQuota: 1_300,
    priceMonthly: 799,
    overagePerReply: OVERAGE_PER_REPLY_TWD,
    seats: 3,
    knowledgeSources: 5,
    reports: 'basic',
    broadcast: 'basic',
    scripting: true,
    api: false,
    custom: false,
  },
  growth: {
    id: 'growth',
    name: '成長',
    answeredQuota: 3_500,
    priceMonthly: 1_499,
    overagePerReply: OVERAGE_PER_REPLY_TWD,
    seats: 5,
    knowledgeSources: 10,
    reports: 'advanced',
    broadcast: 'advanced',
    scripting: true,
    api: false,
    custom: false,
  },
  pro: {
    id: 'pro',
    name: '專業',
    answeredQuota: 10_000,
    priceMonthly: 4_990,
    overagePerReply: OVERAGE_PER_REPLY_TWD,
    seats: 10,
    knowledgeSources: null,
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
    knowledgeSources: null,
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
    knowledgeSources: null,
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
    knowledgeSources: null,
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

// dev 自我檢查：BILLING_PLAN_ORDER 必須剛好涵蓋 BILLING_PLANS 的所有 key。
if (import.meta.dev && BILLING_PLAN_ORDER.length !== Object.keys(BILLING_PLANS).length) {
  console.warn('[billing] BILLING_PLAN_ORDER 與 BILLING_PLANS 的方案數不一致，請同步更新。')
}
