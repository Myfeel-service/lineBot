/**
 * AWS 帳單「這筆錢是誰造成的」分類。
 *
 * 為什麼要這一層：帳單上只寫「AWS Amplify NT$749」，看不出這筆錢是**客人變多**造成的，
 * 還是**我們自己一直推程式上線**造成的——這兩件事的下一步完全相反（前者是生意變好，
 * 後者可以省）。2026-09-02 逐項拆帳實測：那 NT$749 裡有 NT$229 是建置分鐘，
 * 也就是「這個月推了大約 140 次程式」，跟客人一則訊息都沒關係。
 *
 * ⛔ **認不得的服務／用量一律回 `unknown`，呼叫端要把它們單獨列出來**，不可以猜一個
 *    分類塞進去，也不可以靜默丟掉：這頁的用途就是回答「沒有客人也要付多少」，
 *    猜錯或漏掉都會讓那個數字說謊（同款沉默死亡在別處已經發生過三次）。
 */

/** 這筆花費跟「客人多寡」的關係 */
export type CostDriver
  = | 'fixed' /** 固定：零客人也照樣要付（網域解析、密鑰保管、中繼站主機…） */
    | 'traffic' /** 變動：客人越多越貴（對外流量、寄信） */
    | 'mixed' /** 兩者都有，而且帳單拆不開（網站執行時間：保溫、排程、客人來訊都記在同一格） */
    | 'dev' /** 我們改程式才會產生（建置分鐘），跟客人無關但也不是每月固定 */
    | 'unknown' /** 認不得——照樣顯示，但不併進上面任何一桶 */

export const COST_DRIVER_LABEL: Record<CostDriver, string> = {
  fixed: '沒有客人也要付',
  traffic: '客人越多越貴',
  mixed: '固定＋變動，拆不開',
  dev: '改程式才會產生',
  unknown: '未分類',
}

/** 每一桶底下實際是哪些東西——只有一個標籤的話，看的人還是不知道那筆錢在幹嘛 */
export const COST_DRIVER_NOTE: Record<CostDriver, string> = {
  fixed: '網域解析、密鑰保管、網站檔案存放、帳單查詢費。之後開金流中繼站（Lightsail）也會落在這一格。',
  mixed: '網站執行時間與請求次數。24 小時不停的保溫、每 10 分鐘的背景排程、客人來訊、後台操作全部記在同一格，帳單分不開。',
  traffic: '傳給使用者的網頁與檔案流量、系統寄出的信。',
  dev: '建置分鐘——這個月推了幾次程式上線。客人一則訊息都不影響它。',
  unknown: '程式還認不得的項目。金額照實列出，但沒有併進其他格，免得上面那些數字說謊。',
}

/** 顯示順序：先講「沒有客人也要付」，那是老闆真正在問的那個數字 */
export const COST_DRIVER_ORDER: CostDriver[] = ['fixed', 'mixed', 'dev', 'traffic', 'unknown']

/**
 * 服務層級的分類。`itemized` 代表「這個服務要再往下拆用量才看得出來」——
 * 目前只有 Amplify 需要（它一家就佔九成五）。
 *
 * ⚠️ Route 53 歸 `fixed` 是刻意的簡化：它其實是「代管區月費 US$0.50（固定）＋
 *    查詢次數（變動）」，但實測 8 月查詢費只有 US$0.0145＝不到 NT$0.5，
 *    為了這半塊錢多開一次 Cost Explorer 查詢（每次 US$0.01）不划算。
 * ⚠️ Lightsail 現在還沒開機，帳單上不會出現；先放進表裡是為了**開機當天就自動
 *    落在「沒有客人也要付」**，不用回頭再改一次程式（`docs/PAYUNI-RELAY-SETUP.md`）。
 */
