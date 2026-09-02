import { CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandOutput } from '@aws-sdk/client-cost-explorer'

/**
 * AWS 主機費用查詢（Cost Explorer）。
 *
 * 與 Firebase 那邊不同：這裡拿到的是**真正的帳單金額**（AWS 自己算好的），不是用單價推估。
 *
 * 需要什麼才會通（詳細步驟見 docs/AWS-COST-SETUP.md）：
 *   ① 帳號要先啟用 Cost Explorer，並允許 IAM 使用者讀取帳務資料
 *   ② 要有一組帶 `ce:GetCostAndUsage` 權限的憑證，兩條路擇一：
 *      - 幫 Amplify 的執行角色加上該權限 → 走 SDK 預設憑證鏈，什麼都不用設
 *      - 或開一個唯讀 IAM 使用者，把金鑰設成 `COST_EXPLORER_ACCESS_KEY_ID` /
 *        `COST_EXPLORER_SECRET_ACCESS_KEY`
 *   任何一項沒到位都會丟 AwsCostUnavailableError，呼叫端據此顯示「未接上」而不是 0。
 *
 * ⛔ **金鑰的環境變數名稱不能用 AWS 開頭**（2026-08-11 實測撞到）：
 *    Amplify 主控台整個擋掉 "AWS" 前綴（reserved prefix，存檔直接報錯），
 *    Lambda 又會自動蓋掉 `AWS_ACCESS_KEY_ID` 那三個保留名——第一版取名 `AWS_COST_*`
 *    就是在 Amplify 存不進去才改的。所以用 `COST_EXPLORER_*`，明確傳給 client；
 *    沒設就退回預設憑證鏈。
 *
 * ⚠️ 每次 GetCostAndUsage 要 US$0.01，所以呼叫端務必快取（帳單資料一天才更新一次，
 *    快取數小時完全夠用；不快取的話光是有人一直重整頁面就會慢慢累積費用）。
 * ⚠️ Cost Explorer 的分日是 **UTC**，不是台北時間；月總額不受影響，跨月當天可能差一點。
 */

export class AwsCostUnavailableError extends Error {}

/** Cost Explorer 是全域服務，端點固定在 us-east-1 */
const CE_REGION = 'us-east-1'

let cachedClient: CostExplorerClient | undefined

function getClient(): CostExplorerClient {
  if (!cachedClient) {
    const config = useRuntimeConfig()
    const accessKeyId = String(config.awsCostAccessKeyId || '')
    const secretAccessKey = String(config.awsCostSecretAccessKey || '')
    cachedClient = new CostExplorerClient({
      region: CE_REGION,
      // 有給專屬金鑰就用它；沒給就走預設憑證鏈（＝Amplify 執行角色已被授權的情況）
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    })
  }
  return cachedClient
}

/** 把 AWS 的錯誤翻成看得懂、且能分辨「沒設定」與「真的壞了」的原因 */
function describeError(e: any): string {
  const name = String(e?.name || '')
  const msg = String(e?.message || e)
  if (/CredentialsProviderError|Could not load credentials/i.test(name + msg))
    return '尚未設定 AWS 憑證（需要一組有 ce:GetCostAndUsage 權限的金鑰）'
  if (/security token|InvalidClientTokenId|SignatureDoesNotMatch|UnrecognizedClient/i.test(name + msg))
    return 'AWS 金鑰無效或已停用（請確認有沒有複製完整）'
  if (/AccessDenied|UnauthorizedOperation|not authorized/i.test(name + msg))
    return 'AWS 憑證缺少 ce:GetCostAndUsage 權限（也可能是帳號沒開放 IAM 讀取帳務資訊）'
  if (/DataUnavailable/i.test(name + msg))
    return 'AWS 帳號尚未啟用 Cost Explorer（啟用後約 24 小時才有資料）'
  return msg.slice(0, 200)
}

export type AwsCostResult = {
  /** 帳單幣別，通常是 USD */
  currency: string
  /** 原價：真實用量的成本，**不含**折抵金與退費 */
  totalCost: number
  /** 折抵金＋退費合計（有折抵時是負數；0＝這個月沒有折抵） */
  creditTotal: number
  /** 實付＝原價＋折抵（AWS 真正收走的錢） */
  netTotal: number
  /** 各服務花費（原價），由高到低 */
  services: Array<{ name: string; cost: number }>
  /** 每日花費（原價，UTC 日） */
  days: Array<{ day: string; cost: number }>
}

/**
 * 帳單裡不算「用量」的紀錄型別。折抵金（Credit）與退費（Refund）是負數沖銷項，
 * 混進服務金額會把原價全部沖成 0——帳號還有折抵金時看起來就像「沒花錢」，
 * 折抵一用完金額才突然冒出來。所以拆開：服務列表與 totalCost 一律是原價，
 * 折抵另外加總成 creditTotal 讓畫面自己講。
 */
const ADJUSTMENT_RECORD_TYPES = new Set(['Credit', 'Refund'])

/**
 * 撈一段期間的 AWS 花費，依服務分組（原價），折抵金另計。
 * @param start `YYYY-MM-DD`（含）
 * @param end `YYYY-MM-DD`（不含）
 */
export async function fetchAwsCost(start: string, end: string): Promise<AwsCostResult> {
  let res
  try {
    res = await getClient().send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      // 第二個維度用來認出折抵／退費紀錄；同一次查詢就拿得到，不會多付 US$0.01
      GroupBy: [
        { Type: 'DIMENSION', Key: 'SERVICE' },
        { Type: 'DIMENSION', Key: 'RECORD_TYPE' },
      ],
    }))
  }
  catch (e) {
    throw new AwsCostUnavailableError(describeError(e))
  }
  return parseCostResponse(res)
}

