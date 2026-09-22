/**
 * 店家輪廓（store profile）＝ MiniMe 對「這家店是誰」的認識。
 *
 * ── 為什麼需要這個東西（`D-85`）───────────────────────────────
 * 在這之前，MiniMe 對一家店的全部認知是：帳號名字、LINE 金鑰、買了哪個方案，
 * 加上 `aiSettings.systemPrompt` 那一段要商家自己面對的空白文字。
 * 於是節慶提醒只能講跨產業通用的一句（`shared/taiwan-festivals.ts` 的 `angle`
 * 檔頭就寫著「客製到商家自己的商品是 Phase 2」），推播建議、行銷月曆通通做不出來——
 * **缺的不是功能是輸入**。這份輪廓就是那個輸入。
 *
 * ── 三條鐵律（改這個檔之前先讀）─────────────────────────────
 * ① **每一格都要說得出「這是誰說的」**：`source` 分 owner／ai／conversation。
 *    AI 猜的必須看得出是猜的——猜錯不可怕，假裝確定才可怕。
 * ② **「還沒有」與「找過但沒有」是兩件事**，分開存（`missing` 欄位）。
 *    「競爭對手：還沒有人填」跟「競爭對手：讀了 5 頁網站都沒提到」對使用者是兩種意思，
 *    合成一種就是 [[feedback_filters_must_report_what_they_dropped]] 那條沉默死亡。
 * ③ **商家改過的永遠贏**：`ownerEdited` 為真的欄位，AI 重讀網站時一律不覆蓋。
 *
 * ⛔ 多租戶：這裡只放「欄位長什麼樣」，不放任何特定客戶的產業或商品
 *    （[[feedback_saas_no_tenant_hardcoding]]）。選項表是跨產業通用的。
 */

import type { FieldValue, Timestamp } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════
//  Collection: storeProfiles
//  Doc ID: workspaceId（與 aiSettings 同一種擺法：一個工作區一份）
// ═══════════════════════════════════════════════════════════════════

/** 輪廓的九個欄位。⛔ 加欄位要同時補 `STORE_PROFILE_FIELDS`，那張表是唯一來源。 */
export type StoreProfileFieldId =
  | 'industry'
  | 'products'
  | 'customers'
  | 'channel'
  | 'season'
  | 'tone'
  | 'faq'
  | 'rivals'
  | 'pain'

/**
 * 這一格的值是誰給的。
 * - `owner`：商家自己答的或改的 —— 最高權重，AI 永遠不覆蓋
 * - `ai`：AI 讀網站猜的 —— 畫面上必須標「AI 推測」
 * - `conversation`：從實際對話統計出來的 —— 例如「客人最常問的事」
 */
export type StoreProfileSource = 'owner' | 'ai' | 'conversation'

/** 「沒有值」的三種分型。⛔ 不可以合併成一個布林。 */
export type StoreProfileMissing =
  /** 從來沒有人給過值（預設狀態） */
  | 'never_asked'
  /** AI 去找過了，但來源裡沒有這項資訊（例：網站沒提競爭對手） */
  | 'not_in_source'
  /** 這一項要等資料累積（例：還沒有對話，就沒有「客人最常問的事」） */
  | 'needs_data'

export interface StoreProfileField {
  /** 值。空字串＝沒有值，這時 `missing` 說得出是哪一種沒有 */
  value: string
  source: StoreProfileSource
  /** 沒有值時，是哪一種沒有（有值時為 undefined） */
  missing?: StoreProfileMissing
  /**
   * 商家親手改過。⛔ 為真時 AI 重讀網站一律跳過這一格——
   * 不然商家改完、下次同步又被 AI 蓋回去，而且畫面上沒有任何線索。
   */
  ownerEdited?: boolean
  /** 最後更新（epoch ms）。存在 map 裡刻意不用 Timestamp：巢狀 Timestamp 讀回來要逐層轉 */
  updatedAt: number
}