const SERVICE_DRIVER: Record<string, CostDriver | 'itemized'> = {
  'AWS Amplify': 'itemized',
  'Amazon Lightsail': 'fixed',
  'Amazon Route 53': 'fixed',
  'AWS Secrets Manager': 'fixed',
  'AWS Cost Explorer': 'fixed',
  'AmazonCloudWatch': 'fixed',
  'Amazon Simple Storage Service': 'fixed',
  'Amazon Simple Email Service': 'traffic',
}

/** 服務名稱 → 分類；認不得回 `unknown`（⛔別預設成 fixed，那會虛報固定成本） */
export function serviceDriver(name: string): CostDriver | 'itemized' {
  return SERVICE_DRIVER[name] ?? 'unknown'
}

export type AmplifyUsageMeta = {
  /** 白話名稱 */
  label: string
  /** 一句話講清楚這是什麼、什麼時候會變貴 */
  note: string
  driver: CostDriver
  /** 用量的中文單位（Cost Explorer 回的是 Minutes／GB-Seconds 這種英文） */
  unit: string
  /** 公開單價的白話寫法，讓人自己驗算得出金額 */
  rate: string
}

/**
 * Amplify 的五種用量。鍵是 Cost Explorer `USAGE_TYPE` **去掉區域前綴**後的字串
 * （東京區實際長成 `APN1-BuildDuration`）。
 * 單價是 2026-08 帳單反推的實數，不是查來的定價表（金額 ÷ 用量剛好整數）。
 */
const AMPLIFY_USAGE: Record<string, AmplifyUsageMeta> = {
  HostingComputeRequestDuration: {
    label: '網站執行時間',
    note: '網站每處理一個請求，從開始到回應完成的時間都算錢。24 小時的保溫、每 10 分鐘的背景排程、客人來訊、後台操作全部記在這一格，帳單不會分開。',
    driver: 'mixed',
    unit: 'GB-秒',
    rate: '每 GB-小時 US$0.20',
  },
  BuildDuration: {
    label: '建置（改完程式推上線）',
    note: '每推一次程式，主機就重跑一次安裝、測試、型別檢查與打包。跟客人一則訊息都沒關係，推越多次越貴。',
    driver: 'dev',
    unit: '分鐘',
    rate: '每分鐘 US$0.01',
  },
  DataTransferOut: {
    label: '對外流量',
    note: '網頁、圖片、API 回應傳給使用者的資料量。人來得越多越貴。',
    driver: 'traffic',
    unit: 'GB',
    rate: '每 GB US$0.15',
  },
  HostingComputeRequestCount: {
    label: '網站請求次數',
    note: '網站被打了幾次。單價極低，就算翻十倍也還是零頭。',
    driver: 'mixed',
    unit: '次',
    rate: '每百萬次 US$0.30',
  },
  DataStorage: {
    label: '網站檔案存放',
    note: '打包後的網站檔案放在 AWS 上的容量費。',
    driver: 'fixed',
    unit: 'GB',
    rate: '每 GB 每月 US$0.023',
  },
}

/**
 * `APN1-BuildDuration` → 那一項的白話說明；認不得回 `null`。
 *
 * ⛔ 前綴用「第一個 `-` 之前」切掉而不是寫死 `APN1-`：換區域（或 AWS 改名）時
 *    這裡要能繼續認得，認不得也只會退成 `unknown` 被單獨列出來，不會算錯。
 */
export function amplifyUsageMeta(usageType: string): AmplifyUsageMeta | null {
  const raw = String(usageType || '')
  const tail = raw.includes('-') ? raw.slice(raw.indexOf('-') + 1) : raw
  return AMPLIFY_USAGE[tail] ?? AMPLIFY_USAGE[raw] ?? null
}

/** 帳單攤平後最小的一格：一個服務，或 Amplify 底下的一項用量 */
export type CostLeaf = {
  /** 在整張帳單裡唯一，用來對照四捨五入後的金額 */
  id: string
  /** 屬於哪個服務（服務清單那一列要靠它加總） */
  service: string
  /** Amplify 拆項才有；其餘服務是空字串 */
  usageType: string
  driver: CostDriver
  cost: number
}