export type AwsUsageItem = {
  /** Cost Explorer 的原始用量代碼（如 `APN1-BuildDuration`），認不得時畫面照樣印得出來 */
  usageType: string
  /** 原價（已濾掉折抵／退費） */
  cost: number
  /** 用量本身：分鐘、GB-秒、次數… */
  quantity: number
  /** 用量單位（Minutes／GB-Seconds／Requests／GigaBytes） */
  unit: string
}

/**
 * 撈某服務**在同一段期間內的逐項用量**（Amplify 專用，因為它一家就佔九成五）。
 *
 * 為什麼要多打一次：主查詢已經用掉 SERVICE＋RECORD_TYPE 兩個分組欄位（Cost Explorer
 * 最多只給兩個），沒有空位再塞 USAGE_TYPE。而少了這一刀，畫面就只能說「Amplify NT$749」，
 * 答不出老闆真正在問的「這是客人多還是我們一直推程式」。
 *
 * ⚠️ 這會讓每次冷載多付 US$0.01（成本總覽這頁自己的查詢費）；為了抵掉它，
 *    呼叫端把快取從 6 小時拉長到 12 小時——帳單一天才更新一次，資訊一點都沒少。
 */
export async function fetchAwsServiceUsage(service: string, start: string, end: string): Promise<AwsUsageItem[]> {
  let res
  try {
    res = await getClient().send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost', 'UsageQuantity'],
      // 直接在查詢端濾掉折抵／退費，這裡不需要像主查詢那樣自己拆帳
      Filter: {
        And: [
          { Dimensions: { Key: 'SERVICE', Values: [service] } },
          { Dimensions: { Key: 'RECORD_TYPE', Values: ['Usage'] } },
        ],
      },
      GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
    }))
  }
  catch (e) {
    throw new AwsCostUnavailableError(describeError(e))
  }
  return parseUsageResponse(res)
}

/**
 * 把逐項用量的回應攤平（跨 bucket 相加）。
 *
 * ⚠️ 查詢區間理論上只落在同一個月＝一個 bucket，但這裡照樣累加：跨月當天
 * （end 推到「明天」）會多出第二個 bucket，只取第一個會靜靜少算一天。
 */
export function parseUsageResponse(res: GetCostAndUsageCommandOutput): AwsUsageItem[] {
  const byType = new Map<string, AwsUsageItem>()
  for (const bucket of res.ResultsByTime ?? []) {
    for (const g of bucket.Groups ?? []) {
      const usageType = g.Keys?.[0] ?? ''
      if (!usageType) continue
      const cost = Number(g.Metrics?.UnblendedCost?.Amount ?? 0)
      const quantity = Number(g.Metrics?.UsageQuantity?.Amount ?? 0)
      if (!Number.isFinite(cost)) continue
      const prev = byType.get(usageType)
      byType.set(usageType, {
        usageType,
        cost: (prev?.cost ?? 0) + cost,
        quantity: (prev?.quantity ?? 0) + (Number.isFinite(quantity) ? quantity : 0),
        unit: g.Metrics?.UsageQuantity?.Unit || prev?.unit || '',
      })
    }
  }
  return [...byType.values()]
    .map(i => ({ ...i, cost: Number(i.cost.toFixed(6)), quantity: Number(i.quantity.toFixed(3)) }))
    // 用量是 0 又不用錢的項目留著只會把清單塞滿；⛔ 但「有用量、金額是零頭」要留，
    // 那才看得出「這項幾乎免費」而不是「這項不存在」
    .filter(i => i.cost > 0 || i.quantity > 0)
    .sort((a, b) => b.cost - a.cost)
}

/** 把 Cost Explorer 的回應整理成畫面要的形狀（抽成純函式讓拆帳邏輯測得到） */
export function parseCostResponse(res: GetCostAndUsageCommandOutput): AwsCostResult {
  const byService = new Map<string, number>()
  const days: Array<{ day: string; cost: number }> = []
  let currency = 'USD'
  let creditTotal = 0

  for (const bucket of res.ResultsByTime ?? []) {
    let dayTotal = 0
    for (const g of bucket.Groups ?? []) {
      const name = g.Keys?.[0] ?? '其他'
      const recordType = g.Keys?.[1] ?? ''
      const amount = Number(g.Metrics?.UnblendedCost?.Amount ?? 0)
      const unit = g.Metrics?.UnblendedCost?.Unit
      if (unit) currency = unit
      if (!Number.isFinite(amount)) continue
      if (ADJUSTMENT_RECORD_TYPES.has(recordType)) {
        creditTotal += amount
        continue
      }
      byService.set(name, (byService.get(name) ?? 0) + amount)
      dayTotal += amount
    }
    days.push({ day: String(bucket.TimePeriod?.Start ?? ''), cost: Number(dayTotal.toFixed(6)) })
  }

  const services = [...byService.entries()]
    .map(([name, cost]) => ({ name, cost: Number(cost.toFixed(6)) }))
    // 零元服務（用了但在免費額度內）留著沒意義，只會把清單塞滿
    .filter(s => s.cost > 0)
    .sort((a, b) => b.cost - a.cost)

  const totalCost = Number(services.reduce((a, s) => a + s.cost, 0).toFixed(6))
  creditTotal = Number(creditTotal.toFixed(6))
  const netTotal = Number((totalCost + creditTotal).toFixed(6))
  return { currency, totalCost, creditTotal, netTotal, services, days }
}