/** 讀網站的結果。三態要講得出來，所以它是一個物件不是一個布林。 */
export type SiteReadStatus =
  /** 要讀的頁都讀到了 */
  | 'ok'
  /** 讀到一部分（有些頁抓不到、或撞到頁數上限） */
  | 'partial'
  /** 一頁都沒讀到 */
  | 'failed'

export type SiteReadFailReason =
  | 'blocked' // 對方擋了我們（403 / robots.txt 不允許）
  | 'not_found' // 404 / 網址打錯
  | 'timeout' // 太久沒回應
  | 'empty' // 抓得到頁面但幾乎沒有文字（多半是要跑 JS 才長出來的網站）
  /**
   * 這個網址根本不是網頁（PDF、圖片…）。
   * ⚠️ 2026-09-22 端到端實測抓到的：原本跟 `empty` 合成一種，於是貼了 PDF 網址的人
   * 會被告知「多半是要跑程式才長得出內容的網站，請改貼商品頁」——**下一步是錯的**。
   * ⛔ 兩種原因的解法不同（動態站要換網址；PDF 直接上傳知識庫就好），不可以合併。
   */
  | 'not_html'
  | 'too_large' // 超過抓取上限
  | 'network' // 連不上
  | 'unknown'

export interface SiteReadResult {
  status: SiteReadStatus
  /** 真的讀到內容的頁數 */
  pagesRead: number
  /** 試著讀、但沒讀到的頁（要講得出來是哪幾頁、為什麼） */
  pagesFailed: { url: string, reason: SiteReadFailReason }[]
  /** 一頁都沒讀到時的總體原因 */
  reason?: SiteReadFailReason
  /** 讀取當下的時間（epoch ms） */
  at: number
}

export interface StoreProfileDoc {
  fields: Partial<Record<StoreProfileFieldId, StoreProfileField>>
  /**
   * 商家給的官網／商品頁網址（AI 就是去讀這個）。
   * ⚠️ 跟 `aiSettings.shopUrl` **不是同一個欄位**：那個是「AI 回答客人時要附的購買連結」，
   * 會被原樣發給客人（`ai-answer.ts`）。兩者九成情況是同一個網址，所以精靈問到之後
   * 會在 `shopUrl` **是空的時候**幫忙填一次（只填空、不覆蓋），⛔ 不做雙向同步——
   * 兩個欄位互相蓋是 [[project_unread_dot_two_clocks_20260811]] 那種兩本帳。
   */
  siteUrl: string
  /** 最後一次讀網站的結果；沒讀過就是 undefined */
  siteRead?: SiteReadResult
  /**
   * 上次在週報裡問「要不要更新輪廓」的時間（epoch ms，`C-226`）。
   * ⛔ 一定要記：不記的話每週都會問同一件事，兩週後就被當成雜訊直接忽略。
   */
  refreshAskedAt?: number
  createdAt?: Timestamp | FieldValue
  updatedAt?: Timestamp | FieldValue
}

// ── 欄位定義表（單一事實來源）──────────────────────────────────

export interface StoreProfileFieldDef {
  id: StoreProfileFieldId
  /** 輪廓卡上的欄位名 */
  label: string
  /**
   * 開通精靈問這一題時的問法。`null` = 精靈不問
   * （這些欄位靠 AI 讀網站或從對話累積，問了商家也答不好）。
   */
  question: string | null
  /** 精靈問這一題時排第幾（1 起算）；`null` = 不問 */
  askStep: number | null
  /** 有選項＝按鈕題；沒有＝打字題 */
  options?: readonly string[]
  /** 打字題的輸入提示 */
  placeholder?: string
  /** AI 讀網站時可以推測這一項嗎 */
  aiCanGuess: boolean
  /** 沒有值時，卡片上要講的那句話（依 missing 分型別選字用 `describeMissing`） */
  emptyHint: string
  /** 給 LLM 的說明：這一格要填什麼（讀網站抽資料時用） */
  aiHint: string
}

/**
 * 九個欄位的定義。**順序就是輪廓卡上的順序**，⛔ 不另外加 `order` 欄位
 * （那會變成兩份順序，`C-210` 教學順序踩過同一個坑）。
 *
 * 精靈只問五題（`askStep` 1–5）：問太多人就跑了。其餘四項由 AI 讀網站猜、
 * 或等對話累積——**商家答不出來的題目不要問**。
 */
