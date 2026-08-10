/**
 * Firebase（Firestore + 檔案儲存）用量 → 費用換算。
 *
 * 單純算術、不碰網路，方便單元測試：免費額度的扣法（每日 vs 連續）跟儲存的
 * 按月攤提都很容易寫錯，而錯了在畫面上看不出來（只會變成一個「看起來合理」的數字）。
 *
 * 單價為 Google 公開牌價（2026-08 查證），與 Firebase 主控台「專案費用」同一套口徑；
 * 幣別換算與帳單幣別無關（帳單本身是 TWD，這裡先算 USD 再乘匯率，與 AI 成本同做法）。
 * 改價只改這裡。
 */
import { taipeiDateKey } from './taipei-day'

/** 每日免費額度（只適用預設資料庫；超出的部分才計費） */
export const FIRESTORE_FREE_TIER = {
  readsPerDay: 50_000,
  writesPerDay: 20_000,
  deletesPerDay: 20_000,
  /** 儲存免費額是「持續 1 GiB」，不是每日重置 */
  storageGib: 1,
}

/** 檔案儲存（Cloud Storage）免費額：5 GiB-月 */
export const FILE_STORAGE_FREE_GIB = 5

/**
 * Firestore 單價（USD）。多區域（nam5／eur3）比單一區域貴一倍左右，
 * 用哪一組由資料庫實際 location 決定；查不到時一律當多區域（估高不估低）。
 */
export const FIRESTORE_PRICING = {
  multiRegion: { readPer100k: 0.06, writePer100k: 0.18, deletePer100k: 0.02, storagePerGibMonth: 0.18 },
  regional: { readPer100k: 0.03, writePer100k: 0.09, deletePer100k: 0.01, storagePerGibMonth: 0.108 },
} as const

/** 檔案儲存單價（USD / GiB / 月，Standard） */
export const FILE_STORAGE_PER_GIB_MONTH = 0.026

/**
 * 跨雲流量（Google → 網際網路）單價，USD / GiB。
 * 資料庫在 Google、主機在 AWS，所以**每一次讀取都是對外流量**、都要錢。
 * 這筆沒有任何用量指標可查（Firestore 沒有 egress 指標，serviceruntime 那支只涵蓋
 * 一小部分 REST 呼叫），只能用「讀取次數 × 每筆平均大小」推估。
 */
export const EGRESS_PER_GIB = 0.12

/**
 * 每筆讀取假設傳出多少 bytes。
 *
 * 2026-08-10 實測 myfeel 各集合平均大小：對話事件 278 B、對話 447 B、會話 481 B
 * （高頻讀的都在 300–500 B），知識卡因為存了向量而高達 10.9 KB（但只有問答時才讀）。
 * 取 1 KB 是**高於高頻集合、低於知識卡**的折衷，且回推得到的金額與真實帳單吻合：
 * 八月前九天 182 萬次讀 → 估流量 US$0.21，加上實測讀寫 US$0.82 ＝ US$1.03，
 * 對照主控台 NT$31.76（帳單幣別為台幣）約當 US$1.03，誤差在 5% 內。
 *
 * 調高這個值 → 估得更保守（金額更高）。
 */
export const ASSUMED_BYTES_PER_READ = 1024

export const GIB = 1024 ** 3

export type DayUsage = {
  /** 台北日曆日 `YYYY-MM-DD` */
  day: string
  reads: number
  writes: number
  deletes: number
  /** 當日平均資料庫存量（bytes） */
  storageBytes: number
  /** 當日平均檔案存量（bytes） */
  fileBytes: number
}

export type DayCost = DayUsage & {
  billableReads: number
  billableWrites: number
  billableDeletes: number
  /** 當日總費用（USD，含攤提到當日的儲存費與估算流量費） */
  costUsd: number
}

export type FirestoreCostResult = {
  days: DayCost[]
  totals: {
    reads: number
    writes: number
    deletes: number
    billableReads: number
    billableWrites: number
    billableDeletes: number
    /** 期間內最後一天的存量（GiB），給「現在多大」用 */
    storageGib: number
    fileStorageGib: number
    readCostUsd: number
    writeCostUsd: number
    deleteCostUsd: number
    storageCostUsd: number
    fileStorageCostUsd: number
    /** 跨雲流量：**估算值**（讀取次數 × 假設每筆大小），非量測 */
    egressCostUsd: number
    /** 實際量測的部分（讀寫刪＋儲存），不含估算流量 */
    measuredCostUsd: number
    /** 量測 ＋ 估算流量 */
    totalCostUsd: number
  }
  /** 讀取費用佔比最高的前幾天（回答「錢是哪幾天花掉的」） */
  topDays: Array<{ day: string; costUsd: number; reads: number }>
}

const round6 = (n: number) => Number(n.toFixed(6))

/** 列出 [start, end) 之間每一個台北日（`YYYY-MM-DD`） */
export function enumerateTaipeiDays(start: Date, end: Date): string[] {
  const out: string[] = []
  for (let t = start.getTime(); t < end.getTime(); t += 86_400_000)
    out.push(taipeiDateKey(new Date(t)))
  return out
}

