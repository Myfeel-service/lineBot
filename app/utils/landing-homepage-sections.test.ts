/**
 * 官網首頁的區塊組成（2026-10-20 `D-104`②③，老闆照建議）：
 *   ② 證言牆（十位虛構店家的情境示意）拿掉——等前 10 家試用店家寫具名心得再放回；
 *   ③ 「讓你的生意每年都翻倍」成長區整區拿掉——績效保證式的說法。
 * 拿掉之後要守住兩件事：①導覽列不能留死錨點 ②白灰交錯不能斷（連兩塊同色）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const landing = readFileSync(`${APP_DIR}pages/index.vue`, 'utf8')
/** 只看真的會畫出來的模板：註解裡講歷史的字不算 */
const template = landing.slice(0, landing.indexOf('<script')).replace(/<!--[\s\S]*?-->/g, '')
const script = landing.slice(landing.indexOf('<script'))

describe('首頁拿掉的兩區（D-104②③）', () => {
  it('證言牆不在了（虛構店家的情境示意）', () => {
    expect(template).not.toContain('lp-voices')
    expect(template).not.toContain('非真實客戶見證')
    expect(script).not.toMatch(/\bLP_VOICES\b/)
  })

  it('「每年都翻倍」成長區不在了', () => {
    expect(template).not.toContain('每年都翻倍')
    expect(template).not.toContain('id="grow"')
    expect(template).not.toContain('lp-chart')
  })

  it('頁內錨點都找得到目標（導覽列的「成長」要跟著拿掉）', () => {
    const ids = new Set([...template.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]))
    const targets = [...template.matchAll(/(?<![:\w-])href="#([\w-]+)"/g)].map(m => m[1])
    expect(targets.length).toBeGreaterThan(3) // 網撈得到東西（導覽列至少有三個）
    expect(targets.filter(t => !ids.has(t))).toEqual([])
  })
})

describe('白灰交錯（拿掉區塊後不能連兩塊同色）', () => {
  /** 從模板讀出每一區的底色規則：靜態 class、或綁 #fast 開關的 tintWhenFast* */
  const sections = [...template.matchAll(/<section\b([^>]*)>/g)].map((m) => {
    const attrs = m[1]
    const cls = attrs.match(/\bclass="([^"]*)"/)?.[1] ?? ''
    const bind = attrs.match(/:class="(tintWhenFast(?:Shown|Hidden))"/)?.[1]
    const vIf = attrs.match(/v-if="(\w+)"/)?.[1]
    const id = attrs.match(/\bid="([\w-]+)"/)?.[1] ?? cls
    return { id, cls, bind, vIf }
  })

  const sequence = (fastShown: boolean) => sections
    // 留客橋段（SHOW_KEEP_SECTION）有自己的底、收尾 CTA 是綠的：都不在交錯裡
    .filter(s => !s.cls.includes('lp-keep') && !s.cls.includes('lp-cta'))
    .filter(s => s.vIf !== 'SHOW_FAST_SECTION' || fastShown)
    .map(s => ({
      id: s.id,
      tint: s.cls.includes('lp-section--tint')
        || (s.bind === 'tintWhenFastShown' && fastShown)
        || (s.bind === 'tintWhenFastHidden' && !fastShown),
    }))

  it('模板讀得到預期的區塊（網撈得到東西）', () => {
    expect(sequence(false).map(s => s.id)).toEqual(['why', 'value', 'pricing', 'faq'])
    expect(sequence(true).map(s => s.id)).toEqual(['why', 'value', 'fast', 'pricing', 'faq'])
  })

  for (const fastShown of [false, true]) {
    it(`#fast ${fastShown ? '打開' : '藏著（現況）'}時，相鄰兩區一灰一白`, () => {
      const seq = sequence(fastShown)
      const same: string[] = []
      for (let i = 1; i < seq.length; i++) {
        if (seq[i]!.tint === seq[i - 1]!.tint) same.push(`${seq[i - 1]!.id}→${seq[i]!.id}`)
      }
      expect(same).toEqual([])
      expect(seq[0]!.tint).toBe(true) // why 是灰的（hero 尾端融色的終點，見 is-keep-next）
    })
  }

  it('script 的旗標仍是現況：#fast 藏著（若打開，上面那條「打開」的情境就是現況）', () => {
    expect(script).toMatch(/const SHOW_FAST_SECTION = false/)
  })
})
