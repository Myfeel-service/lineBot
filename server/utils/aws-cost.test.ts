import { describe, expect, it } from 'vitest'
import { parseCostResponse, parseUsageResponse } from './aws-cost'

/**
 * 這組測試守的是「原價 vs 折抵」的拆帳約定（2026-08-11）：
 * 帳號還有 AWS 折抵金時，帳單淨額是 0——折抵若混進服務金額，畫面會演成「主機不用錢」，
 * 折抵一用完數字才突然冒出來。所以 totalCost／services／days 一律是**原價**，
 * 折抵（Credit）與退費（Refund）另計成 creditTotal，且原價＋折抵必須剛好等於實付。
 */

const usd = (amount: number) => ({ UnblendedCost: { Amount: String(amount), Unit: 'USD' } })

function day(start: string, groups: Array<[service: string, recordType: string, amount: number]>) {
  return {
    TimePeriod: { Start: start, End: start },
    Groups: groups.map(([s, r, a]) => ({ Keys: [s, r], Metrics: usd(a) })),
  }
}

describe('parseCostResponse', () => {
  it('折抵金不混進原價：服務金額與 totalCost 是原價，折抵另計且三個數字對得起來', () => {
    const res = parseCostResponse({
      $metadata: {},
      ResultsByTime: [
        day('2026-08-01', [
          ['AWS Amplify', 'Usage', 1.5],
          ['AWS Amplify', 'Credit', -1.5],
          ['Amazon Lightsail', 'Usage', 0.8],
          ['Tax', 'Tax', 0.1],
        ]),
        day('2026-08-02', [
          ['AWS Amplify', 'Usage', 0.5],
          ['Amazon Lightsail', 'Credit', -0.8],
          ['AWS Amplify', 'Refund', -0.2],
        ]),
      ],
    } as any)

    expect(res.totalCost).toBeCloseTo(2.9, 6)
    expect(res.creditTotal).toBeCloseTo(-2.5, 6)
    expect(res.netTotal).toBeCloseTo(0.4, 6)
    expect(res.totalCost + res.creditTotal).toBeCloseTo(res.netTotal, 6)
    // 服務列表是原價、由高到低，折抵那幾筆不出現在列表裡
    expect(res.services).toEqual([
      { name: 'AWS Amplify', cost: 2 },
      { name: 'Amazon Lightsail', cost: 0.8 },
      { name: 'Tax', cost: 0.1 },
    ])
    // 每日金額也是原價（折抵不會把某一天壓成 0）
    expect(res.days).toEqual([
      { day: '2026-08-01', cost: 2.4 },
      { day: '2026-08-02', cost: 0.5 },
    ])
  })

  it('折抵金把整月沖成 0 時，原價照樣看得到（這正是改版動機）', () => {
    const res = parseCostResponse({
      $metadata: {},
      ResultsByTime: [day('2026-08-01', [
        ['AWS Amplify', 'Usage', 3.2],
        ['AWS Amplify', 'Credit', -3.2],
      ])],
    } as any)
    expect(res.totalCost).toBeCloseTo(3.2, 6)
    expect(res.netTotal).toBeCloseTo(0, 6)
    expect(res.services).toEqual([{ name: 'AWS Amplify', cost: 3.2 }])
  })

  it('沒有折抵時 creditTotal 為 0、netTotal 等於 totalCost', () => {
    const res = parseCostResponse({
      $metadata: {},
      ResultsByTime: [day('2026-08-01', [['AWS Amplify', 'Usage', 1.23]])],
    } as any)
    expect(res.creditTotal).toBe(0)
    expect(res.netTotal).toBeCloseTo(res.totalCost, 6)
    expect(res.currency).toBe('USD')
  })
})

/**
 * 逐項用量（2026-09-02 加）：Amplify 一家佔帳單九成五，只給一個總數答不出
 * 「這是客人變多還是我們一直推程式」。查詢區間跨月時會回兩個 bucket，
 * 只取第一個就會靜靜少算一天——這組測試守的就是那件事。
 */
function usageBucket(start: string, groups: Array<[usageType: string, cost: number, qty: number, unit: string]>) {
  return {
    TimePeriod: { Start: start, End: start },
    Groups: groups.map(([t, c, q, u]) => ({
      Keys: [t],
      Metrics: {
        UnblendedCost: { Amount: String(c), Unit: 'USD' },
        UsageQuantity: { Amount: String(q), Unit: u },
      },
    })),
  }
}

describe('parseUsageResponse', () => {
  it('把用量攤平並依金額排序，用量單位跟著回來', () => {
    const items = parseUsageResponse({
      $metadata: {},
      ResultsByTime: [usageBucket('2026-08-01', [
        ['APN1-BuildDuration', 7.1482, 714.823, 'Minutes'],
        ['APN1-HostingComputeRequestDuration', 15.7894, 284209.485, 'GB-Seconds'],
        ['APN1-DataTransferOut', 0.3921, 2.614, 'GigaBytes'],
      ])],
    } as any)

    expect(items.map(i => i.usageType)).toEqual([
      'APN1-HostingComputeRequestDuration',
      'APN1-BuildDuration',
      'APN1-DataTransferOut',
    ])
    expect(items[0]!.quantity).toBeCloseTo(284209.485, 3)
    expect(items[0]!.unit).toBe('GB-Seconds')
    expect(items.reduce((a, i) => a + i.cost, 0)).toBeCloseTo(23.3297, 4)
  })

  it('跨月的兩個 bucket 要相加，不能只取第一個（否則靜靜少一天）', () => {
    const items = parseUsageResponse({
      $metadata: {},
      ResultsByTime: [
        usageBucket('2026-08-01', [['APN1-BuildDuration', 7.0, 700, 'Minutes']]),
        usageBucket('2026-09-01', [['APN1-BuildDuration', 0.15, 15, 'Minutes']]),
      ],
    } as any)
    expect(items).toHaveLength(1)
    expect(items[0]!.cost).toBeCloseTo(7.15, 6)
    expect(items[0]!.quantity).toBeCloseTo(715, 3)
  })

  it('有用量但金額是零頭的項目要留著——那代表「這項幾乎免費」，不是「這項不存在」', () => {
    const items = parseUsageResponse({
      $metadata: {},
      ResultsByTime: [usageBucket('2026-08-01', [
        ['APN1-DataStorage', 0.0002, 0.01, 'GigaBytes'],
        ['APN1-NothingUsed', 0, 0, 'Requests'],
      ])],
    } as any)
    expect(items.map(i => i.usageType)).toEqual(['APN1-DataStorage'])
  })
})
