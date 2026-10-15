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

  it('「答得不對？寫一句正確答案」帶客人問的那句出去；轉真人那幾種是主要按鈕', () => {
    expect(TEMPLATE).toMatch(/@click="emit\('add-one', \{ question: t\.question \}\)"\s*>\s*答得不對？寫一句正確答案/)
    expect(TEMPLATE).toMatch(/v-if="t\.view\.canAddOne && canAddKnowledge"[\s\S]*?寫一句正確答案/)
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
    expect(SCRIPT).toMatch(/req: \{ query: text \}/)
  })

  it('只留最近幾題；讀不到時講原因＋再問一次', () => {
    expect(SCRIPT).toMatch(/turns\.value = keepRecentTurns\(\[\.\.\.turns\.value, t\]\)/)
    expect(SCRIPT).toMatch(/t\.error = apiErrorText\(err, '連不上，請再試一次'\)/)
    expect(TEMPLATE).toContain('沒問成：{{ t.error }}')
  })

  it('畫面上的量詞是「條」，⛔ 不出現「張」「卡片」「知識卡」', () => {
    const visible = TEMPLATE.replace(/\{\{[\s\S]*?\}\}/g, '')
    expect(visible).not.toMatch(/張|卡片|知識卡/)
  })
})
