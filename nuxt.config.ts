// https://nuxt.com/docs/api/configuration/nuxt-config

/** 對外 HTTPS 原點（無尾斜線）：圖文 Imagemap、推播 /api/r 點擊追蹤共用。建議只設 PUBLIC_BASE_URL；舊名 LINE_IMAGEMAP_BASE_URL、CLICK_TRACKING_BASE_URL 仍相容。 */
const appPublicBaseUrl = String(
  process.env.PUBLIC_BASE_URL
    || process.env.LINE_IMAGEMAP_BASE_URL
    || process.env.CLICK_TRACKING_BASE_URL
    || '',
).trim()

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  nitro: {
    preset: 'aws-amplify',
    experimental: {
      tasks: true,
    },
    scheduledTasks: {
      // ⚠️ 這些排程只在本機 `nuxt dev` 跑（Amplify 不打包 Nitro tasks），而 dev 讀的是 .env
      //    ＝**正式** Firestore 與 LINE 憑證。開著 dev 就等於替正式環境多開一個排程執行者,
      //    會真的動正式資料、真的發訊息,還會與 Cloud Scheduler 撞同一輪把同一件事做兩次
      //    （2026-08-07 現場：客服的 SLA 逾時提醒每則收到兩份）。
      //    因此每個 task 內部都有 localScheduledTasksEnabled() 閘門，預設不動作；
      //    要在本機驗排程行為請設 LOCAL_SCHEDULED_TASKS=true（先確認 .env 指向測試租戶）。
      //    見 server/utils/local-scheduled-tasks.ts。
      // 本機 dev 等環境；正式環境主要依 server/plugins/broadcast-scheduler.ts
      '* * * * *': ['broadcast:trigger-scheduled'],
      // 每 5 分鐘撿 failed / 卡住的知識卡重新索引
      '*/5 * * * *': ['ai:retry-stuck-chunks'],
      // 每 15 分鐘清掉過期的知識庫預覽 job（Firestore 文件 + Storage temp）
      '*/15 * * * *': ['ai:cleanup-preview-jobs'],
      // 每 30 分鐘掃 URL 來源是否內容變動（每個 source 的實際偵測頻率由 refreshIntervalMinutes 決定）
      // + 知識缺口掃描。注意這裡只影響本機 dev；生產走 /api/cron/run-tasks，是 10 分鐘輪
      // （Amplify 不打包 Nitro tasks）——調整節流要改 ai-knowledge-suggest.ts 裡的常數，不是這裡。
      '*/30 * * * *': ['ai:detect-source-updates', 'ai:knowledge-gap-scan'],
      // 每 10 分鐘掃「真人處理中但閒置過久」的會話自動交還機器人（handbackIdleMinutes=0 不動作）
      // + 「轉真人超時無人回應」的 SLA 提醒（每場會話一次）
      // + 真人接手中但雙方都沒動靜太久的會話自動結束（那種場不吃 24 小時自動結束）
      '*/10 * * * *': ['conversation:auto-handback', 'conversation:handoff-sla', 'conversation:auto-close-idle'],
      // 每小時清理過期的 webhook 冪等鎖（Firestore TTL 的程式內保底）
      '0 * * * *': ['webhook:cleanup-event-locks'],
    },
  },

  modules: [
    '@element-plus/nuxt'
  ],

  elementPlus: {
    importStyle: 'scss',
  },

  // Disable SSR for admin pages — they are behind auth and don't need SEO
  routeRules: {
    '/admin/**': { ssr: false },
    '/liff/**': { ssr: false },
  },

  vite: {
    // 本機用 ngrok tunnel 測金流 Notify 時,dev server 需放行 ngrok host（否則回 403 Blocked request）。
    // 只影響 dev,且限 ngrok 網域;正式部署不吃這段。
    server: {
      allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.io'],
    },
    css: {
      preprocessorOptions: {
        scss: {
          // Vite 7 型別未收錄 sass-embedded 的 api 選項，但執行期支援
          api: 'modern-compiler',
          additionalData: `@use "~/assets/scss/element-variables.scss" as *;`,
        } as Record<string, unknown>,
      },
    },
  },

  css: ['~/assets/scss/main.scss'],

  app: {
    head: {
      link: [
        /* 瀏覽器圖示＝品牌 logomark（只有圖標的版本）。
           三個都要留：SVG 給現役瀏覽器（不隨解析度模糊）、.ico 給舊版與 Windows 捷徑、
           apple-touch-icon 給 iOS 主畫面（iOS 不吃 SVG，且會把透明底壓成黑色）。
           兩個點陣檔由 `npm run build:icons` 從 logomark.svg 鋪白底轉出，換 logo 後要重跑。 */
        { rel: 'icon', type: 'image/svg+xml', href: '/logomark.svg' },
        { rel: 'icon', type: 'image/x-icon', sizes: '48x48', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        // 繁中主字型：Google Fonts 依 unicode-range 分片，只下載實際用到的字；native 字型為 fallback（display=swap 不擋首屏）
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap' },
      ],
    },
  },

  runtimeConfig: {
    // Server-only (private)
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
    lineChannelSecret: process.env.LINE_CHANNEL_SECRET ?? '',
    /** 與 clickTrackingBaseUrl 同源，皆來自 PUBLIC_BASE_URL（或舊環境變數 fallback） */
    lineImagemapBaseUrl: appPublicBaseUrl,
    clickTrackingBaseUrl: appPublicBaseUrl,
    /** 排程推播自動觸發保護密鑰；由 Cron Job 帶在 X-Cron-Secret header */
    cronSecret: process.env.CRON_SECRET ?? '',
    /** 對話訊息保留天數（超過天數會由 cleanup API 清掉） */
    conversationRetentionDays: process.env.CONVERSATION_RETENTION_DAYS ?? '180',
    /** 單次 cleanup 最多刪除幾筆舊訊息（Firestore batch 上限 500） */
    conversationCleanupBatchSize: process.env.CONVERSATION_CLEANUP_BATCH_SIZE ?? '400',
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? '',
    firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
    firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY ?? '',
    firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? '',
    /** Google AI Studio API key（Gemini answer + embedding 共用）。申請：https://aistudio.google.com/apikey */
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    /*
     * ⛔ 藍新金流（newebpay）已於 2026-08-16 整組移除（`B-23`），**不要加回來**。
     *    移除前查過兩個專案的真實資料：沒有任何訂單或訂閱真的走過藍新
     *    （唯一帶 periodNo 的那筆值與測試檔裡的字串一模一樣＝測試殘留，且無信用卡約定）。
     *    留著的風險是 /newebpay/notify 這條路由本身——只要有人把金鑰填回環境變數，
     *    它就重新變成一個可以開通訂閱的入口，而那條路徑沒有任何人在看。
     *    `shared/types/payment.ts` 的 periodNo 等欄位刻意保留，只為讀得懂歷史資料。
     */
    /**
     * PAYUNi 統一金流 整合式支付頁（UPP）特店設定（每租戶各一組；private，勿放 public）。
     * 加密與藍新不同（AES-256-GCM）。三把金鑰都設好 → paymentEnabled 才為 true。
     * PAYUNI_ENV=test 走 sandbox-api.payuni.com.tw、prod 走 api.payuni.com.tw（見 payuni.ts）。
     * Hash Key 固定 32 碼、IV Key 固定 16 碼（長度不符後端會直接報錯）。
     */
    payuniMerchantId: process.env.PAYUNI_MERCHANT_ID ?? '',
    payuniHashKey: process.env.PAYUNI_HASH_KEY ?? '',
    payuniHashIV: process.env.PAYUNI_HASH_IV ?? '',
    payuniEnv: process.env.PAYUNI_ENV ?? 'test',
    /**
     * 每月自動扣款（PAYUNi 信用卡約定 Token 幕後扣款）的灰度開關。
     * true → 首刷走 UPP 建立約定拿 `CreditHash`，之後每期由我方排程打 /api/credit 幕後扣款。
     *
     * ⚠️ 正式特店要先向 PAYUNi 申請開通「信用卡 Token／幕後扣款」並綁定授權 IP,否則會被擋。
     * ⚠️ 留白／false → **完全走現行單次付款,一行行為都不變**（首刷不帶建約定參數、
     *    收單也不會存 Token）。設計見 docs/PAYUNI-RECURRING-DESIGN.md。
     */
    payuniPeriodEnabled: process.env.PAYUNI_PERIOD_ENABLED === 'true',
    /**
     * 固定 IP 中繼站（只給「幕後」API 用:續扣 /api/credit、解約 /api/credit_bind/*）。
     *
     * PAYUNi 幕後 API 會檢查來源 IP（後台可填 10 組**單一** IP,不支援網段),而 Amplify
     * 對外 IP 會變動（2026-08-04 實測一天換 4 個）→ 正式環境需把幕後呼叫收斂到一個固定出口。
     * 設成中繼站基底網址（例 `https://relay.example.com`,無尾斜線),中繼站把 `/api/*`
     * 原樣轉發到 PAYUNi 對應環境的主機即可。
     *
     * ⚠️ 客戶刷卡的 UPP 付款頁**永遠直連 PAYUNi**,不經過中繼站 → 中繼站掛掉只會讓
     *    「本期自動扣款延到隔天」,不影響客人付款。
     * ⚠️ 留白 = 直連 PAYUNi（現行行為）。詳見 payuni.ts 的 resolveBackendUrl。
     */
    payuniRelayBase: process.env.PAYUNI_RELAY_BASE ?? '',
    /**
     * 光貿(Amego)電子發票加值中心（**獨立於金流的商店帳號**，需另外向光貿申請）。
     * 未設定 → 收款照常，只是不開發票(見 guangmao-invoice.ts 的 isInvoiceConfigured)。
     *
     * ⚠️ apiUrl **刻意不給預設值**。若預設成正式站，沙盒測試就會把測試發票開到正式平台;
     *    反之亦然。三個值必須全設才會啟用開票。
     *    沙盒網址請向光貿索取;正式 https://invoice-api.amego.tw
     */
    guangmaoInvoiceSellerUBN: process.env.GUANGMAO_INVOICE_SELLER_UBN ?? '',
    guangmaoInvoiceAppKey: process.env.GUANGMAO_INVOICE_APP_KEY ?? '',
    guangmaoInvoiceApiUrl: process.env.GUANGMAO_INVOICE_API_URL ?? '',
    /** 對外 HTTPS 原點（金流 Notify/Return 導回用）；與 clickTrackingBaseUrl 同源 */
    appBaseUrl: appPublicBaseUrl,
    /**
     * 交易通知信（AWS SES）。付款收據、扣款失敗、續扣提醒、額度用完會寄到客戶的帳務信箱。
     *
     * ⚠️ 三個都要設齊才會真的寄信（見 isEmailConfigured）：
     *   - EMAIL_FROM：寄件人（**必須是 SES 已驗證的網域／信箱**，否則 SES 會拒寄），
     *     可帶顯示名稱，例：`MYFEEL <noreply@yourdomain.com>`
     *   - AWS_SES_REGION：SES 所在區域（例 ap-northeast-1）
     *   憑證由 Amplify 執行角色 / 環境自動解析（SDK 預設鏈），不放這裡。
     *   未設定 → 全部寄信變 no-op（只 log），金流／排程流程照常不受影響。
     */
    emailFrom: process.env.EMAIL_FROM ?? '',
    emailReplyTo: process.env.EMAIL_REPLY_TO ?? '',
    awsSesRegion: process.env.AWS_SES_REGION ?? process.env.AWS_REGION ?? '',
    // 超管成本頁讀 AWS 帳單用（唯讀 ce:GetCostAndUsage）。
    // ⛔ 環境變數不能用 AWS 開頭：Amplify 主控台整個擋掉 "AWS" 前綴（reserved prefix，
    //    存檔直接報錯），Lambda 又會自動蓋掉 AWS_ACCESS_KEY_ID 那三個保留名。
    //    所以取名 COST_EXPLORER_*。留空則走預設憑證鏈。見 docs/AWS-COST-SETUP.md
    awsCostAccessKeyId: process.env.COST_EXPLORER_ACCESS_KEY_ID ?? '',
    awsCostSecretAccessKey: process.env.COST_EXPLORER_SECRET_ACCESS_KEY ?? '',

    // Public (exposed to client)
    public: {
      firebaseApiKey: process.env.FIREBASE_API_KEY ?? '',
      firebaseAuthDomain: process.env.FIREBASE_AUTH_DOMAIN ?? '',
      firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? '',
      firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? '',
      firebaseMessagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID ?? '',
      firebaseAppId: process.env.FIREBASE_APP_ID ?? '',
      /** 升級／加購的聯繫方式（email 或 https 連結）；顯示於「升級方案」對話框。未設則退回客服信箱。 */
      supportContact: process.env.PUBLIC_SUPPORT_CONTACT ?? process.env.PUBLIC_SUPPORT_EMAIL ?? 'service@myfeel-tw.com',
      /**
       * 對外品牌＝產品名（MiniMe）：門面商標、登入頁、付款頁商品描述、電子發票品名都用它。
       *
       * ⚠️ 品牌名 ≠ 公司名。營運主體是 legalCompanyName（麥菲爾股份有限公司）——
       *    發票賣方、法務頁主體、風控核對的「公司名稱」是那一個，兩者不可互換。
       * 多租戶：各 deployment 可用 PUBLIC_BRAND_NAME 覆寫。
       */
      brandName: process.env.PUBLIC_BRAND_NAME ?? 'MiniMe',
      /**
       * ── 營運主體與客服資訊（官網 footer／隱私權・服務條款・退費政策頁共用）─────────
       *
       * ⚠️ 這一組是**信用卡收單的合規要求**,不是純裝飾:金流（PAYUNi）風控審核會逐項核對
       *    官網是否公開「公司名稱、統一編號、客服信箱、客服電話、隱私權政策、退換貨（退費）條款」,
       *    缺一項就退件。改動前請先確認與送審資料一致。
       *
       * 預設值 = 本平台營運主體;多租戶部署可用 env 覆寫成自己的公司（同 brandName 的做法）。
       */
      legalCompanyName: process.env.PUBLIC_LEGAL_COMPANY_NAME ?? '麥菲爾股份有限公司',
      /**
       * 信用卡帳單上的請款名稱 —— **與品牌名不同，要逐字照收單登記填**。
       * 本平台是小寫 `myfeel`（2026-08-16 實開 PAYUNi 正式付款頁確認）。
       * 為什麼要公開揭露它：見 shared/billing/statement.ts 的檔頭（爭議款自負）。
       */
      cardStatementName: process.env.PUBLIC_CARD_STATEMENT_NAME ?? 'myfeel',
      legalTaxId: process.env.PUBLIC_LEGAL_TAX_ID ?? '83610942',
      supportEmail: process.env.PUBLIC_SUPPORT_EMAIL ?? 'service@myfeel-tw.com',
      supportPhone: process.env.PUBLIC_SUPPORT_PHONE ?? '+886-2-7702-1310',
      supportHours: process.env.PUBLIC_SUPPORT_HOURS ?? '週一至週五 10:00–18:00',
      /**
       * 產品全名 = 向金流申報的「商品名稱」，必須逐字一致——風控會拿官網的商品資訊、
       * 付款頁的商品描述、電子發票品名互相核對（見 legalCompanyName 註解）。
       */
      serviceFullName: process.env.PUBLIC_SERVICE_FULL_NAME ?? 'LINE MiniMe AI CRM 與客服系統',
      /**
       * 線上付款是否已開通（PAYUNi 統一金流 三把金鑰都設好才為 true）。
       * 只是布林值、不含任何金鑰內容；前端據此決定結帳鈕能不能按，
       * 避免金流未設定時按下去只拿到 500「金流尚未設定」。
       * ⚠️ build 時計算：金鑰設好後要重新 build/部署才會變 true。
       */
      paymentEnabled: Boolean(
        process.env.PAYUNI_MERCHANT_ID
        && process.env.PAYUNI_HASH_KEY
        && process.env.PAYUNI_HASH_IV,
      ),
      /**
       * 結帳是否走「每月自動扣款」而非單次付款（前端據此改結帳文案與同意內容）。
       *
       * 與 server 端的 `payuniPeriodEnabled` **同一個 env**（PAYUNI_PERIOD_ENABLED）——
       * 必須同源:前端說「單次付款」而後端偷偷建了約定,是同意瑕疵,不只是文案不一致。
       * 兩條路都走 `/api/payment/create-order`,差別只在 EncryptInfo 多帶建約定欄位。
       * ⚠️ build 時計算：設好後要重新 build/部署才會生效（同 paymentEnabled）。
       */
      recurringEnabled: process.env.PAYUNI_PERIOD_ENABLED === 'true',
      /**
       * 電子發票是否已開通（前端據此顯示／隱藏「發票資訊」設定卡、發票號碼欄、作廢／折讓按鈕）。
       * **必須與後端 isInvoiceConfigured 檢查的是同一組 env**（見 guangmao-invoice.ts）——
       * 否則會出現「後端有開票、前端看不到發票」或反之的鬼打牆。三個值缺一不可。
       * ⚠️ build 時計算：金鑰設好後要重新 build/部署才會變 true（同 paymentEnabled）。
       */
      invoiceEnabled: Boolean(
        process.env.GUANGMAO_INVOICE_SELLER_UBN
        && process.env.GUANGMAO_INVOICE_APP_KEY
        && process.env.GUANGMAO_INVOICE_API_URL,
      ),
      /**
       * 官方 FAQ 範本的 Google Sheet 母本網址（開「知道連結者可檢視」）。
       * 設定後匯入對話框顯示「使用 FAQ 範本」按鈕（自動轉 /copy 一鍵建立副本）；
       * 未設則退回下載 public/templates/faq-sheet-template.xlsx。
       */
      faqTemplateSheetUrl: process.env.PUBLIC_FAQ_TEMPLATE_SHEET_URL ?? '',
    },
  },
})
