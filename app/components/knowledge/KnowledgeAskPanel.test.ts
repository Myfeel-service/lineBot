import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：知識庫頁右邊「問 AI 一題」（`C-315`，2026-10-15 老闆拍板 D-126②）。
 * 元件在 node 測試環境掛不起來，所以讀原始碼驗結構與字；怎麼講一題結果在 utils/kb-ask-result 有單元測試。
 */

const SRC = readFileSync(fileURLToPath(new URL('./KnowledgeAskPanel.vue', import.meta.url)), 'utf8')
const CODE = SRC
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '')).join('\n')
const TEMPLATE = CODE.slice(0, CODE.indexOf('<script'))
const SCRIPT = CODE.slice(CODE.indexOf('<script'))

describe('問 AI 一題', () => {
  it('導覽錨點、標題＋一行小字、輸入框提示（示意頁的字）', () => {
    expect(TEMPLATE).toMatch(/<section class="kb-ask" data-tour="kb-ask">/)
    expect(TEMPLATE).toContain('問 AI 一題')
    expect(TEMPLATE).toContain('不會傳給客人')
    expect(TEMPLATE).toContain('打一句客人會問的話…')
  })

  it('用的是測試對話那一支（不寫對話紀錄、不扣額度）', () => {
    expect(SCRIPT).toContain("'/api/ai/playground'")
  })

  it('答案底下「用了這 N 條：」，每一條點了打開那一條；還沒上線的標出來', () => {
    expect(TEMPLATE).toMatch(/用了這 \{\{ t\.view\.sources\.length \}\} 條：/)
    expect(TEMPLATE).toMatch(/@click="emit\('open-chunk', \{ chunkId: row\.chunkId, sourceId: row\.sourceId \}\)"/)
    expect(TEMPLATE).toContain('（還沒上線）')
  })

  it('「答得不對？寫一句正確答案」帶這一題出去（點反問選項那幾步也是原本那一題）；轉真人那幾種是主要按鈕', () => {
    expect(TEMPLATE).toMatch(/@click="emit\('add-one', \{ question: c\.question \}\)"\s*>\s*答得不對？寫一句正確答案/)
    expect(TEMPLATE).toMatch(/v-if="t\.view\.canAddOne && canAddKnowledge"[\s\S]*?@click="emit\('add-one', \{ question: c\.question \}\)"[\s\S]*?寫一句正確答案/)
    // 轉真人：講客人實際會收到什麼
    expect(TEMPLATE).toContain('{{ t.view.customerGets }}')
  })

  it('emits 只有兩個：open-chunk、add-one（頁面靠這兩個接）', () => {
    const block = SCRIPT.match(/defineEmits<\{([\s\S]*?)\}>\(\)/)?.[1] ?? ''
    const names = [...block.matchAll(/\(e: '([^']+)'/g)].map(m => m[1])
    expect(names).toEqual(['open-chunk', 'add-one'])
    expect(block).toContain("(e: 'open-chunk', payload: { chunkId: string, sourceId: string | null }): void")
    expect(block).toContain("(e: 'add-one', payload: { question: string }): void")
  })

  it('⛔ 注音選字的 Enter 不算送出', () => {
    expect(SCRIPT).toMatch(/if \(e\.isComposing \|\| e\.keyCode === 229\) return/)
  })

  it('一般提問不帶前文（一題一題確認）；只有點反問選項那一輪才帶', () => {
    expect(SCRIPT).toMatch(/\.\.\.\(t\.req\.history \? \{ history: t\.req\.history, skipDisambiguation: true, isFollowup: true, followupOf: t\.req\.followupOf \} : \{\}\)/)
    expect(SCRIPT).toMatch(/newStep\(text, \{ query: text \}\)/)
    // 點選項那一步接在同一張裡、前文是原本那一題＋AI 的反問
    expect(SCRIPT).toMatch(/c\.steps\.push\(newStep\(optionText, \{ query: optionText, followupOf: c\.question, history \}\)\)/)
  })

  it('只留最近幾題（一題一張，數的是張數）；讀不到時講原因＋再問一次', () => {
    expect(SCRIPT).toMatch(/cards\.value = keepRecentTurns\(\[\.\.\.cards\.value, card\]\)/)
    expect(SCRIPT).toMatch(/t\.error = apiErrorText\(err, '連不上，請再試一次'\)/)
    expect(TEMPLATE).toContain('沒問成：{{ t.error }}')
  })

  // ── `D-168`（2026-11-04）：輸入框固定在上面、一題一張新的在上、之前的收成一行、還沒問過列幾句點了就問的 ──
  it('輸入框在標題那一塊裡（⛔ 不再放最底下：問了第一題就跳位置、還被右下角小幫手擠窄）', () => {
    const head = TEMPLATE.match(/<header class="kb-ask__head">([\s\S]*?)<\/header>/)?.[1] ?? ''
    expect(head).toContain('class="kb-ask__bar"')
    expect(head).toContain('<el-input')
    expect(head).toMatch(/<el-button type="primary"[^>]*@click="ask"/)
    expect(TEMPLATE).not.toContain('kb-ask__foot')
    // 底下那一段在標題後面、自己捲
    expect(TEMPLATE.indexOf('</header>')).toBeLessThan(TEMPLATE.indexOf('ref="bodyEl"'))
  })

  it('新的在上面：畫面照 shownCards（cards 倒過來）排，第一張整張攤開、之後的收成一行點了才展開', () => {
    expect(SCRIPT).toMatch(/const shownCards = computed\(\(\) => \[\.\.\.cards\.value\]\.reverse\(\)\)/)
    expect(TEMPLATE).toMatch(/v-for="\(c, ci\) in shownCards"/)
    expect(TEMPLATE).toMatch(/<p v-if="ci === 1" class="kb-ask__older-label">剛剛問過<\/p>/)
    expect(TEMPLATE).toMatch(/<button v-if="ci > 0" type="button" class="kb-ask__card-head is-toggle" :aria-expanded="isOpen\(c\)" @click="toggle\(c\)">/)
    expect(TEMPLATE).toMatch(/<div v-if="ci === 0 \|\| isOpen\(c\)" class="kb-ask__card-body">/)
    // 問了新的一題，之前點開的全部收起來
    expect(SCRIPT).toMatch(/function pushCard[\s\S]*?openIds\.value = \[\]/)
  })

  it('每一題旁邊一個結果小章（看最後一步，還在問的不標），收成一行時只看它就知道那題怎麼了', () => {
    expect(SCRIPT).toMatch(/t && !t\.pending \? askVerdict\(t\.view, t\.error\) : null/)
    expect((TEMPLATE.match(/<el-tag v-if="verdicts\[c\.id\]"/g) ?? []).length).toBe(2)
  })

  it('反問的選項只有最新那一題的最後一步點得到', () => {
    expect(TEMPLATE).toMatch(/:disabled="ci !== 0 \|\| si !== c\.steps\.length - 1 \|\| running"/)
  })

  it('還沒問過才列範例；點一句就直接問（不用再按送出）；頁面沒給就不列', () => {
    expect(TEMPLATE).toMatch(/<div v-if="!cards\.length && examples\?\.questions\.length" class="kb-ask__try">/)
    expect(TEMPLATE).toMatch(/v-for="q in examples\.questions"[\s\S]*?:disabled="!canAsk \|\| running"[\s\S]*?@click="askText\(q\)"/)
    expect(SCRIPT).toMatch(/examples\?: AskExamples \| null/)
  })

  it('畫面上的量詞是「條」，⛔ 不出現「張」「卡片」「知識卡」', () => {
    const visible = TEMPLATE.replace(/\{\{[\s\S]*?\}\}/g, '')
    expect(visible).not.toMatch(/張|卡片|知識卡/)
  })
})