export const STORE_PROFILE_FIELDS: readonly StoreProfileFieldDef[] = [
  {
    id: 'industry',
    label: '產業與品類',
    question: '你的店主要是哪一種？',
    askStep: 1,
    options: ['餐飲／飲料', '零售／電商', '美容／美業', '教育／課程', '服務／預約', '醫療／健康', '旅遊／住宿', '其他'],
    aiCanGuess: true,
    emptyHint: '還不知道你是哪一行',
    aiHint: '這家店屬於哪一種產業或品類，用一個短詞（例：手搖飲、女裝電商、美髮沙龍）',
  },
  {
    id: 'products',
    label: '主打商品與價格帶',
    question: '主要賣什麼？講三樣最重要的就好，用頓號或逗號分開。',
    askStep: 2,
    placeholder: '例：黑豆水、養生茶包、節慶禮盒',
    aiCanGuess: true,
    emptyHint: '還不知道你賣什麼',
    /**
     * ⚠️ 2026-09-22 端到端實測（MYFEEL 官網）當場抓到的坑：那一頁是募資頁，
     * 上面最大的數字是**募資總金額**，模型直接拿去當價格，抽出「NT$0–7,030,300」。
     * 數字確實出現在頁面上，所以「不要編造價格」那條規則擋不住它——
     * ⛔ 要明講「只有單一商品的售價才算價格」，並把不算價格的那幾種點名。
     */
    aiHint: '主打商品（最多三樣，用短的商品名，不要整串行銷標題）與價格帶。'
      + '價格帶寫成「NT$180–1,280」這種區間，而且**只能用單一商品的售價**；'
      + '⛔ 募資總金額、贊助人數、折扣百分比、運費、原價劃線價都不是價格帶，看不出單品售價就整個留空',
  },
  {
    id: 'customers',
    label: '主要客群',
    question: '主要賣給誰？',
    askStep: 3,
    options: ['一般消費者', '公司行號', '兩種都有'],
    aiCanGuess: true,
    emptyHint: '還不知道你的客人是誰',
    aiHint: '主要客群。網站若看得出年齡層或性別傾向就補一句，看不出來就只寫商家自己講的那句',
  },
  {
    id: 'channel',
    label: '銷售方式',
    question: '客人通常怎麼買？',
    askStep: 4,
    options: ['實體店面', '網購為主', '預約制', '實體＋網購'],
    aiCanGuess: true,
    emptyHint: '還不知道客人怎麼跟你買',
    aiHint: '客人怎麼買：實體店面、網購、預約制或混合',
  },
  {
    id: 'season',
    label: '旺季與重要檔期',
    question: '生意最好的時候是？',
    askStep: 5,
    options: ['年節送禮（春節、中秋）', '夏天', '冬天', '開學／收假', '沒有明顯旺季'],
    aiCanGuess: false,
    emptyHint: '還不知道你的旺季',
    aiHint: '',
  },
  {
    id: 'pain',
    label: '現在最想解決的事',
    question: '現在最想解決的是哪一件？',
    askStep: 5,
    options: ['加好友後沒人理', '客服回不完', '不知道推播要推什麼', '想知道客人是誰'],
    aiCanGuess: false,
    emptyHint: '還沒說最想解決什麼',
    aiHint: '',
  },
  {
    id: 'tone',
    label: '品牌語氣',
    question: null,
    askStep: null,
    aiCanGuess: true,
    emptyHint: '接上 LINE 之後，從你回客人的口氣學',
    aiHint: '這個品牌講話的口氣，一句話（例：親切、講健康但不誇大）',
  },
  {
    id: 'faq',
    label: '客人最常問的事',
    question: null,
    askStep: null,
    aiCanGuess: true,
    emptyHint: '接上 LINE 之後，從實際對話學',
    aiHint: '客人最常問的三件事，用頓號分開。網站的常見問答有寫才填',
  },
  {
    id: 'rivals',
    label: '競爭對手',
    question: null,
    askStep: null,
    aiCanGuess: true,
    emptyHint: '還沒有',
    aiHint: '網站明確提到的競爭對手或比較對象。⛔ 沒提到就回空字串，不要用產業常識腦補',
  },
] as const

