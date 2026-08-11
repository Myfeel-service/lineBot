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
 *      - 或開一個唯讀 IAM 使用者，把金鑰設成 `AWS_COST_ACCESS_KEY_ID` /
 *        `AWS_COST_SECRET_ACCESS_KEY`
 *   任何一項沒到位都會丟 AwsCostUnavailableError，呼叫端據此顯示「未接上」而不是 0。
 *
 * ⛔ **金鑰的環境變數名稱不能用 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`**：
 *    那是 Lambda（Amplify SSR 的執行環境）的保留變數，由執行角色自動填入、設了也會被蓋掉，
 *    所以這裡改用 `AWS_COST_*` 專屬名稱，明確傳給 client。沒設就退回預設憑證鏈。
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
