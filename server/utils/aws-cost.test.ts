import { describe, expect, it } from 'vitest'
import { parseCostResponse } from './aws-cost'

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
