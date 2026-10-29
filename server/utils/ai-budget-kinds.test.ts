import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試（`C-413`）：每月上限的三本帳，「圈在哪一本」跟「記帳記進哪一格」要對得上。
 *
 * 為什麼讀原始碼而不是跑起來測：會出事的是「新功能圈錯本／記錯本」——兩邊都是一行參數，
 * 型別全對、單元測試也綠（那幾支的測試都把記帳假掉、不看記了什麼），擋的跟數的就悄悄對不起來：
 *   - 圈 `background` 卻記成店家那本 → 客人聊得多又會擋到店家加資料（`C-413` 要修的那件事又回來）
 *   - 圈 `assist`（後台自用）卻記進整理桶 → 小幫手的用量吃掉店家加資料的上限
 *   - 背景工作記帳沒包 `asBackgroundUsage` → 背景那本永遠是 0，煞車形同虛設
 *   - 反過來數了卻沒圈（`C-414` 的知識缺口掃描、後台自用整個 test 桶）→ 它自己超了照跑，被擋的是別人
 */

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))

function serverSources(dir = SERVER_DIR): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...serverSources(p))
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** 從 `name(` 開始取到括號平衡為止（呼叫的全文） */
function callsOf(src: string, name: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = src.indexOf(`${name}(`, from)
    if (at < 0) break
    let depth = 0
    let end = at + name.length
    for (; end < src.length; end++) {
      const ch = src[end]
      if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) break
    }
    out.push(src.slice(at, end + 1))
    from = end + 1
  }
  return out
}

const files = serverSources().map(path => ({ path, src: readFileSync(path, 'utf8') }))
const rel = (p: string) => p.slice(SERVER_DIR.length)

/** 每一處 runWithLlmBudget(…) 圈的是哪一本（最後一個參數） */
const budgetCalls = files.flatMap(f => callsOf(f.src, 'runWithLlmBudget')
  .filter(c => !c.startsWith('runWithLlmBudget(workspaceId: string')) // 宣告本身
  .map(c => ({ file: rel(f.path), src: f.src, kind: c.match(/,\s*'(knowledge|background|assist)'\s*\)$/)?.[1] ?? null, call: c })))

describe('`C-413` 圈哪一本、記哪一格要對得上', () => {
  it('找得到那些呼叫（測試本身沒壞）', () => {
    expect(budgetCalls.length).toBeGreaterThan(15)
  })

  it('每一處 runWithLlmBudget 都講了是哪一本', () => {
    const missing = budgetCalls.filter(c => !c.kind).map(c => `${c.file}: ${c.call.slice(0, 80)}`)
    expect(missing).toEqual([])
  })

  it('圈「背景」的檔：記帳一律包 asBackgroundUsage（背景那本才數得到）', () => {
    const bad: string[] = []
    for (const file of new Set(budgetCalls.filter(c => c.kind === 'background').map(c => c.file))) {
      const src = files.find(f => rel(f.path) === file)!.src
      for (const rec of callsOf(src, 'recordAiUsage')) {
        if (!rec.includes('asBackgroundUsage(')) bad.push(`${file}: ${rec.slice(0, 100)}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('知識缺口掃描也要圈在背景那本（`C-414`：以前只記不圈，自己用超了照跑、反而擋掉貼標建議）', () => {
    const file = files.find(f => rel(f.path).endsWith('utils/ai-knowledge-suggest.ts'))!
    expect(budgetCalls.filter(c => c.file === rel(file.path)).map(c => c.kind)).toContain('background')
    const recs = callsOf(file.src, 'recordAiUsage')
    expect(recs.length).toBeGreaterThan(0)
    expect(recs.filter(r => !r.includes('asBackgroundUsage('))).toEqual([])
  })

  it('反過來：標了背景的檔一定有圈背景那本（數了卻不擋＝它自己超了照跑，擋到的是別人）', () => {
    const gated = new Set(budgetCalls.filter(c => c.kind === 'background').map(c => c.file))
    const bad = files.filter(f => f.src.includes('asBackgroundUsage(') && !rel(f.path).endsWith('ai-usage-calls.ts'))
      .map(f => rel(f.path))
      .filter(file => !gated.has(file))
    expect(bad).toEqual([])
  })

  it('圈「後台自用」的檔：不記進整理桶（不然小幫手會吃掉店家加資料的上限）', () => {
    const bad = [...new Set(budgetCalls.filter(c => c.kind === 'assist').map(c => c.file))]
      .filter(file => /usageFromCalls\('build'/.test(files.find(f => rel(f.path) === file)!.src))
    expect(bad).toEqual([])
  })

  it('圈「後台自用」的檔：記帳一律包 asAssistUsage（`C-414`：那本只數這一格）', () => {
    const bad: string[] = []
    for (const file of new Set(budgetCalls.filter(c => c.kind === 'assist').map(c => c.file))) {
      const src = files.find(f => rel(f.path) === file)!.src
      for (const rec of callsOf(src, 'recordAiUsage')) {
        if (!rec.includes('asAssistUsage(')) bad.push(`${file}: ${rec.slice(0, 100)}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('⛔ 沒圈「後台自用」的檔不可以標 asAssistUsage（測試對話、AI 產生腳本沒被擋，數進來就是拿它們擋小幫手）', () => {
    const gated = new Set(budgetCalls.filter(c => c.kind === 'assist').map(c => c.file))
    const bad = files.filter(f => f.src.includes('asAssistUsage(') && !rel(f.path).endsWith('ai-usage-calls.ts'))
      .map(f => rel(f.path))
      .filter(file => !gated.has(file))
    expect(bad).toEqual([])
  })

  it('圈「店家加資料」的檔：不標背景（不然店家那本會被扣成少算）', () => {
    const bad = [...new Set(budgetCalls.filter(c => c.kind === 'knowledge').map(c => c.file))]
      .filter(file => files.find(f => rel(f.path) === file)!.src.includes('asBackgroundUsage('))
    expect(bad).toEqual([])
  })
})