/**
 * 把整張 AWS 帳單攤成最小的格子——服務清單、分類格、逐項用量三處顯示的金額，
 * 全部從這一份加總而來。
 *
 * 為什麼不讓三處各算各的：同一筆錢在畫面上出現三次，各自四捨五入就會互相打架。
 * 2026-09-02 實測撞到——「對外流量 NT$13」旁邊的分類格寫「客人越多越貴 NT$12」，
 * 同一件事兩個數字。攤成葉節點只換算一次，三處就不可能不一致。
 *
 * @param services 各服務原價（已扣掉折抵那一刀，來自 `parseCostResponse`）
 * @param itemizedUsage Amplify 的逐項用量；**`null` 代表這次拆不開**——那一筆會整個
 *        落在 `unknown`，⛔ 不可以猜一個分類塞進去（這些數字存在的意義就是回答
 *        「沒有客人也要付多少」，猜錯等於它在說謊）。
 */
export function buildCostLeaves(
  services: Array<{ name: string; cost: number }>,
  itemizedUsage: Array<{ usageType: string; cost: number }> | null,
): CostLeaf[] {
  const out: CostLeaf[] = []
  for (const s of services) {
    const driver = serviceDriver(s.name)
    if (driver !== 'itemized') {
      out.push({ id: s.name, service: s.name, usageType: '', driver, cost: s.cost })
      continue
    }
    if (!itemizedUsage?.length) {
      out.push({ id: s.name, service: s.name, usageType: '', driver: 'unknown', cost: s.cost })
      continue
    }
    for (const it of itemizedUsage) {
      out.push({
        id: `${s.name}/${it.usageType}`,
        service: s.name,
        usageType: it.usageType,
        driver: amplifyUsageMeta(it.usageType)?.driver ?? 'unknown',
        cost: it.cost,
      })
    }
  }
  return out
}

/**
 * 把一組金額四捨五入成整數，且**總和保證等於指定的母數**（最大餘數法）。
 *
 * 為什麼需要：這頁的規矩是「只有加起來等於母數的數字才能並排」。五格各自四捨五入，
 * 誤差累積起來會差到 NT$2——並排的格子加起來不等於上面那個總額，看的人第一眼就不信了。
 */
export function allocateRounded(values: number[], total: number): number[] {
  if (!values.length) return []
  const out = values.map(v => Math.floor(v))
  let remainder = Math.round(total) - out.reduce((a, b) => a + b, 0)
  // 餘數照「被無條件捨去掉最多的」優先補回去；補完仍有剩就繞回頭再補一輪
  const byFraction = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; remainder > 0; k++, remainder--) out[byFraction[k % byFraction.length]!.i]! += 1
  // 母數比各項和還小（極少見，但別讓它變成無窮迴圈或負餘數殘留）時往回扣
  for (let k = byFraction.length - 1; remainder < 0; k--, remainder++) {
    out[byFraction[((k % byFraction.length) + byFraction.length) % byFraction.length]!.i]! -= 1
  }
  return out
}

/** 用量數字講人話：29 萬次、714.8 分鐘、2.61 GB */
export function formatUsageQuantity(quantity: number, unit: string): string {
  const v = Number(quantity || 0)
  if (!Number.isFinite(v)) return '—'
  if (unit === '次') {
    if (v >= 1e4) {
      const w = v / 1e4
      return `${w >= 100 ? Math.round(w) : w.toFixed(1)} 萬次`
    }
    return `${v.toLocaleString('en-US')} 次`
  }
  if (unit === 'GB-秒') return `${Math.round(v).toLocaleString('en-US')} GB-秒`
  if (v >= 100) return `${Math.round(v).toLocaleString('en-US')} ${unit}`
  if (v >= 1) return `${v.toFixed(1)} ${unit}`
  // 不到 1 的量（存放 0.01 GB）保留三位，否則整排都是 0.0
  return `${v.toFixed(3)} ${unit}`
}
