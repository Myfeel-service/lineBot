/**
 * 成本總覽的「非 AWS 的固定支出」（`D-47`③，2026-10-20 老闆照建議）——**手填**的清單。
 *
 * 為什麼要有：網域 `lineminime.com` 在 GoDaddy（2027-07-13 到期），不在 AWS 帳單裡，Cost Explorer 永遠看不到；
 * 頁首那句「網域不在此」對，但老闆要的是一頁看到全部固定的錢。查得到的（AI／資料庫／主機）照舊自動算，
 * 查不到的只能手填——⚠️ **手填的東西會過期**：畫面一律標「手填」、寫明最後是誰什麼時候改的、過了續約日要提醒回來確認。
 *
 * 存在 Firestore `platformSettings/fixedCosts`（平台層、只有超管讀寫，端點 `server/api/admin/super/fixed-costs.ts`）。
 * ⛔ LINE 官方帳號月費老闆明講不列（`D-47`）；PAYUNi 手續費、發票隨交易走、不是固定月費，也不列在這裡。
 */
import { USD_TO_TWD } from './usd-twd'

export type FixedCostCycle = 'yearly' | 'monthly'
export type FixedCostCurrency = 'TWD' | 'USD'

export interface FixedCostItem {
  id: string
  /** 例：網域 lineminime.com（GoDaddy） */
  name: string
  /** 一次付多少（照 `currency`、`cycle`）；年繳就填年費，畫面再攤成每月 */
  amount: number
  currency: FixedCostCurrency
  cycle: FixedCostCycle
  /** 下次續約日 YYYY-MM-DD；不知道就 null */
  renewsOn: string | null
}

export const FIXED_COST_MAX_ITEMS = 20
export const FIXED_COST_NAME_MAX = 40
/** 單筆上限：手滑多打幾個 0 會把總額整個帶歪，超過這個數字的固定支出這頁本來就不該手填 */
export const FIXED_COST_AMOUNT_MAX = 1_000_000

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** 單筆檢查：合格回整理好的那筆，不合格回講得出哪裡錯的一句話 */
export function parseFixedCostItem(raw: unknown): { ok: true, item: FixedCostItem } | { ok: false, error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '格式不對' }
  const r = raw as Record<string, unknown>
  const name = String(r.name ?? '').trim()
  if (!name) return { ok: false, error: '名稱沒填' }
  if (name.length > FIXED_COST_NAME_MAX) return { ok: false, error: `「${name.slice(0, 10)}…」名稱超過 ${FIXED_COST_NAME_MAX} 個字` }
  const amount = Number(r.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: `「${name}」的金額要大於 0` }
  if (amount > FIXED_COST_AMOUNT_MAX) return { ok: false, error: `「${name}」的金額太大（上限 ${FIXED_COST_AMOUNT_MAX.toLocaleString('en-US')}）` }
  const currency = r.currency === 'USD' ? 'USD' : r.currency === 'TWD' ? 'TWD' : null
  if (!currency) return { ok: false, error: `「${name}」的幣別只能是台幣或美金` }
  const cycle = r.cycle === 'monthly' ? 'monthly' : r.cycle === 'yearly' ? 'yearly' : null
  if (!cycle) return { ok: false, error: `「${name}」要選每年或每月付` }
  const renewsRaw = r.renewsOn == null ? '' : String(r.renewsOn).trim()
  if (renewsRaw && (!YMD_RE.test(renewsRaw) || Number.isNaN(Date.parse(`${renewsRaw}T00:00:00Z`))))
    return { ok: false, error: `「${name}」的續約日格式不對` }
  const id = String(r.id ?? '').trim().slice(0, 40) || `fc_${Math.random().toString(36).slice(2, 10)}`
  return {
    ok: true,
    item: { id, name, amount: Math.round(amount * 100) / 100, currency, cycle, renewsOn: renewsRaw || null },
  }
}

/** 整份清單（存檔用）：任何一筆不合格就整份退回，⛔ 不默默丟掉那一筆 */
export function parseFixedCostItems(raw: unknown): { ok: true, items: FixedCostItem[] } | { ok: false, error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: '清單格式不對' }
  if (raw.length > FIXED_COST_MAX_ITEMS) return { ok: false, error: `最多 ${FIXED_COST_MAX_ITEMS} 筆` }
  const items: FixedCostItem[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const p = parseFixedCostItem(r)
    if (!p.ok) return p
    // id 撞了（前端複製貼上之類）就換一個，兩筆都留著
    if (seen.has(p.item.id)) p.item.id = `${p.item.id}_${items.length}`
    seen.add(p.item.id)
    items.push(p.item)
  }
  return { ok: true, items }
}

/** 這一筆攤到每個月是多少台幣（不四捨五入；年繳 ÷12、美金 ×`USD_TO_TWD`） */
export function fixedCostMonthlyTwd(item: Pick<FixedCostItem, 'amount' | 'currency' | 'cycle'>): number {
  const twd = item.currency === 'USD' ? item.amount * USD_TO_TWD : item.amount
  return item.cycle === 'yearly' ? twd / 12 : twd
}

/** 全部攤到每個月加起來（台幣，四捨五入到元——進總額用這個數） */
export function fixedCostsMonthlyTwd(items: readonly FixedCostItem[]): number {
  return Math.round(items.reduce((sum, it) => sum + fixedCostMonthlyTwd(it), 0))
}

/** 講給人看的原始金額：「NT$1,200／年」「US$5／月」 */
export function fixedCostAmountText(item: Pick<FixedCostItem, 'amount' | 'currency' | 'cycle'>): string {
  const money = item.currency === 'USD'
    ? `US$${item.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    : `NT$${Math.round(item.amount).toLocaleString('en-US')}`
  return `${money}／${item.cycle === 'yearly' ? '年' : '月'}`
}

/** 續約日已經過了（手填的金額可能已經變了，要回來確認）；沒填續約日＝不知道，回 false */
export function fixedCostRenewalPassed(item: Pick<FixedCostItem, 'renewsOn'>, todayYmd: string): boolean {
  return !!item.renewsOn && item.renewsOn < todayYmd
}
