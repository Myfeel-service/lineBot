import { describe, expect, it } from 'vitest'
import {
  COST_DRIVER_ORDER,
  allocateRounded,
  amplifyUsageMeta,
  buildCostLeaves,
  formatUsageQuantity,
  serviceDriver,
} from './aws-cost-usage'

/**
 * 這組測試守的是「沒有客人也要付多少」那個數字不會說謊（2026-09-02）。
 * 三條紅線：認不得的東西要落在 unknown（不可以猜）、並排的格子要剛好加總成母數、
 * Lightsail 這種還沒開機的固定支出要先在表裡（開機當天不用回頭改程式）。
 */

describe('serviceDriver', () => {
  it('Amplify 要再往下拆，其餘服務直接分類', () => {
    expect(serviceDriver('AWS Amplify')).toBe('itemized')
    expect(serviceDriver('Amazon Route 53')).toBe('fixed')
    expect(serviceDriver('Amazon Simple Email Service')).toBe('traffic')
  })

  it('Lightsail 現在還沒開機，但已經在表裡＝開機當天自動落在「沒有客人也要付」', () => {
    expect(serviceDriver('Amazon Lightsail')).toBe('fixed')
  })

  it('⛔ 認不得的服務回 unknown，不可以預設成 fixed（那會虛報固定成本）', () => {
    expect(serviceDriver('Amazon Bedrock')).toBe('unknown')
    expect(serviceDriver('')).toBe('unknown')
  })
})

describe('amplifyUsageMeta', () => {
  it('認得帶區域前綴的用量代碼，分類與東京區實際帳單一致', () => {
    expect(amplifyUsageMeta('APN1-BuildDuration')?.driver).toBe('dev')
    expect(amplifyUsageMeta('APN1-HostingComputeRequestDuration')?.driver).toBe('mixed')
    expect(amplifyUsageMeta('APN1-HostingComputeRequestCount')?.driver).toBe('mixed')
    expect(amplifyUsageMeta('APN1-DataTransferOut')?.driver).toBe('traffic')
    expect(amplifyUsageMeta('APN1-DataStorage')?.driver).toBe('fixed')
  })

  it('換區域（前綴不同）照樣認得，沒有前綴也認得', () => {
    expect(amplifyUsageMeta('USE1-BuildDuration')?.label).toBe('建置（改完程式推上線）')
    expect(amplifyUsageMeta('BuildDuration')?.label).toBe('建置（改完程式推上線）')
  })

  it('⛔ 認不得的代碼回 null，讓呼叫端標成未分類而不是猜一個', () => {
    expect(amplifyUsageMeta('APN1-SomethingBrandNew')).toBeNull()
    expect(amplifyUsageMeta('')).toBeNull()
  })
})

describe('buildCostLeaves', () => {
  // 2026-08 正式帳單的形狀
  const services = [
    { name: 'AWS Amplify', cost: 23.4191 },
    { name: 'AWS Cost Explorer', cost: 0.6 },
    { name: 'Amazon Route 53', cost: 0.5145 },
    { name: 'Amazon Simple Email Service', cost: 0.0002 },
  ]
  const usage = [
    { usageType: 'APN1-HostingComputeRequestDuration', cost: 15.7894 },
    { usageType: 'APN1-BuildDuration', cost: 7.1482 },
    { usageType: 'APN1-DataTransferOut', cost: 0.3921 },
    { usageType: 'APN1-HostingComputeRequestCount', cost: 0.0891 },
    { usageType: 'APN1-DataStorage', cost: 0.0002 },
  ]

  it('Amplify 攤成五格、其餘服務各一格，總額不變', () => {
    const leaves = buildCostLeaves(services, usage)
    expect(leaves).toHaveLength(4 - 1 + 5)
    expect(leaves.reduce((a, l) => a + l.cost, 0)).toBeCloseTo(
      services.reduce((a, s) => a + s.cost, 0) - 23.4191 + usage.reduce((a, u) => a + u.cost, 0),
      6,
    )
    // 服務清單那一列要靠 service 加總得回來
    expect(leaves.filter(l => l.service === 'AWS Amplify')).toHaveLength(5)
  })

  it('分桶：建置分鐘歸「改程式才會產生」、帳單查詢費與網域解析歸「沒有客人也要付」', () => {
    const leaves = buildCostLeaves(services, usage)
    const by = (d: string) => leaves.filter(l => l.driver === d).reduce((a, l) => a + l.cost, 0)
    expect(by('dev')).toBeCloseTo(7.1482, 6)
    expect(by('mixed')).toBeCloseTo(15.7894 + 0.0891, 6)
    expect(by('traffic')).toBeCloseTo(0.3921 + 0.0002, 6)
    expect(by('fixed')).toBeCloseTo(0.6 + 0.5145 + 0.0002, 6)
    expect(by('unknown')).toBe(0)
  })

  it('⛔ 拆不開時 Amplify 整筆進 unknown，不可以猜一個分類（那會讓「沒有客人也要付」說謊）', () => {
    for (const noUsage of [null, []]) {
      const leaves = buildCostLeaves(services, noUsage)
      const amplify = leaves.filter(l => l.service === 'AWS Amplify')
      expect(amplify).toHaveLength(1)
      expect(amplify[0]!.driver).toBe('unknown')
      expect(amplify[0]!.cost).toBeCloseTo(23.4191, 6)
    }
  })

  it('認不得的用量代碼照樣留一格並標 unknown——不可以靜靜丟掉', () => {
    const leaves = buildCostLeaves(
      [{ name: 'AWS Amplify', cost: 1 }],
      [{ usageType: 'APN1-BuildDuration', cost: 0.6 }, { usageType: 'APN1-BrandNewThing', cost: 0.4 }],
    )
    expect(leaves).toHaveLength(2)
    expect(leaves.find(l => l.usageType === 'APN1-BrandNewThing')?.driver).toBe('unknown')
    expect(leaves.reduce((a, l) => a + l.cost, 0)).toBeCloseTo(1, 6)
  })

  it('葉節點 id 唯一（金額要靠它對回來，撞號就會顯示錯的錢）', () => {
    const leaves = buildCostLeaves(services, usage)
    expect(new Set(leaves.map(l => l.id)).size).toBe(leaves.length)
  })
})

