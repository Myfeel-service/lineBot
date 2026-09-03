import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：`KnowledgeImportDialog.vue` 裡「watch 的來源」不可以讀到宣告在它後面的 ref。
 *
 * 為什麼值得為一個檔案寫這種測試：**同一顆雷在這支元件炸過三次**（最近一次是 2026-09-03，
 * 一輪就踩兩次），而後果每次都一樣嚴重——整個元件 setup 當場拋
 * `Cannot access 'X' before initialization`，於是按下「加入知識」只會看到一片空白，
 * 而知識庫這一頁的其他功能也跟著死。
 *
 * ⛔ `npx nuxt typecheck` 抓不到：TS 只看得到「同一個作用域裡的直接引用」，
 *    看不穿 `computed` 的 getter 閉包（`watch(() => detected.value?.label, …)` 型別上完全合法）。
 * ⛔ 一般的單元測試也抓不到：要真的把元件掛起來才會炸，而這支元件相依整個 Nuxt 執行環境。
 *    所以改成讀原始碼做順序檢查——便宜、而且守得住。
 *
 * 規則只針對**真正會炸**的那一種：
 *  · `watch` 的**第一個參數**（來源）在註冊當下就會求值一次 → 它（以及它透過 computed
 *    間接讀到的東西）必須全部宣告在前面。
 *  · `watch` 的**回呼內容**不算（回呼是變動時才跑），惰性 `computed` 自己也不算
 *    （模板渲染時才求值，那時 setup 早就跑完了）——這兩種誤報如果一起擋，
 *    會逼人把整支檔案重排，反而沒人願意維護這條規則。
 */

const SRC = readFileSync(
  fileURLToPath(new URL('./KnowledgeImportDialog.vue', import.meta.url)),
  'utf8',
)

/** `<script setup>` 的內容與逐行陣列 */
function scriptLines(): string[] {
  const m = SRC.match(/<script setup[^>]*>([\s\S]*)<\/script>/)
  return (m?.[1] ?? SRC).split('\n')
}

/** `const X = ref(/computed(/shallowRef(/useState(` → 行索引 */
function declarations(lines: string[]): Map<string, number> {
  const decl = new Map<string, number>()
  lines.forEach((ln, i) => {
    const m = ln.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(ref|computed|shallowRef|useState)\b/)
    if (m && !decl.has(m[1]!)) decl.set(m[1]!, i)
  })
  return decl
}

/** 從某行開始，取到括號平衡為止的文字（用來抓一個 computed 的 body 或一個 watch 的呼叫） */
function balancedFrom(lines: string[], start: number): string {
  let depth = 0
  const out: string[] = []
  for (let j = start; j < lines.length; j++) {
    const ln = lines[j]!
    out.push(ln)
    depth += (ln.match(/\(/g)?.length ?? 0) - (ln.match(/\)/g)?.length ?? 0)
    if (depth <= 0 && ln.includes('(')) break
  }
  return out.join('\n')
}

/** 只取 `watch(` 的第一個參數（來源）；以頂層逗號切開 */
function watchSource(call: string): string {
  const open = call.indexOf('(')
  const inner = call.slice(open + 1)
  let depth = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) return inner.slice(0, i)
  }
  return inner
}

const references = (expr: string, name: string) =>
  new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(expr)

describe('KnowledgeImportDialog 的宣告順序', () => {
  it('watch 的來源（含它透過 computed 讀到的東西）都宣告在前面', () => {
    const lines = scriptLines()
    const decl = declarations(lines)
    const problems: string[] = []

    lines.forEach((ln, i) => {
      if (!/^\s*watch(Effect)?\(/.test(ln)) return
      const call = balancedFrom(lines, i)
      const source = /^\s*watchEffect\(/.test(ln) ? call : watchSource(call)

      // 來源直接引用的 ref/computed，加上它們（一層）透過 computed 間接引用的
      const seen = new Set<string>()
      const queue: string[] = []
      for (const [name] of decl) if (references(source, name)) queue.push(name)

      while (queue.length) {
        const name = queue.shift()!
        if (seen.has(name)) continue
        seen.add(name)
        const at = decl.get(name)!
        if (at > i) {
          problems.push(`script 第 ${i + 1} 行的 watch 來源用到 ${name}，但它宣告在第 ${at + 1} 行`)
        }
        // 這個名字若是 computed，它 getter 裡讀到的東西也會在同一刻被求值
        if (/^\s*const\s+\S+\s*=\s*computed\b/.test(lines[at]!)) {
          const body = balancedFrom(lines, at)
          for (const [inner] of decl) {
            if (inner !== name && !seen.has(inner) && references(body, inner)) queue.push(inner)
          }
        }
      }
    })

    // 訊息裡直接寫出怎麼修，下一個踩到的人不必再查一次
    expect(problems, `${problems.join('\n')}\n\n修法：把那個 ref 的宣告移到這個 watch 之前（或把 watch 移到宣告之後）。`).toEqual([])
  })
})