/** 依 id 查定義。找不到回 null（⛔ 不要 throw：舊資料可能有已經拿掉的欄位）。 */
export function storeProfileFieldDef(id: string): StoreProfileFieldDef | null {
  return STORE_PROFILE_FIELDS.find(f => f.id === id) ?? null
}

/** 精靈要問的題目，照 `askStep` 分組（同一步可能有兩題＝「最後兩個快問快答」）。 */
export function storeProfileAskSteps(): { step: number, fields: StoreProfileFieldDef[] }[] {
  const byStep = new Map<number, StoreProfileFieldDef[]>()
  for (const f of STORE_PROFILE_FIELDS) {
    if (f.askStep == null || !f.question) continue
    const list = byStep.get(f.askStep) ?? []
    list.push(f)
    byStep.set(f.askStep, list)
  }
  return [...byStep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([step, fields]) => ({ step, fields }))
}

/** 精靈總共問幾步（畫面上那個「第 N / 共 M」的 M）。 */
export function storeProfileAskStepCount(): number {
  return storeProfileAskSteps().length
}

// ── 讀寫輪廓的純函式 ───────────────────────────────────────────

export const STORE_PROFILE_VALUE_MAX = 300

/** 建一個空輪廓（所有欄位都是「從來沒問過」）。 */
export function emptyStoreProfile(): StoreProfileDoc {
  return { fields: {}, siteUrl: '' }
}

/**
 * 把 Firestore 讀回來的東西正規化成可信的形狀。
 * ⛔ 不認得的欄位 id **直接丟掉**（欄位表是唯一來源，留著會在畫面上變成一格沒有標題的值）；
 * ⛔ 不認得的 source 一律降成 `ai`——**寧可標成猜的，也不要把猜的標成商家確認的**。
 */
export function normalizeStoreProfile(raw: unknown): StoreProfileDoc {
  const r = (raw ?? {}) as Partial<StoreProfileDoc>
  const out = emptyStoreProfile()

  const rawFields = (r.fields ?? {}) as Record<string, unknown>
  for (const def of STORE_PROFILE_FIELDS) {
    const f = rawFields[def.id] as Partial<StoreProfileField> | undefined
    if (!f || typeof f !== 'object') continue
    const value = String(f.value ?? '').trim().slice(0, STORE_PROFILE_VALUE_MAX)
    const source: StoreProfileSource
      = f.source === 'owner' || f.source === 'conversation' ? f.source : 'ai'
    const missing = value
      ? undefined
      : (f.missing === 'not_in_source' || f.missing === 'needs_data' ? f.missing : 'never_asked')
    out.fields[def.id] = {
      value,
      source,
      ...(missing ? { missing } : {}),
      ...(f.ownerEdited === true ? { ownerEdited: true } : {}),
      updatedAt: typeof f.updatedAt === 'number' && Number.isFinite(f.updatedAt) ? f.updatedAt : 0,
    }
  }

  out.siteUrl = normalizeSiteUrl(String(r.siteUrl ?? ''))
  if (r.siteRead && typeof r.siteRead === 'object') out.siteRead = normalizeSiteRead(r.siteRead)
  if (typeof r.refreshAskedAt === 'number' && Number.isFinite(r.refreshAskedAt)) out.refreshAskedAt = r.refreshAskedAt
  return out
}

/**
 * 網址正規化。長得像網域就補 `https://`；完全不像就存空。
 * ⛔ 沿用 `aiSettings.shopUrl` 同一套規則（那裡的註解寫得很清楚：**不能直接清空**，
 *    否則舊資料每讀一次就被靜默歸零）。
 */
export function normalizeSiteUrl(input: string): string {
  const u = String(input ?? '').trim().slice(0, 500)
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(u)) return `https://${u}`
  return ''
}

