import type { Timestamp, FieldValue } from 'firebase-admin/firestore'

/** Firestore Vector Search 的向量欄位型別（768 dim） */
export type EmbeddingVector = FirebaseFirestore.VectorValue

// ═══════════════════════════════════════════════════════════════════
//  Knowledge chunk
//  Path: workspaces/{workspaceId}/knowledgeChunks/{chunkId}
//  一張知識卡：標題 + 內容 + 標籤 + 向量索引狀態
// ═══════════════════════════════════════════════════════════════════

export type KnowledgeChunkStatus = 'pending' | 'indexed' | 'failed' | 'disabled'

export interface KnowledgeChunkDoc {
  workspaceId: string
  title: string
  content: string
  tags: string[]
  /** 客人常見問法（LLM 生成），與 title/content 一併進 embedding；舊卡可能沒有此欄位 */
  questions?: string[]
  /**
   * 是否為「總覽卡」：列表頁（如商品首頁）匯入時額外合成的一張分類索引卡，
   * 用來接「你們有賣什麼」這類列舉型問題。一個 source 至多一張。
   * 它是機器合成的，re-sync 預設直接覆蓋更新（除非被手動編輯過）；
   * 答題時 top-1 命中總覽卡則不進反問澄清（總覽贏了本身就是答案）。
   */
  isOverview?: boolean
  /** Firestore VectorValue（768 dim）；尚未索引時為 null */
  embedding: EmbeddingVector | null
  /** 約略 token 數，用來估成本與檢索預算 */
  tokens: number
  status: KnowledgeChunkStatus
  /** 失敗原因（status === 'failed' 時填寫） */
  failureReason?: string
  /** 連續索引失敗次數；超過上限後排程不再自動重試（手動 reindex 不受限，成功即歸零） */
  retryCount?: number
  /** 來源 doc ID；手打輸入則為 null */
  sourceId: string | null
  /**
   * 所屬產品的正規名稱，索引時從來源層 productName 繼承（治本：切卡常把「這是哪個產品」弄丟，
   * 維修/屬性卡標題只有「保護代碼EH」，客人指名品牌問細節就撈不到、或撈到了 LLM 也不敢答）。
   * 進 embedding 最前段 + 答題 context 標明；來源沒設 productName 時不寫此欄位。
   */
  productName?: string
  /** 最後一次完成索引的時間（indexed 後才寫） */
  lastIndexedAt: Timestamp | null
  /** 使用者手動編輯後的時間戳；resync 時用來預設「保留人工版本」 */
  manuallyEditedAt: Timestamp | null
  /**
   * 有效期限（選填）：到期（含當日結束）後由排程自動改 status='disabled' 並搬到 expiredAt。
   * 給行銷快訊類卡片（募資 / 折扣 / 出貨進度）用，避免過期內容繼續被 AI 引用。
   */
  activeUntil?: Timestamp | null
  /** 到期自動停用的紀錄（原 activeUntil 值搬過來；手動重新啟用時清除） */
  expiredAt?: Timestamp | null
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Knowledge source
//  Path: workspaces/{workspaceId}/knowledgeSources/{sourceId}
//  上傳檔案或網址的「原始來源」；一份來源會自動切成多張 chunk
// ═══════════════════════════════════════════════════════════════════

export type KnowledgeSourceType = 'file' | 'url' | 'manual' | 'gsheet'
export type KnowledgeSourceStatus = 'fetching' | 'splitting' | 'ready' | 'failed'

// ═══════════════════════════════════════════════════════════════════
//  Knowledge folder（資料夾）— 把 source 分組顯示
//  Path: knowledgeFolders/{folderId}
// ═══════════════════════════════════════════════════════════════════

export interface KnowledgeFolderDoc {
  workspaceId: string
  /** 顯示名稱（1–50 字） */
  name: string
  /** 排序用；目前先用 createdAt 倒序，未來想做拖曳排序再用 */
  order: number
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

export interface KnowledgeSourceDoc {
  workspaceId: string
  /** 所屬資料夾；null = 未分類 */
  folderId: string | null
  type: KnowledgeSourceType
  /** 顯示名稱：檔名 / 網址 / 手打標題 */
  name: string
  /** type === 'url' / 'gsheet' 時填（gsheet 存使用者貼的原始連結，供顯示/重抓） */
  url: string
  /** type === 'file' 時填，指向 Storage path */
  filePath: string
  /**
   * type === 'gsheet' 專用：解析後的試算表 id 與分頁 gid（gid 為 null = 第一個分頁）。
   * 比對用 id，不靠 url 字串（url 可能帶不同 query/hash）。
   */
  gsheetId?: string
  gsheetGid?: string | null
  /**
   * type === 'gsheet' 專用：偵測到變動時是否「自動套用」(重讀列→新增/更新/刪除卡)。
   * Sheet 是商家自己的結構化表格，預設 true（自動同步）；手動編輯過的卡仍保留不覆蓋。
   * false 時退回與 url 一樣的「標記 outdated 等人工確認」行為。
   */
  gsheetAutoApply?: boolean
  /** 內容 hash，網址同步時用來判斷是否需要重新切卡 */
  contentHash: string
  /**
   * 變動偵測的「待確認新值」：抓到與 contentHash 不同的新 hash 時先存這裡，
   * **下一輪仍是同一個新值才確認為真變動**——輪播 / 隨機推薦 / 計數器頁面每次抓都不同，
   * 一次差異就通知會狼來了。內容跳回原值（假變動）或又變成別的值都會重置。
   * 代價：真變動晚一個檢查週期才通知。
   */
  pendingHash?: string
  /** HTTP etag 與 lastModified（網址同步用） */
  etag: string
  lastModified: string
  /** 0 = 不自動更新；> 0 表示每幾秒輪詢一次（保留向後相容；新流程用 refreshIntervalMinutes） */
  refreshIntervalSec: number
  /** URL 自動偵測變動的頻率（分鐘）；0 = 不偵測。建議 1440 (每天) 或 10080 (每週) */
  refreshIntervalMinutes: number
  /**
   * 偵測到內容變動時的行為：
   *   - 'notify': 標 outdatedAt，等使用者進後台確認（**預設、推薦**）
   *   - 'log_only': 只記錄到 log，不通知使用者
   *
   * 不提供 'overwrite' 自動覆蓋選項 — 太危險（網站可能短暫掛 / 改版會切壞）。
   */
  onChangeBehavior: 'notify' | 'log_only'
  /**
   * 列表頁（商品首頁、型錄頁）匯入時，除了切碎成個別卡片，再額外合成一張「總覽卡」
   * （isOverview=true 的 chunk），用來接「你們有賣什麼」這類列舉型問題。
   * re-sync 套用後會依當下的子卡片重新合成這張總覽卡。預設 false。
   */
  generateOverview?: boolean
  /**
   * 這個來源「所屬產品」的正規名稱（含品牌與型號）；空/未設 = 非單一產品來源（FAQ、公告等）。
   * 卡片索引時自動繼承（runIndexOnChunk：embedding 前綴 + 卡片 productName 欄位），
   * 是反問分組 / 防混答 / 指名作答的根基。匯入時 LLM 自動偵測預填、使用者可改；
   * 之後在來源設定改動要**重建該來源索引**才生效（embedding 已含舊前綴）。
   */
  productName?: string
  lastFetchedAt: Timestamp | null
  /** 偵測到 URL 內容變了但還沒套用的時間；null = 沒過期 / 已套用 */
  outdatedAt: Timestamp | null
  status: KnowledgeSourceStatus
  failureReason?: string
  /** 排程變動偵測連續失敗次數；成功即清除。≥3 次會把 status 標成 failed */
  checkFailCount?: number
  /** 排程變動偵測最後一次「嘗試」時間（成功或失敗），退避基準；lastFetchedAt 保留「最後成功」語意 */
  lastCheckedAt?: Timestamp | null
  /** 切出來的 chunk 數量（給 UI 顯示用） */
  chunkCount: number
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  AI settings (singleton per workspace)
//  Path: workspaces/{workspaceId}/aiSettings/default
//  整個工作區的 AI 行為配置；只有一份
// ═══════════════════════════════════════════════════════════════════

export type AiAnswerModel = 'gemini-2.5-flash' | 'gemini-2.5-flash-lite'
export type AiEmbeddingModel = 'gemini-embedding-001'
export type QuotaExceedStrategy = 'handoff_all' | 'downgrade_model'
/**
 * 回覆模式：
 *   - 'auto'：AI 直接回覆客人（原行為）
 *   - 'draft'：AI 只把建議回覆寫進收件匣（aiMeta.suggestedReply），不對客人發話。
 *     新導入工作區的漸進信任路徑：先觀察 AI 答題品質，再切全自動。
 */
export type AiReplyMode = 'auto' | 'draft'

export interface AiSettingsDoc {
  /** 總開關：未啟用前 AI 不接任何訊息 */
  enabled: boolean
  /** 回覆模式；enabled=true 才有意義 */
  replyMode: AiReplyMode
  answerModel: AiAnswerModel
  embeddingModel: AiEmbeddingModel
  /** 信心門檻（0–1）；低於此值就轉真人。預設 0.75 */
  confidenceThreshold: number
  /** Grounding 門檻（0–1）：最佳相似度需 ≥ 此值才允許 AI 答；否則 handoff(no_grounding)。預設 0.7 */
  groundingThreshold: number
  /** 給 AI 的系統指示（語氣、禁則） */
  systemPrompt: string
  /**
   * 商店 / 官網網址（per-workspace）。客人問價格 / 購買但命中的知識卡沒有連結時，
   * AI 用這個當 fallback（「最新價格與購買請見 <shopUrl>」）。空字串 = 不啟用。
   * 注意：價格、商品頁這類「各租戶不同」的東西一律走此設定，不寫死在共用程式。
   */
  shopUrl: string
  /** 回覆長度上限（字數） */
  replyMaxLen: number
  /** 敏感主題：命中即直接 handoff，不讓 AI 答 */
  sensitiveTopics: string[]
  quota: {
    /** 每月 token 上限 */
    monthlyTokenCap: number
    /** 超量時的處理策略 */
    onExceed: QuotaExceedStrategy
  }
  /** Handoff 通知：AI 轉真人時，用官方帳號推播 LINE 訊息提醒指定客服人員（須為此 OA 好友） */
  handoffNotify: {
    enabled: boolean
    /** 要通知的客服 LINE userIds（上限 10 位） */
    lineUserIds: string[]
    /** userId → 顯示名稱快取；僅供後台 UI 顯示用,推播本身只看 lineUserIds */
    displayNames?: Record<string, string>
    /** SLA 提醒：轉真人後超過此分鐘數仍無人回應，再推播提醒一次（每場會話只提醒一次）。0 = 關閉 */
    slaRemindMinutes: number
  }
  /**
   * 真人處理中、且真人最後回覆超過此分鐘數沒有後續回覆 → 自動把會話交還機器人。
   * 0 = 關閉（只能手動按「交還機器人」或等 24h session 過期）。
   */
  handbackIdleMinutes: number
  /** 反問澄清（disambiguation）— 答案擦邊且 top-K 分數接近時主動反問 */
  disambiguation: {
    /** 總開關；關掉就照舊走 answered / handoff */
    enabled: boolean
    /** top-1 相似度需 ≥ 此值才考慮反問（太低 → 知識庫沒料，不該反問） */
    top1Min: number
    /** top-1 相似度需 < 此值才考慮反問（夠高 → 已經有明確答案，直接答） */
    top1Max: number
    /** (top1 - top2) < 此值才視為「多卡同樣相關」 */
    maxSpread: number
    /** 反問時最多列幾個選項 */
    maxOptions: number
    /** 同一對話內，反問之間的冷卻時間（分鐘） */
    cooldownMinutes: number
  }
  /**
   * 服務時間 / 勿擾時段（台灣時區）。只影響「轉真人」：勿擾時段內轉真人時不通知客服、
   * 改回客人一則勿擾訊息（腳本 bot 與 AI 觸發的轉真人都吃）。enabled=false 時完全不影響行為。
   */
  serviceHours: {
    enabled: boolean
    /** 服務時段起（"HH:mm"，台灣時區） */
    start: string
    /** 服務時段迄（"HH:mm"） */
    end: string
    /** 週六、週日整天視為勿擾 */
    weekendOff: boolean
    /** 勿擾時段回覆客人的訊息 */
    dndReply: string
  }
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  AI usage (monthly aggregate)
//  Path: workspaces/{workspaceId}/aiUsage/{yyyyMM}
//  Doc ID 例：202606
// ═══════════════════════════════════════════════════════════════════

export interface AiUsageDoc {
  workspaceId: string
  /** 'YYYYMM' */
  period: string
  /** 累計 input tokens（含 embedding + answer） */
  inputTokens: number
  outputTokens: number
  embeddingTokens: number
  /** 觸發 AI 回答的次數（含 handoff 與成功回答） */
  invocations: number
  /** 信心過關直接回答的次數 */
  answered: number
  /** 因信心 / 敏感詞 / grounding 不過而 handoff 的次數 */
  handoffs: number
  /** 觸發反問澄清的次數 */
  disambiguations: number
  /** 匯入 / 整理（切卡、normalize）token 分項；已包含在 inputTokens/outputTokens 總量內 */
  importInputTokens?: number
  importOutputTokens?: number
  /** AI answered 後 30 分鐘內客人又被轉真人 — 回答品質 proxy */
  answeredThenHandoffs?: number
  /**
   * 測試對話（playground「重演」/ 內部測試）花掉的 token，**獨立記帳、不併入上方真客人 token**。
   * 用途：成本報表能把「真客人成本」與「測試成本」分開，每對話成本不被測試灌高。
   * 測試不計真客人的 invocations/answered/handoffs（見 answerWithAi isTest）；
   * 但另記 testInvocations，讓成本頁看得到「後台測試跑了幾次」。
   */
  testInputTokens?: number
  testOutputTokens?: number
  testEmbeddingTokens?: number
  /** 後台測試（playground / 內部重演）觸發的次數；與真客人 invocations 分開記。 */
  testInvocations?: number
  /** 知識庫建索引 embedding（reindex / bulk-create / 逐卡）；屬建置成本，與客人查詢 embedding 分開 */
  buildEmbeddingTokens?: number
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  AI conversation meta (extension on ConversationDoc)
//  存「最近一次 AI 互動」的快取，主要給收件匣顯示「AI 整理脈絡」用
// ═══════════════════════════════════════════════════════════════════

export type AiDecision = 'answered' | 'handoff' | 'skipped' | 'disambiguate' | 'handoff_confirm'
export type HandoffReason =
  | 'low_confidence'
  | 'sensitive_topic'
  | 'no_grounding'
  | 'quota_exceeded'
  /** LLM 呼叫拋例外（Gemini 503 / 網路斷 / JSON 壞掉 / retry exhausted），多半重試就過 */
  | 'llm_error'
  /** 真正的設定 / 流程問題（空 query、AI 未啟用等），不是 LLM 服務問題 */
  | 'manual'
  /** 客人明確要求真人（「找真人」按鈕或自行輸入），不經 AI 直接轉接 */
  | 'user_request'
  /** 業務洽詢（議價殺價 / 團購批發 / 客製包裝禮盒等），需業務人員處理，知識庫答不了 */
  | 'commercial_inquiry'
  /** 客人回報「照做了還是沒解決」（還是一樣 / 沒用）——再答只會複讀同一張卡，改走轉真人確認 */
  | 'unresolved'

export interface AiConversationMeta {
  /** 最近一次 AI 介入的決定 */
  lastDecision: AiDecision
  lastConfidence: number
  lastHandoffReason: HandoffReason | null
  /** 觸發 AI 介入的使用者原文（用於監控頁顯示「客人問了什麼 AI 不會答」） */
  lastQuery: string
  /** 命中知識卡 ID（依相似度由高到低） */
  lastSourceChunkIds: string[]
  /** AI 整理出的對話意圖（給真人客服參考） */
  intent: string
  /** 從對話中已收集到的欄位（key 由腳本定義） */
  collectedFields: Record<string, string>
  /** AI 建議的回覆草稿（給真人客服一鍵採用） */
  suggestedReply: string
  /** 轉真人時 AI 生成的 2–3 句對話摘要（給接手的真人客服快速掌握脈絡；非 handoff 時為空） */
  handoffSummary: string
  /** 最近一次反問澄清；非 null 時表示在等客人從 options 中選一個 */
  lastDisambiguation?: {
    options: Array<{ chunkId: string; title: string; label?: string }>
    askedAt: Timestamp | FieldValue
  } | null
  /**
   * 監控頁「轉真人案例」標記已處理的時間。resolvedAt >= updatedAt 視為已處理；
   * 同客人之後又發生新互動（updatedAt 更新）會自動回到未處理。
   */
  handoffResolvedAt?: Timestamp | FieldValue | null
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  AI auto-reply rule config (extension on AutoReplyDoc)
//  當 autoReplyRule 的 type === 'ai' 時讀這份設定
// ═══════════════════════════════════════════════════════════════════

export interface AiAutoReplyConfig {
  /** 額外加在 systemPrompt 後面的指示（針對這條規則的情境） */
  promptOverride: string
  /** 命中本規則才允許使用的標籤；空陣列 = 不限制 */
  allowedTagIds: string[]
}

// ═══════════════════════════════════════════════════════════════════
//  /api/ai/answer 回應契約
// ═══════════════════════════════════════════════════════════════════

export interface DisambiguationPayload {
  /** 反問客人的自然語句（LLM 生成） */
  clarification: string
  /**
   * 可選選項；每個 option 對應一張命中的知識卡。
   * label = 按鈕顯示用短名稱（≤20 字，LLM 生成）。按鈕送出的 text 優先用短 label
   * （客人氣泡才不會出現一整串卡片標題）；label 缺失或與其他選項撞名時退回完整 title，
   * followup 比對兩者都認得（見 handler）。
   */
  options: Array<{ chunkId: string; title: string; label?: string }>
}

export interface AiAnswerResult {
  decision: AiDecision
  /** decision === 'answered' 才有值 */
  answer: string
  confidence: number
  /** 命中的知識卡（依相似度排序） */
  sources: Array<{
    chunkId: string
    title: string
    similarity: number
  }>
  /** decision === 'handoff' 才有值 */
  handoffReason: HandoffReason | null
  /** decision === 'disambiguate' 才有值 */
  disambiguation?: DisambiguationPayload
  /** 給 debug 用：實際送進 LLM 的 prompt */
  debugPrompt?: string
}

// ═══════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════

export const EMBEDDING_DIMENSION = 768

/** 信心門檻預設值（討論決議：保守起手 0.75，跑兩週後再降） */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75

/** Grounding：至少一張卡的相似度要超過這個值才允許 AI 回答 */
export const DEFAULT_GROUNDING_SIMILARITY_THRESHOLD = 0.7

/** 預設取多少張相關卡進 prompt */
export const DEFAULT_TOP_K_CHUNKS = 5

/** 預設回覆長度上限（LINE 單則文字訊息上限 5000 字，這裡留餘裕） */
export const DEFAULT_REPLY_MAX_LEN = 300

/** 反問澄清預設值 */
export const DEFAULT_DISAMBIGUATION_ENABLED = true
// 0.70（原 0.65）：低於此的多卡群多半是「沒有好答案、被迫湊近似卡」，反問會塞不相關選項
// （例：問淨水器卻列出吸塵器/除濕機）。拉高門檻讓弱匹配改走 grounding/answer 而非亂反問。
export const DEFAULT_DISAMBIGUATION_TOP1_MIN = 0.70
export const DEFAULT_DISAMBIGUATION_TOP1_MAX = 0.78
export const DEFAULT_DISAMBIGUATION_MAX_SPREAD = 0.05
// 10：對齊 LINE Quick Reply 慣例上限（MAX_QUICK_REPLY_OPTIONS=10；反問另加 1 顆「找真人」，10+1 仍 ≤ 13 硬限）。
// 預設放到最寬鬆，讓 AI 反問時盡量把相關卡都列出來，不因選項數被截。
/** 勿擾時段預設回覆客人的訊息（服務時間之外轉真人時使用） */
export const DEFAULT_DND_REPLY = '您好,目前非客服服務時間,我們會在服務時間盡快回覆您 🙏'
export const DEFAULT_DISAMBIGUATION_MAX_OPTIONS = 10
// 0：預設不設冷卻（同對話可連續反問）。注意這少了「反問過度」的防線，若日後又出現過度反問可調回。
export const DEFAULT_DISAMBIGUATION_COOLDOWN_MINUTES = 0

/** 預設月度 token 上限 */
export const DEFAULT_MONTHLY_TOKEN_CAP = 1_000_000

/** 真人閒置自動交還機器人（分鐘）；0 = 關閉。保守預設關閉，由各工作區自行啟用 */
export const DEFAULT_HANDBACK_IDLE_MINUTES = 0

/** 轉真人後超時再提醒（分鐘）；0 = 關閉。單一事實來源：normalize / buildDefault / 前端表單都引用這裡 */
export const DEFAULT_SLA_REMIND_MINUTES = 15

/** aiSettings 單例 doc ID */
export const AI_SETTINGS_DOC_ID = 'default'

/**
 * 預設敏感主題清單（討論決議：seed 通用清單、客戶可改）。
 * 命中即直接 handoff、不讓 AI 答。
 */
export const DEFAULT_SENSITIVE_TOPICS: readonly string[] = [
  // 自傷/危險
  '自殺', '想死', '輕生', '傷害自己',
  // 法律糾紛
  '提告', '消保官', '申訴', '檢舉', '律師', '訴訟',
  // 金錢爭議
  '退費', '退款', '爭議', '詐騙', '消費爭議',
  // 投資建議
  '保證獲利', '投資建議', '股票推薦',
  // 個資
  '身分證字號', '信用卡號', '密碼',
]
// 註：刻意「不」把醫療詞（診斷/處方/副作用/過敏/療程效果）放進通用預設——它們對
// 零售/服務型租戶誤殺率高（例：賣「抗敏清淨機」的店，客人問「適合過敏嗎」會被硬擋）。
// 真正的醫療敏感情境交給 intent router 依語意判斷；診所類租戶可自行於設定加回。

export const DEFAULT_SYSTEM_PROMPT = [
  '你是專業的 LINE 官方帳號客服助理。',
  '回覆原則：',
  '1. 只能根據提供的「知識卡內容」回答；知識卡沒寫到的，不要自己編、也不要拿沾邊的內容硬湊。',
  '   （需要轉真人時，系統會自動安排，你不必、也不要在回覆裡寫「我幫您轉接」之類的話。）',
  '2. 回覆要簡短、口語、有禮貌；不要使用 markdown 或項目符號。',
  '3. 不要編造資訊、不要承諾沒寫的事。',
  '4. 涉及退費、法律糾紛、醫療診斷等，務必交給專人，不要自己給建議。',
].join('\n')

export const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  low_confidence: '信心不足',
  sensitive_topic: '敏感主題',
  no_grounding: '知識庫無依據',
  quota_exceeded: '本月用量已滿',
  llm_error: 'AI 服務暫時失敗',
  manual: '人工指定',
  user_request: '客人要求真人',
  commercial_inquiry: '業務洽詢',
  unresolved: '排除步驟沒解決',
}

export const KNOWLEDGE_CHUNK_STATUS_LABELS: Record<KnowledgeChunkStatus, string> = {
  pending: '處理中',
  indexed: '可用',
  failed: '失敗',
  disabled: '已停用',
}

export const KNOWLEDGE_SOURCE_TYPE_LABELS: Record<KnowledgeSourceType, string> = {
  file: '檔案',
  url: '網址',
  manual: '手打',
  gsheet: 'Google Sheet',
}

export const QUOTA_EXCEED_STRATEGY_LABELS: Record<QuotaExceedStrategy, string> = {
  handoff_all: '全部轉真人',
  downgrade_model: '降級模型',
}

/**
 * 建立 aiSettings 預設值（用於新工作區 seed）
 */
export function buildDefaultAiSettings(): Omit<AiSettingsDoc, 'updatedAt'> {
  return {
    enabled: false,
    replyMode: 'auto',
    answerModel: 'gemini-2.5-flash',
    embeddingModel: 'gemini-embedding-001',
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    groundingThreshold: DEFAULT_GROUNDING_SIMILARITY_THRESHOLD,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    shopUrl: '',
    replyMaxLen: DEFAULT_REPLY_MAX_LEN,
    sensitiveTopics: [...DEFAULT_SENSITIVE_TOPICS],
    quota: {
      monthlyTokenCap: DEFAULT_MONTHLY_TOKEN_CAP,
      onExceed: 'handoff_all',
    },
    handoffNotify: {
      enabled: false,
      lineUserIds: [],
      displayNames: {},
      slaRemindMinutes: DEFAULT_SLA_REMIND_MINUTES,
    },
    handbackIdleMinutes: DEFAULT_HANDBACK_IDLE_MINUTES,
    disambiguation: {
      enabled: DEFAULT_DISAMBIGUATION_ENABLED,
      top1Min: DEFAULT_DISAMBIGUATION_TOP1_MIN,
      top1Max: DEFAULT_DISAMBIGUATION_TOP1_MAX,
      maxSpread: DEFAULT_DISAMBIGUATION_MAX_SPREAD,
      maxOptions: DEFAULT_DISAMBIGUATION_MAX_OPTIONS,
      cooldownMinutes: DEFAULT_DISAMBIGUATION_COOLDOWN_MINUTES,
    },
    serviceHours: {
      enabled: false, // 預設關閉:不影響任何轉真人行為,要用才開
      start: '09:00',
      end: '18:00',
      weekendOff: true,
      dndReply: DEFAULT_DND_REPLY,
    },
  }
}

/**
 * 子字串比對敏感詞。回傳第一個命中的詞，沒命中為 null。
 * 命中即直接 handoff。
 */
export function detectSensitiveTopic(
  input: string,
  topics: readonly string[],
): string | null {
  if (!input) return null
  const text = input.toLowerCase()
  for (const topic of topics) {
    const t = topic.toLowerCase().trim()
    if (t && text.includes(t)) return topic
  }
  return null
}
