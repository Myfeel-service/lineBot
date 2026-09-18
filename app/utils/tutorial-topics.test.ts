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

describe('認識後台總覽導覽（2026-08-28）', () => {
  const src = readFileSync(TOPICS_FILE, 'utf8')
  const ids = readFileSync(join(APP_DIR, 'utils/tutorial-ids.ts'), 'utf8')
  const onboardingChat = readFileSync(join(APP_DIR, 'composables/useOnboardingChat.ts'), 'utf8')

  it('總覽主題存在，而且掛在 OVERVIEW_TOPIC_ID 這個常數上', () => {
    // 常數本體搬到沒有相依的小檔（開通頁只為了一個字串不該拖整套教學內容進 bundle）；
    // ⛔這裡只 import 不 re-export，否則會出現兩個同名的自動匯入來源
    expect(ids).toMatch(/export const OVERVIEW_TOPIC_ID = 'overview'/)
    expect(src).toContain("import { OVERVIEW_TOPIC_ID } from './tutorial-ids'")
    expect(src).not.toMatch(/export \{ OVERVIEW_TOPIC_ID \}/)
    expect(src).toContain('id: OVERVIEW_TOPIC_ID')
  })

  it('開通引導結尾吃同一個常數，不是各寫一次字串', () => {
    // 兩邊各寫一次 'overview' 的話，改 id 只會改到一邊，按鈕就變成按了沒反應
    expect(onboardingChat).toContain('OVERVIEW_TOPIC_ID')
    expect(onboardingChat, '⛔別把 tour 的 id 寫死在網址字串裡')
      .not.toMatch(/\?tour=overview/)
  })

  it('總覽會帶到小幫手與頁首問號——這支導覽同時要解決「找不到教學入口」', () => {
    expect(src).toContain('[data-tour="ta-fab"]')
    expect(src).toContain('[data-tour="page-help"]')
  })
})

describe('客服對話導覽擴到右半邊（2026-08-28）', () => {
  const src = readFileSync(TOPICS_FILE, 'utf8')
  const convBlock = src.slice(src.indexOf('id: \'conversations\''), src.indexOf('id: \'flow\''))

  it('涵蓋接手／回覆／客服預存這幾件每天在做的事', () => {
    for (const anchor of ['conv-header', 'conv-actions', 'conv-messages', 'conv-reply', 'conv-presets'])
      expect(convBlock, `少了 ${anchor}：右半邊又變回沒人教`).toContain(`[data-tour="${anchor}"]`)
  })

  it('右半邊第一步會先幫使用者點開一筆對話', () => {
    // ⛔ 沒選對話時右半邊整棵 DOM 都不存在（AdminSplitLayout 的 v-if/v-else），
    //    不先點開的話後面每一步都會退化成「這一步要指的位置目前不在畫面上」
    expect(convBlock).toMatch(/clickBefore:\s*'\.conv-list-row \.split-list-item'/)
  })

  it('只有能操作的角色才看得到那幾步（觀察者畫面上根本沒有那些按鈕）', () => {
    const operateSteps = [...convBlock.matchAll(/requiresOperate:\s*true/g)]
    expect(operateSteps.length).toBeGreaterThanOrEqual(3)
  })
})

/**
 * 教學的權限條件必須跟**頁面實際的權限**對齊（2026-09-18 `D-82`）。
 *
 * 為什麼要守：這兩處漂掉時畫面上完全看不出來——頁首那顆「這頁怎麼用」在沒有可跑的教學時
 * 是**整顆不畫**的（`AdminPageHelpButton` 的 v-if），自動導覽也一樣安靜地不跑。
 * 症狀是「能改的人看不到教學」，而唯一會發現的人正是最不會回報的那群（第一線客服）。
 *
 * 兩邊都驗：能力表那一側改了（例如把腳本收回管理員），這裡也會紅，提醒回來重看教學條件。
 */
describe('教學的權限條件跟頁面對齊', () => {
  const src = readFileSync(TOPICS_FILE, 'utf8')
  const perms = readFileSync(join(APP_DIR, '../shared/permissions.ts'), 'utf8')

  /** 切出單一主題的區塊（主題的 id 一律在第 4 格縮排，步驟裡的東西都比它深） */
  function topicBlock(id: string): string {
    const start = src.indexOf(`id: '${id}'`)
    expect(start, `找不到教學主題 ${id}`).toBeGreaterThan(-1)
    const next = src.indexOf('\n    id: ', start + 1)
    return next === -1 ? src.slice(start) : src.slice(start, next)
  }

  it('自動回應：客服就能改這一頁，教學不可以鎖管理員', () => {
    expect(perms, '能力表改了就回來重看這支教學的條件').toContain("'scripts.write': 'agent'")
    const block = topicBlock('ai-scripts')
    expect(block, '⛔ 鎖了管理員的話，客服進這頁連問號都不會出現')
      .not.toMatch(/requiresSettings:\s*true/)
    expect(block).toMatch(/requiresOperate:\s*true/)
  })

  it('AI 表現：所有成員都看得到這一頁，教學不可以設任何權限條件', () => {
    expect(perms, '能力表改了就回來重看這支教學的條件').toContain("'ai.read': 'viewer'")
    const block = topicBlock('ai-usage')
    // ⛔ 主題層級不設條件；只有「補知識」那一步要能操作（觀察者按了是死路）
    expect(block.slice(0, block.indexOf('steps:')))
      .not.toMatch(/requiresSettings:\s*true|requiresOperate:\s*true/)
    expect(block, '「補知識」那一步要標 requiresOperate').toMatch(/requiresOperate:\s*true/)
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
