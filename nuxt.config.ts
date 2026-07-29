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
      // 本機 dev 等環境；正式環境主要依 server/plugins/broadcast-scheduler.ts
      '* * * * *': ['broadcast:trigger-scheduled'],
      // 每 5 分鐘撿 failed / 卡住的知識卡重新索引
      '*/5 * * * *': ['ai:retry-stuck-chunks'],
      // 每 15 分鐘清掉過期的知識庫預覽 job（Firestore 文件 + Storage temp）
      '*/15 * * * *': ['ai:cleanup-preview-jobs'],
      // 每 30 分鐘掃 URL 來源是否內容變動（每個 source 的實際偵測頻率由 refreshIntervalMinutes 決定）
      '*/30 * * * *': ['ai:detect-source-updates'],
      // 每 10 分鐘掃「真人處理中但閒置過久」的會話自動交還機器人（handbackIdleMinutes=0 不動作）
      // + 「轉真人超時無人回應」的 SLA 提醒（每場會話一次）
      '*/10 * * * *': ['conversation:auto-handback', 'conversation:handoff-sla'],
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
    /**
     * 藍新金流 MPG 特店設定（每租戶各一組；private，勿放 public 以免金鑰外洩）。
     * 測試特店 API 用 ccore.newebpay.com、正式用 core.newebpay.com。
     */
    newebpayMerchantId: process.env.NEWEBPAY_MERCHANT_ID ?? '',
    newebpayHashKey: process.env.NEWEBPAY_HASH_KEY ?? '',
    newebpayHashIV: process.env.NEWEBPAY_HASH_IV ?? '',
    newebpayApiUrl: process.env.NEWEBPAY_API_URL ?? 'https://ccore.newebpay.com/MPG/mpg_gateway',
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
     * 信用卡定期定額（自動續訂）。與 MPG 共用同一組特店金鑰,只是換一支端點。
     * ⚠️ 定期定額是**申請制**——要先在藍新特店後台啟用「定期定額支付工具」才會通;
     *    未啟用時把 NEWEBPAY_PERIOD_ENABLED 留白,結帳會退回一次性付款,不會壞掉。
     */
    newebpayPeriodEnabled: process.env.NEWEBPAY_PERIOD_ENABLED === 'true',
    newebpayPeriodApiUrl: process.env.NEWEBPAY_PERIOD_API_URL ?? 'https://ccore.newebpay.com/MPG/period',
    newebpayPeriodAlterUrl: process.env.NEWEBPAY_PERIOD_ALTER_URL ?? 'https://ccore.newebpay.com/MPG/period/AlterStatus',
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
       * 結帳是否走「自動續訂」（定期定額委託）而非一次性付款。
       * ⚠️ 目前**一律 false**：已改用 PAYUNi 單次付款,PAYUNi 的定期定額（信用卡約定扣款）尚未實作。
       *    留 false 確保前端**不會走到藍新那條殘留的 `create-subscription` 路徑**（那是藍新、金鑰也沒設,
       *    一觸即壞）。等 PAYUNi 定期定額做好,再改成由 PAYUNI_PERIOD 之類旗標計算並接 PAYUNi 委託。
       */
      recurringEnabled: false,
      /** 電子發票是否已開通（前端據此顯示／隱藏「發票資訊」設定卡）。四個值缺一不可。 */
      invoiceEnabled: Boolean(
        process.env.EZPAY_INVOICE_MERCHANT_ID
        && process.env.EZPAY_INVOICE_HASH_KEY
        && process.env.EZPAY_INVOICE_HASH_IV
        && process.env.EZPAY_INVOICE_API_URL,
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
