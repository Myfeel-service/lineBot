import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：付款漏斗的接線（`D-180`，2026-11-11）。
 *
 * 釘的是三種**不會報錯、只會讓資料悄悄缺一格**的接錯法——而且是第一批客人走過就補不回來的：
 *   ① `markLeftForGateway` 排在 `submitToGateway` 後面 → 下一行就整頁導走，那一批事件來不及送。
 *   ② 回來那一筆沒帶走之前那一場的 `fid` → 漏斗在最後一格斷掉，接不回同一個人的同一次嘗試。
 *   ③ 新開一個「查看方案」的入口卻忘了標 `source` → 查「哪個入口帶得動人」時那一批全落在 other。
 *
 * ⚠️ 比順序之前**一定要先拿掉註解**：這幾段的註解本身就寫著「要在 `submitToGateway` 之前」，
 *    照原文找位置會把註解當成程式、紅成假的（記憶 `reference_nuxt_typecheck_traps`：
 *    宣告順序測試連註解裡的變數名都追）。
 * ⛔ 這份只驗「有沒有接上」，不驗「真的送得出去」——那個由 scratchpad 的實機守門員驗
 *    （瀏覽器攔下所有非 GET，看真的打出去的那包 body）。
 */

const APP = fileURLToPath(new URL('../', import.meta.url))
const read = (rel: string) => readFileSync(join(APP, rel), 'utf8')

/** 拿掉 `//`、`/* *\/`、`<!-- -->` 三種註解，只留真的會跑的程式 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 某個字串在原始碼裡每一次出現的位置 */
function positions(src: string, needle: string): number[] {
  const out: number[] = []
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) out.push(i)
  return out
}

/** 三條會離開本站去 PAYUNi 的路（`submitToGateway` 的呼叫端） */
const GATEWAY_FILES = [
  'components/admin/AdminPlanUpgradeDialog.vue',
  'pages/admin/[workspaceId]/settings/billing.vue',
]

describe('付款漏斗：離開去金流之前要先留記號', () => {
  it('每一次 submitToGateway 之前都有一次 markLeftForGateway（數量相同、位置在前）', () => {
    for (const rel of GATEWAY_FILES) {
      const src = stripComments(read(rel))
      const marks = positions(src, 'markLeftForGateway(')
      const gos = positions(src, 'submitToGateway(')
      expect(gos.length, `${rel} 應該有去金流的呼叫`).toBeGreaterThan(0)
      expect(marks.length, `${rel} 的 markLeftForGateway 次數要跟 submitToGateway 一樣`).toBe(gos.length)
      gos.forEach((go, i) => {
        expect(marks[i], `${rel} 第 ${i + 1} 次去金流前沒有留記號`).toBeLessThan(go)
      })
    }
  })

  it('⛔ 沒有第四條沒掛記號的路：全 app 只有這兩個檔會去金流', () => {
    const callers = vueAndTsFiles()
      .filter(rel => rel !== 'composables/useGatewayCheckout.ts') // 那支是定義本人
      .filter(rel => stripComments(read(rel)).includes('submitToGateway('))
    expect(callers.sort()).toEqual([...GATEWAY_FILES].sort())
  })
})

describe('付款漏斗：回來那一筆要接得回同一次嘗試', () => {
  const billing = stripComments(read('pages/admin/[workspaceId]/settings/billing.vue'))

  it('billing_gateway_back 帶著 takeGatewayReturn() 給的 fid', () => {
    expect(billing).toContain('takeGatewayReturn()')
    // 取出 fid → 記事件，兩件事要在同一段裡（中間不會隔著別的函式）
    const seg = billing.slice(billing.indexOf('takeGatewayReturn()'), billing.indexOf('billing_gateway_back') + 200)
    expect(seg).toMatch(/\bfid\b/)
    expect(seg).toMatch(/billing_gateway_back['"],\s*\{[^}]*\bfid\b/)
  })

  it('⛔ 記號讀完就清掉，否則之後每次打開帳單頁都多一筆假的回訪', () => {
    const fn = stripComments(read('composables/useBillingFunnel.ts'))
    const body = fn.slice(fn.indexOf('function takeGatewayReturn'))
    expect(body).toContain('clearStore(GATEWAY_KEY)')
  })

  it('⛔ 要等訂單載回來才記，否則每一筆都會被記成查無此單', () => {
    const mounted = billing.slice(billing.indexOf('onMounted(async'))
    expect(mounted.indexOf('await reloadAll()')).toBeLessThan(mounted.indexOf('trackGatewayReturn()'))
  })
})

describe('付款漏斗：每個「查看方案」的入口都要標是從哪裡來的', () => {
  it('所有 AdminPlanUpgradeDialog 都帶 source', () => {
    const missing: string[] = []
    for (const rel of vueAndTsFiles()) {
      const src = read(rel)
      for (const at of positions(src, '<AdminPlanUpgradeDialog')) {
        // 這個標籤到它自己的結尾為止（一律自閉合 />）
        const tag = src.slice(at, src.indexOf('/>', at) + 2)
        if (!/\bsource="/.test(tag)) missing.push(`${rel}（第 ${src.slice(0, at).split('\n').length} 行）`)
      }
    }
    expect(missing, '新的入口要標 source，否則查漏斗時這批全落在 other').toEqual([])
  })
})

/** app/ 底下所有 .vue 與 .ts（跳過測試檔本身與 node_modules） */
function vueAndTsFiles(dir = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(APP, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      out.push(...vueAndTsFiles(rel))
    }
    else if ((e.name.endsWith('.vue') || e.name.endsWith('.ts')) && !e.name.includes('.test.')) {
      out.push(rel)
    }
  }
  return out
}