function normalizeSiteRead(raw: unknown): SiteReadResult {
  const r = (raw ?? {}) as Partial<SiteReadResult>
  const status: SiteReadStatus
    = r.status === 'ok' || r.status === 'partial' ? r.status : 'failed'
  const pagesFailed = Array.isArray(r.pagesFailed)
    ? r.pagesFailed
        .slice(0, 20)
        .map(p => ({ url: String((p as { url?: unknown })?.url ?? '').slice(0, 300), reason: normalizeFailReason((p as { reason?: unknown })?.reason) }))
        .filter(p => Boolean(p.url))
    : []
  return {
    status,
    pagesRead: Math.max(0, Math.trunc(Number(r.pagesRead) || 0)),
    pagesFailed,
    ...(r.reason ? { reason: normalizeFailReason(r.reason) } : {}),
    at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
  }
}

const FAIL_REASONS: SiteReadFailReason[] = ['blocked', 'not_found', 'timeout', 'empty', 'not_html', 'too_large', 'network', 'unknown']

function normalizeFailReason(v: unknown): SiteReadFailReason {
  return FAIL_REASONS.includes(v as SiteReadFailReason) ? v as SiteReadFailReason : 'unknown'
}

/** 寫一格值。商家寫的自動帶 `ownerEdited`。 */
export function setStoreProfileField(
  profile: StoreProfileDoc,
  id: StoreProfileFieldId,
  value: string,
  source: StoreProfileSource,
  now = Date.now(),
): StoreProfileDoc {
  const v = String(value ?? '').trim().slice(0, STORE_PROFILE_VALUE_MAX)
  const next: StoreProfileDoc = { ...profile, fields: { ...profile.fields } }
  next.fields[id] = {
    value: v,
    source,
    ...(v ? {} : { missing: 'never_asked' as const }),
    ...(source === 'owner' ? { ownerEdited: true } : {}),
    updatedAt: now,
  }
  return next
}

/** 標記「找過了，但來源裡沒有這一項」。⛔ 這跟「沒填」是兩件事，畫面要講得不一樣。 */
export function markStoreProfileMissing(
  profile: StoreProfileDoc,
  id: StoreProfileFieldId,
  missing: StoreProfileMissing,
  source: StoreProfileSource = 'ai',
  now = Date.now(),
): StoreProfileDoc {
  const next: StoreProfileDoc = { ...profile, fields: { ...profile.fields } }
  const prev = profile.fields[id]
  // 已經有值的欄位不會因為這次沒找到就被清空
  if (prev?.value) return profile
  next.fields[id] = { value: '', source, missing, ...(prev?.ownerEdited ? { ownerEdited: true } : {}), updatedAt: now }
  return next
}

/**
 * 把 AI 猜的結果併進輪廓。
 * ⛔ **商家改過的欄位一律跳過**（`ownerEdited`）——這是「商家改過的永遠贏」那條鐵律的實作點，
 *    少了這一行，商家改完下次重讀就被蓋回去，而且畫面上沒有任何線索。
 * 回傳併進去的欄位 id，呼叫端要講得出「這次補了哪幾格」。
 */
export function mergeAiGuesses(
  profile: StoreProfileDoc,
  guesses: Partial<Record<StoreProfileFieldId, string>>,
  now = Date.now(),
): { profile: StoreProfileDoc, filled: StoreProfileFieldId[], skippedOwnerEdited: StoreProfileFieldId[] } {
  let next = profile
  const filled: StoreProfileFieldId[] = []
  const skippedOwnerEdited: StoreProfileFieldId[] = []

  for (const def of STORE_PROFILE_FIELDS) {
    if (!def.aiCanGuess) continue
    const raw = guesses[def.id]
    const value = String(raw ?? '').trim().slice(0, STORE_PROFILE_VALUE_MAX)
    const prev = next.fields[def.id]

    if (prev?.ownerEdited) {
      if (value) skippedOwnerEdited.push(def.id)
      continue
    }
    if (!value) {
      // 有值的不清空；沒值的標成「找過了，來源沒提到」
      next = markStoreProfileMissing(next, def.id, 'not_in_source', 'ai', now)
      continue
    }
    next = setStoreProfileField(next, def.id, value, 'ai', now)
    filled.push(def.id)
  }
  return { profile: next, filled, skippedOwnerEdited }
}

