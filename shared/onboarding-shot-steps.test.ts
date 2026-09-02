import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ONBOARDING_SHOT_STEPS } from './onboarding-shot-steps'

/**
 * 教學動畫上的紅色編號 vs 文案裡的①②③，必須是同一套。
 *
 * 為什麼需要這支測試：這兩份資料住在不同檔案（圖＝`scripts/make-onboarding-shots.py`
 * 產出，文案＝`useOnboardingChat.ts` / `field-help.ts`），**改了一邊不會有任何東西變紅**。
 * 動畫是循環播放的，中途接上的人只能靠號碼知道自己看到的是第幾步——號碼一旦對不上，
 * 畫面上的③會指到別的動作，而且只有使用者會發現。
 *
 * 驗的是：文案裡出現的圈號，剛好是 1..N 且沒有超出圖上的顆數（N 由產圖腳本寫進
 * `onboarding-shot-steps.ts`）。刻意**不驗**「一定要用滿 N 個」以外的東西——
 * 文案怎麼斷句是設計問題，不是這支測試該管的。
 */

const ROOT = resolve(import.meta.dirname, '..')
const CIRCLED = '①②③④⑤⑥⑦⑧⑨'

/**
 * 把每張圖跟「它旁邊那句文案」配成一對。
 *
 * ⚠️ 配對規則踩過一次坑（2026-09-02）：原本只是「往前找最近的 `html:`」，
 * 等到教學節點多了 `aside: { summary, html, image }` 這種**巢狀的第二個 html**，
 * 主圖就被配到 aside 的文案去了，四條測試同時變紅。所以現在先把 aside 整塊挖出來
 * 單獨配對，再拿剩下的原始碼跑主線的配對——兩邊都驗得到，不會互相汙染。
 */
function pairShotWithCopy(source: string): { shot: string, html: string }[] {
  const out: { shot: string, html: string }[] = []

  // ① 先處理 aside：把每一塊 `aside: { ... }` 連同它自己的 html／image 挑出來
  let rest = ''
  let i = 0
  while (i < source.length) {
    const at = source.indexOf('aside: {', i)
    if (at < 0) {
      rest += source.slice(i)
      break
    }
    rest += source.slice(i, at)
    let depth = 0
    let j = source.indexOf('{', at)
    for (; j < source.length; j++) {
      if (source[j] === '{')
        depth++
      else if (source[j] === '}' && --depth === 0)
        break
    }
    const block = source.slice(at, j + 1)
    const bShot = block.match(/(?:image|src):\s*ONBOARDING_SHOTS\.(\w+)/)
    const bHtml = block.match(/html:\s*'((?:[^'\\]|\\.)*)'/)
    if (bShot && bHtml)
      out.push({ shot: bShot[1]!, html: bHtml[1]! })
    i = j + 1
  }

  // ② 剩下的（拿掉 aside 之後）才跑「往前找最近的 html」
  // ⚠️ 也要吃 `src:`（2026-09-02）：圖卡 `card({ kind: 'image', src: ... })` 用的是 src，
  // 只認 `image:` 的話那些圖完全沒被守到——加一張帶編號的圖卡進來不會有東西變紅
  for (const m of rest.matchAll(/(?:image|src):\s*ONBOARDING_SHOTS\.(\w+)/g)) {
    const before = rest.slice(0, m.index)
    const html = [...before.matchAll(/html:\s*'((?:[^'\\]|\\.)*)'/g)].pop()
    if (html)
      out.push({ shot: m[1]!, html: html[1]! })
  }
  return out
}

/** onboarding-shots.ts 的 `名稱: '/onboarding/檔名'` → { 名稱: 檔名 } */
function shotFileNames(): Record<string, string> {
  const src = readFileSync(resolve(ROOT, 'app/utils/onboarding-shots.ts'), 'utf8')
  const map: Record<string, string> = {}
  for (const m of src.matchAll(/(\w+):\s*'\/onboarding\/([^']+)'/g))
    map[m[1]!] = m[2]!
  return map
}

const FILES = shotFileNames()
const SOURCES = ['app/composables/useOnboardingChat.ts', 'app/utils/field-help.ts']

describe('教學圖上的編號與文案裡的圈號', () => {
  it('每張圖都登記在 onboarding-shots.ts 裡（漏登記＝測不到）', () => {
    const registered = new Set(Object.values(FILES))
    for (const file of Object.keys(ONBOARDING_SHOT_STEPS))
      expect(registered, `${file} 沒有登記在 onboarding-shots.ts`).toContain(file)
  })

  for (const path of SOURCES) {
    const source = readFileSync(resolve(ROOT, path), 'utf8')
    const pairs = pairShotWithCopy(source)

    it(`${path} 有掃到配圖的文案`, () => {
      expect(pairs.length).toBeGreaterThan(0)
    })

    for (const { shot, html } of pairs) {
      const file = FILES[shot]
      // 圖還沒補進資料夾的（例如岔路那張）不在清單裡，跳過
      if (!file || !(file in ONBOARDING_SHOT_STEPS))
        continue
      const steps = ONBOARDING_SHOT_STEPS[file]!
      const used = [...CIRCLED].filter(c => html.includes(c))

      it(`${path}：${shot} 的文案圈號要對得上圖上的 ${steps} 顆`, () => {
        if (steps === 0) {
          // 沒編號的圖，文案不該憑空冒出圈號（會指到畫面上不存在的東西）
          expect(used, `${shot} 圖上沒有編號，文案卻寫了 ${used.join('')}`).toEqual([])
          return
        }
        expect(used.join(''), `${shot} 的文案要從①連號用到第 ${steps} 個`)
          .toBe([...CIRCLED].slice(0, steps).join(''))
      })
    }
  }
})