/**
 * 存量指標常有缺日（Google 不保證每天都送點）。缺的那天沿用前一個已知值，
 * 不能當 0 —— 否則會少算儲存費，畫面上也會出現莫名其妙的凹陷。
 * 開頭就缺的話用第一個已知值往前補（總比 0 接近事實）。
 */
export function forwardFill(days: string[], series: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  const firstKnown = days.find(d => series.has(d))
  let last = firstKnown === undefined ? 0 : (series.get(firstKnown) ?? 0)
  for (const d of days) {
    if (series.has(d)) last = series.get(d) ?? 0
    out.set(d, last)
  }
  return out
}

/**
 * 把每日用量換算成費用。
 *
 * - 讀／寫／刪：**逐日**扣免費額後計價（不是整月加總後才扣，否則會少算很多）。
 * - 儲存：免費額是持續 1 GiB，費率是「每 GiB 每月」，故逐日攤提
 *   `(存量 - 免費額) × 月費率 ÷ 當月天數`。只跑了半個月就只算半個月，不會虛報。
 */
export function computeFirebaseCost(
  days: DayUsage[],
  opts: { multiRegion: boolean; daysInMonth: number; bytesPerRead?: number },
): FirestoreCostResult {
  const price = opts.multiRegion ? FIRESTORE_PRICING.multiRegion : FIRESTORE_PRICING.regional
  const daysInMonth = Math.max(1, opts.daysInMonth)
  const bytesPerRead = opts.bytesPerRead ?? ASSUMED_BYTES_PER_READ

  const totals = {
    reads: 0,
    writes: 0,
    deletes: 0,
    billableReads: 0,
    billableWrites: 0,
    billableDeletes: 0,
    storageGib: 0,
    fileStorageGib: 0,
    readCostUsd: 0,
    writeCostUsd: 0,
    deleteCostUsd: 0,
    storageCostUsd: 0,
    fileStorageCostUsd: 0,
    egressCostUsd: 0,
    measuredCostUsd: 0,
    totalCostUsd: 0,
  }

  const out: DayCost[] = days.map((d) => {
    const billableReads = Math.max(0, d.reads - FIRESTORE_FREE_TIER.readsPerDay)
    const billableWrites = Math.max(0, d.writes - FIRESTORE_FREE_TIER.writesPerDay)
    const billableDeletes = Math.max(0, d.deletes - FIRESTORE_FREE_TIER.deletesPerDay)

    const readCost = (billableReads / 100_000) * price.readPer100k
    const writeCost = (billableWrites / 100_000) * price.writePer100k
    const deleteCost = (billableDeletes / 100_000) * price.deletePer100k

    const storageGib = d.storageBytes / GIB
    const fileGib = d.fileBytes / GIB
    const storageCost = (Math.max(0, storageGib - FIRESTORE_FREE_TIER.storageGib) * price.storagePerGibMonth) / daysInMonth
    const fileCost = (Math.max(0, fileGib - FILE_STORAGE_FREE_GIB) * FILE_STORAGE_PER_GIB_MONTH) / daysInMonth
    // 流量費沒有免費額度可扣（讀第一筆就在傳資料出去），也不受每日免費讀取影響
    const egressCost = ((d.reads * bytesPerRead) / GIB) * EGRESS_PER_GIB

    totals.reads += d.reads
    totals.writes += d.writes
    totals.deletes += d.deletes
    totals.billableReads += billableReads
    totals.billableWrites += billableWrites
    totals.billableDeletes += billableDeletes
    totals.readCostUsd += readCost
    totals.writeCostUsd += writeCost
    totals.deleteCostUsd += deleteCost
    totals.storageCostUsd += storageCost
    totals.fileStorageCostUsd += fileCost
    totals.egressCostUsd += egressCost

    return {
      ...d,
      billableReads,
      billableWrites,
      billableDeletes,
      costUsd: round6(readCost + writeCost + deleteCost + storageCost + fileCost + egressCost),
    }
  })

  // 存量取「期間內最後一筆有資料的那天」＝現在多大（加總沒有意義）
  for (let i = out.length - 1; i >= 0; i--) {
    const d = out[i]!
    if (d.storageBytes > 0 || d.fileBytes > 0) {
      totals.storageGib = round6(d.storageBytes / GIB)
      totals.fileStorageGib = round6(d.fileBytes / GIB)
      break
    }
  }

  totals.measuredCostUsd = totals.readCostUsd + totals.writeCostUsd + totals.deleteCostUsd
    + totals.storageCostUsd + totals.fileStorageCostUsd
  totals.totalCostUsd = totals.measuredCostUsd + totals.egressCostUsd

  for (const k of ['readCostUsd', 'writeCostUsd', 'deleteCostUsd', 'storageCostUsd',
    'fileStorageCostUsd', 'egressCostUsd', 'measuredCostUsd', 'totalCostUsd'] as const)
    totals[k] = round6(totals[k])

  const topDays = out
    .filter(d => d.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 3)
    .map(d => ({ day: d.day, costUsd: d.costUsd, reads: d.reads }))

  return { days: out, totals, topDays }
}