describe('三處顯示的金額不可以互相打架', () => {
  it('分類格、服務清單、逐項用量都由同一份配額加總 → 兩兩對得上', () => {
    // 2026-09-02 實測撞到的情境：對外流量 US$0.3921×32＝12.55，
    // 各自四捨五入時拆項顯示 13、分類格顯示 12，同一件事兩個數字
    const services = [
      { name: 'AWS Amplify', cost: 23.4191 },
      { name: 'AWS Cost Explorer', cost: 0.6 },
      { name: 'Amazon Route 53', cost: 0.5145 },
    ]
    const usage = [
      { usageType: 'APN1-HostingComputeRequestDuration', cost: 15.7894 },
      { usageType: 'APN1-BuildDuration', cost: 7.1482 },
      { usageType: 'APN1-DataTransferOut', cost: 0.3921 },
      { usageType: 'APN1-HostingComputeRequestCount', cost: 0.0891 },
      { usageType: 'APN1-DataStorage', cost: 0.0002 },
    ]
    const leaves = buildCostLeaves(services, usage)
    const total = Math.round(services.reduce((a, s) => a + s.cost, 0) * 32)
    const twd = allocateRounded(leaves.map(l => l.cost * 32), total)
    const money = new Map(leaves.map((l, i) => [l.id, twd[i]!]))
    const sum = (f: (l: typeof leaves[number]) => boolean) =>
      leaves.filter(f).reduce((a, l) => a + money.get(l.id)!, 0)

    // ① 所有格子加起來＝主機總額
    expect(twd.reduce((a, b) => a + b, 0)).toBe(total)
    // ② 分類格加起來也＝主機總額
    const byDriver = ['fixed', 'mixed', 'dev', 'traffic', 'unknown']
      .map(d => sum(l => l.driver === d))
    expect(byDriver.reduce((a, b) => a + b, 0)).toBe(total)
    // ③ 服務清單加起來也＝主機總額
    expect(services.map(s => sum(l => l.service === s.name)).reduce((a, b) => a + b, 0)).toBe(total)
    // ④ 「客人越多越貴」那格＝拆項裡對外流量那一格（就是原本會打架的那兩個數字）
    expect(sum(l => l.driver === 'traffic')).toBe(money.get('AWS Amplify/APN1-DataTransferOut'))
  })
})

describe('allocateRounded', () => {
  it('各項四捨五入後總和仍等於母數（各自 round 會差 NT$2 的那個情境）', () => {
    // 五項小數都是 .5 上下，各自四捨五入會多算 2 塊
    const values = [504.6, 228.7, 18.5, 16.4, 12.6]
    const total = values.reduce((a, b) => a + b, 0) // 780.8 → 781
    const out = allocateRounded(values, total)
    expect(out.reduce((a, b) => a + b, 0)).toBe(781)
    // 且每一格都貼著自己的原值（誤差不超過 1）
    out.forEach((v, i) => expect(Math.abs(v - values[i]!)).toBeLessThan(1))
  })

  it('母數比各項和小也要收斂（不可以無窮迴圈或留下負餘數）', () => {
    const out = allocateRounded([10.9, 10.9, 10.9], 30)
    expect(out.reduce((a, b) => a + b, 0)).toBe(30)
  })

  it('母數比各項和大時，餘數補給被捨去最多的那幾格', () => {
    const out = allocateRounded([1.9, 1.1, 1.0], 5)
    expect(out.reduce((a, b) => a + b, 0)).toBe(5)
    expect(out[0]).toBe(2) // .9 被捨掉最多，先補它
  })

  it('空清單不會爆', () => {
    expect(allocateRounded([], 0)).toEqual([])
  })
})

describe('formatUsageQuantity', () => {
  it('次數講人話，大數字換成「萬次」', () => {
    expect(formatUsageQuantity(296954, '次')).toBe('29.7 萬次')
    expect(formatUsageQuantity(1730, '次')).toBe('1,730 次')
    // 百萬以上才捨掉小數（跟本頁既有的 times() 同一套口徑）
    expect(formatUsageQuantity(1822586, '次')).toBe('182 萬次')
  })

  it('GB-秒取整數、分鐘留一位、不到 1 的容量不會整排變成 0.0', () => {
    expect(formatUsageQuantity(284209.485, 'GB-秒')).toBe('284,209 GB-秒')
    expect(formatUsageQuantity(714.823, '分鐘')).toBe('715 分鐘')
    expect(formatUsageQuantity(2.614, 'GB')).toBe('2.6 GB')
    expect(formatUsageQuantity(0.01, 'GB')).toBe('0.010 GB')
  })
})

describe('COST_DRIVER_ORDER', () => {
  it('「沒有客人也要付」排第一——那是老闆真正在問的數字', () => {
    expect(COST_DRIVER_ORDER[0]).toBe('fixed')
    // 五桶都要在，少一桶就會有錢默默不見
    expect([...COST_DRIVER_ORDER].sort()).toEqual(['dev', 'fixed', 'mixed', 'traffic', 'unknown'])
  })
})
