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
  /**
   * 在回收桶裡（軟刪除）。與 deletedAt 成對維護——deletedAt 給人看時間、
   * 這個布林給**查詢層**過濾：Firestore 表達不了「欄位不存在」，
   * 沒有它就只能整批讀回來在 JS 濾（150 倍讀取費，見 countSourceChunks）。
   */
  isDeleted?: boolean
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
  /** 內容 hash，網址同步時用來判斷是否需要重新切卡（＝「最後一次觀測到的網頁指紋」） */
  contentHash: string
  /**
   * 「目前這批知識卡對應到哪一版網頁內容」的指紋。只有走完人工審或自動套用的路徑會更新它：
   * 匯入、resync-apply（含使用者一律選「保留舊版」——那也是**已經看過並決定**的版本）、
   * 小改自動套用。排程只是偵測到變動時不會動它。
   *
   * 為什麼不能用 contentHash 代替：排程一偵測到變動就會把 contentHash 推到新值（再標 outdated
   * 等人工確認），所以 contentHash 只代表「網頁現在長怎樣」，不代表「卡片是從什麼切出來的」。
   * 少了這一欄，重新同步無法回答唯一重要的問題——「網頁跟我上次整理的時候比，到底有沒有變」
   * ——只能每次都重跑一次 LLM 切卡再比對兩批 LLM 產物，於是網頁沒變也照樣冒出一堆假差異。
   *
   * 舊來源沒有這一欄（空字串）＝沒有基準，行為與過去相同（照跑重切＋比對）。
   */
  appliedContentHash?: string
  /**
   * 變動偵測的「待確認新值」：抓到與 contentHash 不同的新 hash 時先存這裡，
   * **下一輪仍是同一個新值才確認為真變動**——輪播 / 隨機推薦 / 計數器頁面每次抓都不同，
   * 一次差異就通知會狼來了。內容跳回原值（假變動）或又變成別的值都會重置。
   * 代價：真變動晚一個檢查週期才通知。
   */
  pendingHash?: string
  /**
   * 「把數字抹掉之後」的內容指紋（判斷規則見 `shared/knowledge-fingerprint.ts`）。
   * 集資金額／支持人數／倒數天數這種每天都在動的數字不會反映在這道指紋上，
   * 所以它變了＝**文字內容真的被改過**。舊來源沒有這一欄（''）＝沒有基準，
   * 行為退回改版前的逐字比對。
   */
  textHash?: string
  /** 上一輪抓到的逐字指紋（每輪都更新；`pendingHash` 是它在舊版的角色） */
  observedHash?: string
  /** 上一輪抓到的抹數字指紋 */
  observedTextHash?: string
  /**
   * 已連續幾輪「文字一字未改、只有數字在動」。達到 `NUMERIC_DRIFT_LEARN_ROUNDS`
   * 就認定這個網址的數字本來就會自己跑，之後純數字變動不再提醒（例：集資平台首頁）。
   */
  numericDriftRounds?: number
  /** 已連續幾輪停在「等下一輪確認」 */
  pendingRounds?: number
  /**
   * 連續多輪抓到的內容都不一樣、系統無從確認哪一版才算數的起始時間。
   * 這種來源以前會無聲無息地永遠等下去、畫面卻顯示一切正常；有了它，資料頁才講得出
   * 「自動偵測對這個網址無效，要更新請自己按重新同步」。恢復正常時寫回 null。
   */
  detectStalledAt?: unknown
  /** HTTP etag 與 lastModified（網址同步用） */
  etag: string
  lastModified: string
  /** 0 = 不自動更新；> 0 表示每幾秒輪詢一次（保留向後相容；新流程用 refreshIntervalMinutes） */
  refreshIntervalSec: number
  /** URL 自動偵測變動的頻率（分鐘）；0 = 不偵測。建議 1440 (每天) 或 10080 (每週) */
  refreshIntervalMinutes: number
  /**
   * 偵測到內容變動時的行為：
   *   - 'notify': 通知使用者（**預設、推薦**）。實際處置再分兩級（見 urlAutoApply）：
   *       小幅文字更新 → 自動套用＋摘要通知；結構性變動 → 標 outdatedAt 等人工確認。
   *   - 'log_only': 只記錄到 log，不通知也不自動套用。
   *
   * 不提供「無條件自動覆蓋」選項 — 太危險（網站可能短暫掛 / 改版會切壞）；
   * 自動套用的門檻由 ai-knowledge-autoapply.classifyMinorChange 嚴格把關。
   */
  onChangeBehavior: 'notify' | 'log_only'
  /**
   * type === 'url' 專用：是否允許「小幅文字變動自動套用」（預設 true）。
   * false = 這個來源的任何變動都要人工確認（比照 gsheetAutoApply 的商家自管語意），
   * 但仍會收到變動通知——與 log_only（連通知都不要）不同。
   */
  urlAutoApply?: boolean
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
    /**
     * 即時通知模式。always＝每場轉真人當下推播（預設）；missed_only＝當下不推，
     * 超過 slaRemindMinutes 仍沒人接手才推一則（帶完整摘要）。後者給「客服本來就
     * 整天盯後台」的商家省官方帳號訊息費——即時通知佔內部推播八成五的則數。
     */
    mode: 'always' | 'missed_only'
    /** SLA 提醒：轉真人後超過此分鐘數仍無人回應，再推播提醒一次（每場會話只提醒一次）。0 = 關閉 */
    slaRemindMinutes: number
    /** 每日摘要（積壓＋知識庫待辦）發送時段：台北時間整點 0–23，當天過了這個小時的第一輪排程發送 */
    digestHour: number
    /**
     * 節慶行銷提醒：台灣節日前 7／3／1 天，在每日摘要那則訊息裡多加一段節日提醒與
     * 行銷建議（`shared/taiwan-festivals.ts`）。**預設開**——這是有用的東西，且只會
     * 發給本來就開了通知的帳號，嫌吵再關。
     *
     * 開著時「當天沒有其他待辦」也會照發（只有節慶那段），否則提醒常常無聲消失。
     */
    festivalTips: boolean
    /**
     * 每週一在同一則摘要裡附「本週顧客觀察」（D-25 第二階，洞察週報）：
     * 這週被貼最多的標籤、待處理的 AI 標籤建議數、上月有來訊這月安靜的客人數。
     * 走每日摘要同一條 LINE 管道不另發一則；只講有資料的觀察，全部為零就整段不出現。
     * **預設開**（同 festivalTips 口徑：不對客人說話，漏掉才是損失）。
     */
    weeklyInsights: boolean
    /**
     * 嚴重異常主動推到 LINE（`D-8`②，2026-08-21 老闆拍板做）。
     *
     * 只推「現在正在影響客人」那一級（機器人收不到訊息、AI 停止回覆、活動連結打不開…），
     * 一件事最多一天講一次、多件事併成一則。**預設開**——這一級的定義就是客人此刻
     * 拿不到服務，等商家自己想到要開後台看才發現，往往已經過了幾小時。
     *
     * ⛔ 不要把 warning／suggestion 也推進來：那兩級是「建議處理」與「可以更好」，
     *    推到 LINE 就是狼來了，久了連真的紅燈也會被忽略。
     */
    criticalAlertPush: boolean
  }
  /**
   * 真人處理中、且真人最後回覆超過此分鐘數沒有後續回覆 → 自動把會話交還機器人。
   * 0 = 關閉（只能手動按「交還機器人」或等 24h session 過期）。
   */
  handbackIdleMinutes: number
  /**
   * 真人接手中（待真人／真人處理中）的會話，雙方都沒動靜超過此時數 → 系統自動結束。
   * **0 = 關閉（預設）**：只有真人按「結束會話」／「交還機器人」才會結束，系統不代勞。
   * 開啟時下界 6 小時（見 MIN_HUMAN_SESSION_MAX_IDLE_HOURS）。
   */
  humanSessionMaxIdleHours: number
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
   * 看圖作答：客人傳照片時，AI 先讀圖推出「客人想問什麼」，再走一般答題流程回覆客人。
   *
   * **預設關閉，而且是刻意的**：客人傳的照片多半是瑕疵品、付款失敗畫面、訂單爭議，
   * 本來就該真人處理；AI 認錯商品或誤讀金額還講得很篤定，比不回答更傷。
   * 關閉時 AI 仍會讀圖寫一句描述給客服看（那條路徑不對客人說話，見 media-describe），
   * 只是不會開口回覆——所以「先關著觀察描述準不準，再決定要不要開」是可行的漸進路徑。
   */
  imageAnswer: {
    /** 總開關；關閉時客人收到的仍是「我只看得懂文字」引導語 */
    enabled: boolean
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
  /**
   * 「N 天沒互動」自動標籤（CRM 分眾）：每天把「超過 N 天沒來訊」的客人貼上系統標籤，
   * 客人一回來就自動摘掉。標籤本身在 tags 集合（code=sys_inactive，見 inactive-tag.ts），
   * 推播分眾照常選這個標籤就好——分眾維度只有標籤一種，所以什麼都做成標籤（CRM-EVAL-20260822）。
   *
   * **預設開啟**：它不對客人說話、只在後台貼標，而且判斷基準 lastInboundMessageAt 是
   * 2026-08-19 才開始記的——天數門檻走完之前一筆都不會貼，天生就是漸進上線。
   */
  inactiveTag: {
    enabled: boolean
    /** 幾天沒來訊算「沒互動」（下限 7：太短會把週末沒講話的客人都標成沉睡） */
    days: number
  }
  /**
   * AI 讀對話自動貼標（建議式，D-24）：對話結束後 AI 從**現有標籤清單**挑 0～3 個建議，
   * 進收件匣等人採用——第一版刻意不直接貼（貼錯的下游是推錯人），跑順再談全自動。
   *
   * **預設關閉**：每場對話一次 LLM 呼叫是真金白銀，也要老闆先看過建議品質再開
   * （同 imageAnswer 的漸進路徑）。
   */
  autoTagSuggest: {
    enabled: boolean
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
  /** handoffs 的子集：客人指名真人、AI 沒出手（見 ai-usage.ts UsageDelta 說明） */
  directHandoffs?: number
  /** 反問澄清後成功答出的次數（followup 不記 answered，用這顆補能見度） */
  followupAnswered?: number
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
  /**
   * 傳了圖片／影片／語音／檔案後照引導語打「找真人」——起因是 AI 看不懂非文字內容，
   * 不是客人主動想找真人。分開記，監控頁才看得出「一排找真人」裡有多少其實是傳圖。
   */
  | 'non_text_content'
  /**
   * 檢索撈回的卡全是「別的產品」——這場對話在談 A，卡片只有 B 的資料。
   * 與 no_grounding 分開記：這不是「知識庫什麼都沒有」，而是「A 缺這個主題的卡」，
   * 補知識的動作不同（要補 A 的卡，不是從零建）。
   */
  | 'product_mismatch'
  /**
   * 客人在問「他自己那一筆」的進度（這筆到哪了、為什麼還沒退款、單號 123 出貨了嗎）。
   * 知識庫只有政策、沒有任何人的訂單資料 → 補卡永遠救不了，**不列入知識缺口**。
   * 與 no_grounding 分開記的理由：這不是缺知識，是缺「查得到訂單的人」，
   * 所以也不走「要不要幫您轉接」的二次確認，直接轉真人（少一次來回）。
   */
  | 'order_status'
  /**
   * 同一條自動回覆規則連著命中第二次——客人剛收到那段罐頭回覆、照著回了，關鍵字卻又打中同一條
   * （2026-08-07 正式站災情：「查詢訂單」規則的關鍵字含「訂單」，客人填回來的
   * 「1. 訂單編號：M…」再次命中 → 同一段話連送三次，而規則本身不會通知任何人）。
   * 再送一次只會複讀，所以直接轉真人。不是知識缺口——補卡救不了設定問題。
   */
  | 'auto_reply_repeat'

export interface AiConversationMeta {
  /** 最近一次 AI 介入的決定 */
  lastDecision: AiDecision
  lastConfidence: number
  lastHandoffReason: HandoffReason | null
  /** 觸發 AI 介入的使用者原文（用於監控頁顯示「客人問了什麼 AI 不會答」） */
  lastQuery: string
  /** 命中知識卡 ID（依相似度由高到低） */
  lastSourceChunkIds: string[]
  /**
   * 最近一次是怎麼被回答的（見 {@link AiAnswerKind}）。舊資料沒有這個欄位 → 視為 'kb'。
   * 後台脈絡卡靠它區分「查了沒東西」與「根本沒查」，不要用「信心 1.00 且沒命中卡」去猜。
   */
  lastAnswerKind?: AiAnswerKind
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
  /**
   * `llm_error` 時外部服務回了什麼（已去識別、截短，見 describeGeminiError）。
   *
   * 為什麼要存：2026-09-01 有一場真的失敗，事後想查是額度、過載還是逾時，
   * 發現錯誤內容只進過主機的即時日誌、資料庫只留「失敗」兩個字，只能靠排除法猜。
   * ⛔ 只給超管在「顯示技術細節」下看：這是給我們除錯的，不是給店家的待辦。
   */
  lastErrorDetail?: string
  updatedAt: Timestamp | FieldValue
}

/**
 * 一次 AI 回合的脈絡快照：`conversations/{doc}/aiTurns/{turnId}`。
 *
 * 為什麼要有這個：`aiMeta` 是「每位客人一張、每次 AI 互動整份覆寫」，一場對話 AI 回了五次
 * 就只剩第五次——前四次的把握度、命中哪張卡、當時的決定**在資料層面已經不存在**。
 * 造成的實際問題：客服發現 AI 答錯幾乎都在客人抱怨之後（此時已有新回合），那一題再也標不到；
 * 標記過的也只在它還是「最新那次」時取消得掉。
 *
 * 所以每一次 AI 回合都留一份，並把 turnId 蓋在那次送出的訊息上（`MessageDoc.aiTurnId`），
 * 泡泡旁的「為什麼這樣答」就能永遠指向**正確的那一次**。
 *
 * aiMeta 不會被取代：它仍是「這位客人現在的狀態」（反問等待中、cooldown、收件匣排序），
 * 兩者用途不同——一個是狀態、一個是歷史。
 */
export interface AiTurnDoc {
  workspaceId: string
  /** 對話文件 id（= 訊息所屬的 conversations doc）；跨對話查詢用 */
  userId: string
  decision: AiDecision
  confidence: number
  handoffReason: HandoffReason | null
  /** 觸發這一回合的客人原話 */
  query: string
  /** 命中知識卡 ID（依相似度由高到低） */
  sourceChunkIds: string[]
  answerKind: AiAnswerKind
  /** 草稿模式或轉真人時給客服參考的回覆 */
  suggestedReply: string
  /** 轉真人時的對話摘要 */
  handoffSummary: string
  /** `llm_error` 時外部服務回了什麼（已去識別、截短）；同 {@link AiConversationMeta.lastErrorDetail} */
  errorDetail?: string
  createdAt: Timestamp | FieldValue
  /** 保留期同其他事件流（240 天）；TTL policy 兩專案各手動設一次 */
  expireAt: Timestamp
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
  /** 這一題是怎麼被回答的（見 {@link AiAnswerKind}）；未標記時視為 'kb' */
  answerKind?: AiAnswerKind
  /** 給 debug 用：實際送進 LLM 的 prompt */
  debugPrompt?: string
}

/**
 * 「AI 是怎麼處理這一題的」——決定後台脈絡卡該說什麼話。
 *
 * 為什麼需要這個欄位：`sources` 空陣列有兩種完全不同的意思——
 * 「查了知識庫但沒東西」（真的是知識缺口，該補卡）與「根本沒查知識庫」
 * （招呼語／越界問題走罐頭回覆）。先前脈絡卡只看 sources 是否為空，
 * 於是客人說「謝謝」也被講成「知識庫沒有相關資訊，AI 答不出來」，
 * 還附一顆會把「謝謝」建成知識卡的按鈕。
 *
 *   social   ：招呼／道謝／道別 → 固定回覆，沒查知識庫
 *   offtopic ：與本店無關的要求（天氣／寫詩／打探系統）→ 禮貌拒答，沒查知識庫
 *   kb       ：走檢索生成（sources 為空才是真的沒依據）
 */
export type AiAnswerKind = 'social' | 'offtopic' | 'kb'

// ═══════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════

export const EMBEDDING_DIMENSION = 768

/**
 * 「內容過短」判定門檻（去空白後的 content 字數）。卡片短到這種程度時檢索命中也答不出
 * 東西，多半是切壞或抓壞的殘片。
 *
 * **前後端共用同一把尺**：來源頁的逐卡警示與知識庫體檢的計數若各用各的門檻，
 * 會出現「體檢說有 5 張過短、點進去一張都沒標記」的自相矛盾。
 */
export const SHORT_CHUNK_CONTENT_CHARS = 30

/** 去空白後的內容字數是否低於門檻（前後端共用，避免判定漂移） */
export function isShortChunkContent(content: unknown): boolean {
  return String(content ?? '').replace(/\s+/g, '').length < SHORT_CHUNK_CONTENT_CHARS
}

/**
 * 「這份資料該設所屬產品卻沒設」的判定（前後端共用同一把尺）。
 *
 * 命中的典型情況＝一份說明書切成很多條卻沒說是哪一台：客人指名問的時候，
 * 這些無主的知識可能被拿去回答**別台**的問題。
 * 刻意只抓檔案類：FAQ／公告多半是網址或試算表，多產品是正常的，標出來只會變成雜訊；
 * 型錄／列表（generateOverview）旗下本來就是很多不同產品，也不該問它「是哪一台」。
 *
 * 體檢清單與資料列表各寫一次判斷的話，會出現「列表標著未設產品、體檢卻不算它」
 * 這種兩邊說法不一致的情形（本專案已經在「內容過短」上踩過同一種雷）。
 */
export const NO_PRODUCT_MIN_CHUNKS = 5

export function needsProductName(src: {
  type?: string
  productName?: string
  generateOverview?: boolean
  chunkCount?: number
}): boolean {
  return src.type === 'file'
    && !String(src.productName ?? '').trim()
    && src.generateOverview !== true
    && Number(src.chunkCount ?? 0) >= NO_PRODUCT_MIN_CHUNKS
}

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

/**
 * 真人接手中的會話，雙方都沒動靜超過此時數 → 系統自動收尾（結束會話）。
 *
 * 這是**保底**不是常規手段：真人接手中的場刻意不吃 24 小時自動結束（客人隔天回來要接在
 * 同一場，見 isHumanOwnedSessionStatus），代價是它不會自己消失。客服一定會有忘記按
 * 「結束會話」的時候，而真人接手期間機器人是閉嘴的——忘了按就等於這位客人從此收不到
 * 任何自動回覆；沒關的場也會一直被背景查詢掃到（2026-08-11 讀取費暴衝有這一份）。
 *
 * **2026-08-21 老闆拍板改成開關、預設關（`0`）**：「真人沒有切就不要轉，等真人按下結束
 * 才結束。」上面那兩個坑的第一個已經不存在——`H-13` 之後「AI 要不要閉嘴」看的是對話上的
 * `lastHumanActionAt` 記號，不再靠這場會話有沒有開著，所以自動結束與否不影響客人收不收得到
 * 自動回覆。剩下的代價只有「沒收尾的場會一直留在『真人處理中』分頁、越積越多」。
 *
 * 開啟時的建議值仍是 48 小時（跨過一個週末以外的空檔還夠用），見
 * SUGGESTED_HUMAN_SESSION_MAX_IDLE_HOURS——那是「打開開關時填進去的預設值」，
 * 不是「沒設定時的預設行為」，兩者刻意分開，否則舊工作區會被當成有開。
 */
export const DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS = 0
/** 打開「自動結束」開關時填入的時數（前端用；後端只認 0＝關、>0＝開） */
export const SUGGESTED_HUMAN_SESSION_MAX_IDLE_HOURS = 48
export const MIN_HUMAN_SESSION_MAX_IDLE_HOURS = 6
export const MAX_HUMAN_SESSION_MAX_IDLE_HOURS = 336

/** 轉真人後超時再提醒（分鐘）；0 = 關閉。單一事實來源：normalize / buildDefault / 前端表單都引用這裡 */
// 2026-08-06 拍板從 15 放寬到 30：15 分鐘在人力吃緊時幾乎場場觸發,是內部推播成本第二大項
export const DEFAULT_SLA_REMIND_MINUTES = 30

/** 每日摘要發送時段預設（台北時間整點） */
export const DEFAULT_DIGEST_HOUR = 9

/**
 * 系統從哪一天開始記「客人最後一次來訊」（`conversations.lastInboundMessageAt`）。
 *
 * 這是**部署事實**不是設定：在這天之前就沒再來訊的客人查不到那個時間，所以
 * ①「N 天沒互動」標籤的第一批會晚一點才出現 ②客人檔案的「最後來訊」要據此換句話說。
 * ⛔ 單一事實來源——這個日期出現在客人檔案與 AI 設定頁兩處文案，別各寫一份字串。
 */
export const INBOUND_TIME_TRACKING_SINCE = '2026-08-19'

/** 「N 天沒互動」自動標籤的天數。單一事實來源：normalize / buildDefault / 前端表單都引用這裡 */
export const DEFAULT_INACTIVE_TAG_DAYS = 60
export const MIN_INACTIVE_TAG_DAYS = 7
export const MAX_INACTIVE_TAG_DAYS = 365

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

/**
 * 屬於「知識缺口」的轉真人原因：AI 真的查了知識庫、但答不出來 → 補一張卡下次就會答。
 *
 * 其餘原因補知識沒有用，也不該對客服喊「知識庫沒有相關資訊」：
 * 客人自己要求真人、敏感主題、業務洽詢（要人談）、用量已滿、AI 服務失敗、人工指定、
 * 傳了圖片/檔案（AI 看不懂圖，補文字卡救不了）。
 * 缺口聚類（scanKnowledgeGaps）與後台脈絡卡共用這一份，兩邊口徑才不會各走各的。
 */
export const KNOWLEDGE_GAP_HANDOFF_REASONS: ReadonlySet<string> = new Set<HandoffReason>([
  'no_grounding',
  'low_confidence',
  'unresolved',
  // 「在談 A、卡片只有 B」也是知識缺口（A 缺這個主題），補卡就能救
  'product_mismatch',
])

/** {@link isKnowledgeGapContext} 需要的最小資訊（對話頁脈絡卡的回應形狀） */
export interface AiContextGapInput {
  lastDecision: AiDecision | ''
  lastHandoffReason: HandoffReason | null
  /** 舊資料沒有這個欄位 → 視為 'kb' */
  lastAnswerKind?: AiAnswerKind
  /** 命中的知識卡數 */
  sourceCount: number
  /** 有沒有 AI 草稿（有草稿就不是「答不出來」） */
  hasSuggestedReply: boolean
}

/**
 * 這一次互動是不是**真的**「知識庫沒有相關資訊」？
 *
 * 為什麼要一個函式而不是在畫面上寫條件：先前脈絡卡只看「有沒有命中知識卡」，
 * 於是客人說「謝謝」（走罐頭回覆、根本沒查知識庫）也被寫成「知識庫沒有相關資訊，
 * AI 這題答不出來」，還附一顆會把「謝謝」建成知識卡的按鈕。
 *
 * 判斷規則：
 *   - 有草稿 → 不是答不出來
 *   - 沒查知識庫（social / offtopic）→ 不是知識缺口
 *   - 轉真人 → 只有「查不到／信心不足／排除沒解決」才算（其餘補知識救不了）
 *   - 其餘（走了檢索的答題／反問）→ 沒命中任何卡才算
 */
export function isKnowledgeGapContext(c: AiContextGapInput): boolean {
  if (c.hasSuggestedReply) return false
  if ((c.lastAnswerKind ?? 'kb') !== 'kb') return false
  if (c.lastDecision === 'handoff' || c.lastDecision === 'handoff_confirm') {
    return KNOWLEDGE_GAP_HANDOFF_REASONS.has(String(c.lastHandoffReason ?? ''))
  }
  return c.sourceCount === 0
}

/**
 * 後台脈絡卡的回應形狀。**兩支端點共用**：
 *   - `ai-context`（這位客人最近一次，讀 aiMeta）
 *   - `ai-turn/:turnId`（某一則 AI 回覆當時，讀 aiTurns）
 *
 * 共用是刻意的：畫面只有一個脈絡元件，兩邊回不同形狀就會養出兩套說法。
 */
export interface AiContextPayload {
  hasMeta: boolean
  lastDecision: AiDecision | ''
  lastConfidence: number
  lastHandoffReason: HandoffReason | null
  lastQuery: string
  lastAnswerKind: AiAnswerKind
  suggestedReply: string
  handoffSummary: string
  /**
   * 客服按「我接手」時產生的對話摘要（見 conversation-summary.ts）。
   * 與 handoffSummary 是兩件事：那個只有「AI 自己決定轉真人」時才有，
   * 這個涵蓋客服主動接手——也就是最需要快速掌握前因後果的那個時刻。
   */
  takeoverSummary: string
  takeoverSummaryAtMs: number
  /**
   * AI 是草稿模式嗎？草稿模式下 AI **不對客人發訊息**，所以對話上沒有 AI 泡泡，
   * 也就沒有「為什麼這樣答」可以點——此時頂部卡片是唯一看得到判斷依據的地方，
   * 要把完整脈絡留在上面（見 AiContextBanner）。
   */
  draftMode: boolean
  /** exists=false＝卡已被刪：不給「去修這張卡」的連結（點下去只會說找不到） */
  sources: Array<{ chunkId: string; title: string; exists: boolean }>
  wrongMarked: boolean
  /**
   * 這一次 AI 回合的識別。有值＝脈絡來自 aiTurns，回饋直接綁這一回合（舊回合也標得到、取消得掉）；
   * 空字串＝來自 aiMeta 的「最近一次」，只能用 updatedAtMs 指認（見 ai-feedback.post.ts 的樂觀鎖）。
   */
  turnId: string
  /** aiMeta 的更新時間（毫秒）。turnId 有值時不使用。 */
  updatedAtMs: number
}

/** {@link isAiContextWithinSession} 的會話時間範圍（endMs 可為 Infinity＝這場還沒結束） */
export interface AiContextSessionWindow {
  startMs: number
  endMs: number
}

/**
 * 手上這張脈絡（aiMeta）屬於眼前這場會話嗎？
 *
 * aiMeta 是「每位客人一張、每次 AI 互動整份覆寫」，不分場次。從側欄點進一場已結束的
 * 舊會話時，訊息換成那場的、脈絡卡卻還是最新那次——兩邊兜不起來；更糟的是此時按
 * 「這題 AI 答錯了」**會成功**記到最新那次頭上：時間戳與後端一致，後端的樂觀鎖只擋得住
 * 「互動被更新了」，擋不到「客服看錯場次」。所以窗口對不上就不顯示、也不給操作。
 *
 * @param window null＝看的是進行中的對話而非特定場次 → 一律算數（維持原本行為）
 */
export function isAiContextWithinSession(
  updatedAtMs: number,
  window: AiContextSessionWindow | null | undefined,
): boolean {
  if (!window) return true
  // 判不出時間就不給操作：寧可少一張卡，也不要讓人對著錯的場次按「答錯」
  if (!(updatedAtMs > 0)) return false
  return updatedAtMs >= window.startMs && updatedAtMs <= window.endMs
}

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
  non_text_content: '傳了圖片/檔案',
  product_mismatch: '這個產品沒有這題的資料',
  order_status: '要查客人的訂單',
  auto_reply_repeat: '自動回覆一直重複',
}

// ═══════════════════════════════════════════════════════════════════
//  知識缺口建議（建議收件匣）
//  從 aiHandoffEvents 事件流聚類「客人問了但 AI 答不出」的主題，LLM 先擬好
//  知識卡草稿，店家在後台審核採用/忽略。一筆 = 一個主題（不是一筆事件）。
// ═══════════════════════════════════════════════════════════════════

/**
 * accepting = 採用進行中的中間態（交易佔位）。建卡要好幾秒（含 embedding），
 * 沒有這個中間態的話兩個分頁同時按「採用」會各建一張幾乎一樣的卡。
 */
export type KnowledgeSuggestionStatus = 'pending' | 'accepting' | 'accepted' | 'dismissed'

/**
 * 草稿裡「知識庫查不到、LLM 依規則留空」的佔位符。
 * 前端顯示警示、後端擋下採用都用這一支——各寫一份正則的下場是:
 * LLM 漏寫冒號時前端說草稿乾淨、後端 400 擋下,使用者看不到哪裡要補。
 * 冒號刻意不強制(LLM 偶爾寫成「【請填寫金額】」)。
 */
export const KNOWLEDGE_DRAFT_BLANK_RE = /【請填寫[^】]*】/g

export function countKnowledgeDraftBlanks(content: string): number {
  return (String(content ?? '').match(KNOWLEDGE_DRAFT_BLANK_RE) ?? []).length
}

export interface KnowledgeSuggestionDraft {
  title: string
  content: string
  tags: string[]
  questions: string[]
}

/** collection: knowledgeSuggestions */
export interface KnowledgeSuggestionDoc {
  workspaceId: string
  status: KnowledgeSuggestionStatus
  /** 給列表看的主題名（LLM 命名，≤12 字） */
  topic: string
  /** 樣本問句（客人原話，最多 5 條，給人看） */
  sampleQueries: string[]
  /** 涵蓋的全部去重問句（最多 30 條）：採用後拿來把監控頁對應案例自動標已處理 */
  queries: string[]
  /** 30 天窗口內命中此主題的事件數 */
  eventCount: number
  /** 聚類中心向量：同主題下次掃描再出現時靠它比對，避免重複建議 */
  centroid: number[]
  /** LLM 擬好的草稿；草擬失敗為 null（主題照樣顯示，讓人手寫） */
  draft: KnowledgeSuggestionDraft | null
  /**
   * 草稿內「【請填寫：…】」佔位符數量。>0 代表知識庫裡沒有這些事實、LLM 依規則
   * 留空不編造，店家補完才能採用——這是內容品質防護，不是缺陷。
   */
  blanksCount: number
  draftError?: string
  /**
   * eventCount 是取樣值（事件掃描或問句數撞到上限）。UI 要改講「至少 N 次」——
   * 取樣數字印成實數會讓店家以為那就是全部。
   */
  sampled?: boolean
  createdAt: unknown
  updatedAt: unknown
  /** 最近一筆命中事件的時間 */
  lastSeenAt: unknown
  /**
   * 只有 accepted / dismissed 才會帶：處理完的建議 180 天後由 TTL 清掉。
   * 不清的話這個 collection 只增不減，去重查詢的上限總會被撞到（撞到就會重複推薦已處理的主題）。
   * pending 沒有這個欄位 → 不受 TTL 影響。
   */
  expireAt?: unknown
  acceptedAt?: unknown
  acceptedChunkId?: string
  acceptedSourceId?: string
  dismissedAt?: unknown
  /** 忽略當下的事件數：同主題事件數翻倍才重新浮出，避免「狼來了」 */
  seenCountAtDismiss?: number
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
      mode: 'always',
      slaRemindMinutes: DEFAULT_SLA_REMIND_MINUTES,
      digestHour: DEFAULT_DIGEST_HOUR,
      festivalTips: true,
      weeklyInsights: true,
      criticalAlertPush: true,
    },
    handbackIdleMinutes: DEFAULT_HANDBACK_IDLE_MINUTES,
    humanSessionMaxIdleHours: DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS,
    disambiguation: {
      enabled: DEFAULT_DISAMBIGUATION_ENABLED,
      top1Min: DEFAULT_DISAMBIGUATION_TOP1_MIN,
      top1Max: DEFAULT_DISAMBIGUATION_TOP1_MAX,
      maxSpread: DEFAULT_DISAMBIGUATION_MAX_SPREAD,
      maxOptions: DEFAULT_DISAMBIGUATION_MAX_OPTIONS,
      cooldownMinutes: DEFAULT_DISAMBIGUATION_COOLDOWN_MINUTES,
    },
    imageAnswer: {
      enabled: false, // 預設關閉:這會讓 AI 對客人開口談照片內容,要老闆確認過描述品質才開
    },
    serviceHours: {
      enabled: false, // 預設關閉:不影響任何轉真人行為,要用才開
      start: '09:00',
      end: '18:00',
      weekendOff: true,
      dndReply: DEFAULT_DND_REPLY,
    },
    inactiveTag: {
      enabled: true, // 預設開啟:不對客人說話、判斷欄位 08-19 起才有＝天生漸進,見介面註解
      days: DEFAULT_INACTIVE_TAG_DAYS,
    },
    autoTagSuggest: {
      enabled: false, // 預設關閉:每場對話一次 LLM 費用,老闆看過建議品質才開(同 imageAnswer)
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
