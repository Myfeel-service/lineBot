import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：「等你看過」那一區的空間講法（`C-308`⑨／`C-309`，2026-10-13）。
 *
 * 以前三件事（正式站實測）：
 *  ① 寫「全收會用掉 30／50 張（現在用了 25 張）」——看起來放得下，按下去才說只收 25 張；
 *  ② 收不下時叫他「刪掉用不到的卡」——旁邊的「刪掉」刪的是這一區的，這一區本來就沒佔空間；
 *  ③ 收不下的那幾條被標成「已決定」、按鈕收掉，他照提示空出位子回來也按不下去。
 * 照加入視窗的講法改；元件在 node 測試環境掛不起來，所以讀原始碼驗結構與字。
 */

const SRC = readFileSync(fileURLToPath(new URL('./KnowledgeSiteDrafts.vue', import.meta.url)), 'utf8')
/** 拿掉註解：只驗畫面上會出現的字與真的會跑的程式 */
const CODE = SRC
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '')).join('\n')
const TEMPLATE = CODE.slice(0, CODE.indexOf('<script'))

describe('等你看過：空間講法', () => {
  it('① 放不下時照加入視窗講「先收前 N 條，其餘 M 條先留在這裡」，⛔ 不再寫「全收會用掉 N／上限」', () => {
    expect(TEMPLATE).toContain('全收的話先收前 {{ roomLeft }} 條，其餘 {{ total - roomLeft }} 條先留在這裡')
    expect(TEMPLATE).not.toMatch(/全收會用掉 \{\{ total \}\}／/)
    // 整頁採用的按鈕也照實講先收前幾條
    expect(CODE).toMatch(/先收前 \$\{room\} 條/)
  })

  it('② 收不下時指向「知識庫裡用不到的知識」與升級，⛔ 不叫他刪這一區的', () => {
    expect(TEMPLATE).toContain('刪掉知識庫裡用不到的知識')
    expect(TEMPLATE).toContain('刪掉它們空不出位子')
    expect(CODE).not.toContain('刪掉用不到的卡')
    // 升級的連結只給看得到方案的人（跟加入視窗同一個判斷：伺服器有給方案名才有）
    expect(CODE).toMatch(/billingLink = computed\(\(\) => \(quota\.value\?\.planName \?/)
  })

  it('③ 空間滿了沒收的⛔ 不放進「已決定」（按鈕會收掉回不來）；回到這頁重查空間', () => {
    expect(CODE).not.toMatch(/r\.leftForQuota\)\s*decided\[/)
    expect(CODE).toMatch(/r\.leftForQuota\)\s*heldForQuota\[id\] = true/)
    expect(CODE).toContain("'/api/ai/knowledge/quota'")
    expect(CODE).toMatch(/addEventListener\('focus', onReturn\)/)
    expect(CODE).toMatch(/addEventListener\('visibilitychange', onReturn\)/)
    // 採用按鈕看空間：滿了按不下去、空出來就回來（⛔ 不是看「決定過了沒」就永遠消失）
    expect(TEMPLATE).toMatch(/:disabled="roomLeft === 0"[^>]*@click="adopt\(\[c\.id\]\)"/)
  })

  it('畫面上的量詞是「條」，⛔ 不出現「張」「卡片」「知識卡」', () => {
    const visible = TEMPLATE.replace(/\{\{[\s\S]*?\}\}/g, '')
    expect(visible).not.toMatch(/張|卡片|知識卡/)
    for (const m of CODE.matchAll(/(?:showToast\(|text: )(['`])([^'`]*)\1/g))
      expect(m[2], m[2]).not.toMatch(/張|卡片|知識卡/)
  })
})