// ── 講給人看的字 ───────────────────────────────────────────────

export const STORE_PROFILE_SOURCE_LABELS: Record<StoreProfileSource, string> = {
  owner: '你說的',
  ai: 'AI 推測',
  conversation: '從對話學',
}

/**
 * 「沒有值」時卡片上那句話。三種沒有各講各的——
 * 「還沒有人填」跟「讀了網站但沒提到」對使用者是兩件事。
 */
export function describeMissing(def: StoreProfileFieldDef, missing: StoreProfileMissing | undefined): string {
  if (missing === 'not_in_source') return '找過了，你的網站沒提到'
  if (missing === 'needs_data') return def.emptyHint
  return def.emptyHint
}

/** 讀網站的結果講成一句人話。⛔ 部分成功不可以講得跟全部成功一樣。 */
export function describeSiteRead(r: SiteReadResult | undefined): string {
  if (!r) return '還沒有讀過你的網站'
  if (r.status === 'failed') return `你的網站我讀不到（${failReasonText(r.reason)}）`
  const base = `讀到 ${r.pagesRead} 頁`
  if (r.status === 'ok' || r.pagesFailed.length === 0) return `網站讀完了：${base}`
  return `網站讀了一部分：${base}，另外 ${r.pagesFailed.length} 頁讀不到`
}

export function failReasonText(reason: SiteReadFailReason | undefined): string {
  switch (reason) {
    case 'blocked': return '對方網站擋住了我們'
    case 'not_found': return '這個網址打不開'
    case 'timeout': return '太久沒有回應'
    case 'empty': return '抓得到頁面但幾乎沒有文字，多半是要跑程式才長得出內容的網站——換一個商品頁的網址通常就讀得到'
    case 'not_html': return '這個網址不是網頁（例如 PDF 或圖片）。PDF 直接上傳到知識庫就好，不用貼網址'
    case 'too_large': return '頁面太大'
    case 'network': return '連不上這個網址'
    default: return '原因不明'
  }
}

/** 有幾格真的有值（畫面上「9 項知道 N 項」那個 N）。 */
export function filledFieldCount(profile: StoreProfileDoc): number {
  return STORE_PROFILE_FIELDS.filter(def => Boolean(profile.fields[def.id]?.value)).length
}

/**
 * MiniMe 認不認識這家店。
 * 口徑：**精靈問的那五題裡，商家至少親自答了三題**。
 * ⛔ 不可以用「有沒有這份文件」判定——AI 讀網站也會建出文件，那樣等於
 *    商家一題都沒答也算認識，就緒度就會說謊（`D-23` 那次 `scriptReady` 全綠
 *    但沒有一條是加好友，是同一種假綠燈）。
 */
export const STORE_PROFILE_READY_MIN_OWNER_ANSWERS = 3

export function isStoreProfileReady(profile: StoreProfileDoc | null | undefined): boolean {
  if (!profile) return false
  const owned = STORE_PROFILE_FIELDS.filter(
    def => def.askStep != null && profile.fields[def.id]?.value && profile.fields[def.id]?.source === 'owner',
  ).length
  return owned >= STORE_PROFILE_READY_MIN_OWNER_ANSWERS
}

/**
 * 給 LLM 的一段店家介紹（節慶建議、文案草稿、語氣生成共用同一份）。
 * ⛔ 只放有值的欄位：把「還沒有」也寫進 prompt，模型會拿它當事實編故事。
 * 回空字串＝這家店還沒有輪廓，呼叫端要走「通用句」那條路，不要送空 prompt。
 */
export function storeProfileForPrompt(profile: StoreProfileDoc | null | undefined): string {
  if (!profile) return ''
  const lines: string[] = []
  for (const def of STORE_PROFILE_FIELDS) {
    const f = profile.fields[def.id]
    if (!f?.value) continue
    lines.push(`- ${def.label}：${f.value}`)
  }
  return lines.join('\n')
}
