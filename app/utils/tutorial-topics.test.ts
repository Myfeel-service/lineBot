/**
 * 教學內容的防漂移測試。
 *
 * 為什麼要有：教學步驟指向頁面上的 data-tour 錨點，但錨點在別的檔案裡。
 * 改版時把某個按鈕改名／搬走，教學不會報錯——它只會安靜地退化成「不高亮的說明卡」，
 * 沒人實際跑一次導覽就不會發現。2026-08 的稽核就是這樣人工翻出好幾處死錨點的。
 *
 * 用讀檔＋比對字串做（不 import 那支檔案）：它相依 Element Plus 的 Vue 元件，
 * 在 node 測試環境載不動，而我們要驗的本來就只是字串。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const TOPICS_FILE = join(APP_DIR, 'utils/tutorial-topics.ts')
const SETUP_STATUS_FILE = join(APP_DIR, 'composables/useSetupStatus.ts')

/**
 * 由程式動態組出來的錨點，掃 .vue 的字面值找不到，要在這裡登記。
 * flow-sys-*：flow.vue 用 `flow-sys-${flow.moduleType}` 產生。
 */
const DYNAMIC_ANCHORS = new Set(['flow-sys-welcome', 'flow-sys-live_agent'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory())
      walk(full, out)
    else if (entry.endsWith('.vue'))
      out.push(full)
  }
  return out
}

/** 頁面上實際存在的錨點：.vue 的 data-tour 字面值 + 側欄設定表的 tour: 'xxx' */
function collectDefinedAnchors(): Set<string> {
  const defined = new Set(DYNAMIC_ANCHORS)
  for (const file of walk(APP_DIR)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/data-tour="([^"$]+)"/g))
      defined.add(m[1]!)
    // 側欄項目是資料驅動的：{ ..., tour: 'nav-knowledge' } → :data-tour="item.tour"
    for (const m of src.matchAll(/\btour:\s*'([^']+)'/g))
      defined.add(m[1]!)
  }
  return defined
}

/** 教學/體檢引用到的錨點 */
function collectReferencedAnchors(): { anchor: string, file: string }[] {
  const refs: { anchor: string, file: string }[] = []
  for (const file of [TOPICS_FILE, SETUP_STATUS_FILE]) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\[data-tour="([^"]+)"\]/g))
      refs.push({ anchor: m[1]!, file: file.replace(APP_DIR, 'app/') })
  }
  return refs
}

describe('教學導覽的錨點', () => {
  it('每個引用到的 data-tour 都真的存在於某個頁面上', () => {
    const defined = collectDefinedAnchors()
    const missing = collectReferencedAnchors()
      .filter(r => !defined.has(r.anchor))
      .map(r => `${r.anchor}（被 ${r.file} 引用）`)

    expect(missing, `這些錨點在頁面上找不到，導覽會安靜退化成不高亮的說明卡：\n${missing.join('\n')}`)
      .toEqual([])
  })
})

describe('教學文案的寫作規則', () => {
  const src = readFileSync(TOPICS_FILE, 'utf8')

  it('步驟標題不手寫「第 N 步」或圈號——步數由畫面自動標', () => {
    const offenders = [...src.matchAll(/^\s*title:\s*'([^']*)'/gm)]
      .map(m => m[1]!)
      .filter(t => /第\s*\d+\s*步/.test(t) || /[①-⑳]/.test(t))

    expect(offenders, `手寫編號會在功能旗標關掉某一步時跳號、也會跟實際步數漂移：\n${offenders.join('\n')}`)
      .toEqual([])
  })

  it('blurb 不手寫「共 N 步」——畫面會自己算', () => {
    const offenders = [...src.matchAll(/^\s*blurb:\s*'([^']*)'/gm)]
      .map(m => m[1]!)
      .filter(t => /共\s*\d+\s*步|\d+\s*步/.test(t))

    expect(offenders, `步數寫死在文案裡，加減步驟時一定會忘記改：\n${offenders.join('\n')}`)
      .toEqual([])
  })
})
