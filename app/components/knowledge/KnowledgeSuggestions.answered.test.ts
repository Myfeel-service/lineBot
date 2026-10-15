import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：「客人問了、AI 答不出來」每一列（`C-311` 逐題勾，2026-10-14；`C-318` 三選一，2026-10-15）。
 *
 * `C-318` 以前：只有「審核草稿」（四格大視窗）跟「忽略」。MYFEEL 36 筆只採用 2 筆——不是沒用，是補起來太麻煩。
 * 現在每一列三顆：「寫一句答案」打開「補一條知識」小視窗（勾哪幾題的 `C-311` 清單搬進那個視窗，見
 * KnowledgeAddOneDialog.test.ts）、「交給真人就好」、「不用管」（後兩個整組拿掉、原因記下來）。
 * 元件在 node 測試環境掛不起來，所以讀原始碼驗結構與字；規則本身在 utils 有單元測試。
 */

const SRC = readFileSync(fileURLToPath(new URL('./KnowledgeSuggestions.vue', import.meta.url)), 'utf8')
/** 拿掉註解：只驗畫面上會出現的字與真的會跑的程式 */
const CODE = SRC
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '')).join('\n')
const TEMPLATE = CODE.slice(0, CODE.indexOf('<script'))
const SCRIPT = CODE.slice(CODE.indexOf('<script'))

describe('每一列三選一（C-318）', () => {
  it('三顆按鈕：「寫一句答案」是主要的，另外兩顆是一般按鈕', () => {
    expect(TEMPLATE).toMatch(/<el-button size="small" type="primary" @click="openAddOne\(s\)">寫一句答案<\/el-button>/)
    expect(TEMPLATE).toMatch(/@click="dismiss\(s, 'handoff'\)"\s*>\s*交給真人就好/)
    expect(TEMPLATE).toMatch(/@click="dismiss\(s, 'ignore'\)"\s*>\s*不用管/)
    // 窄欄要能換行（樣式見 _knowledge-add-one.scss）
    expect(TEMPLATE).toContain('kb-suggest-item__actions--three')
  })

  it('⛔ 舊的「審核草稿」大視窗拿掉了（標題／內容／問法／標籤四格）：改開「補一條知識」小視窗', () => {
    expect(TEMPLATE).not.toContain('審核草稿')
    expect(TEMPLATE).not.toContain('<el-select')
    expect(TEMPLATE).not.toContain('標籤')
    expect(TEMPLATE).toMatch(/<KnowledgeAddOneDialog\s+v-model:open="addOneOpen"\s+:suggestion="addOneSuggestion"\s+@created="onCreated"/)
  })

  it('預設勾哪幾題走 defaultAnsweredQueries（`C-311`，⛔ 不是全勾），第三個參數是標題欄會填的字', () => {
    expect(SCRIPT).toMatch(/const title = s\.draft\?\.title \?\? s\.topic/)
    expect(SCRIPT).toMatch(/defaultAnsweredQueries\(qs, s\.draft\?\.questions, title\)/)
    // 清單列的是這一組全部的題目，不是只有 5 條樣本
    expect(SCRIPT).toMatch(/groupQueries = \(s: SuggestionRow\) => \(s\.queries\?\.length \? s\.queries : s\.sampleQueries\)/)
    // AI 先擬好的草稿交給視窗當一開始的預覽
    expect(SCRIPT).toMatch(/draft: s\.draft,/)
  })

  it('只回答了其中幾題：重讀清單（沒勾的那筆還在、名字與次數伺服器重算過）；整組回答完才從清單拿掉', () => {
    expect(SCRIPT).toMatch(/if \(\(p\.remainingQuestions \?\? 0\) > 0\) await load\(\)/)
    expect(SCRIPT).toMatch(/else if \(id\) items\.value = items\.value\.filter\(i => i\.id !== id\)/)
    expect(SCRIPT).toMatch(/emit\('accepted'\)/)
  })

  it('「交給真人就好」／「不用管」：整組拿掉、帶原因；好幾題時先問一句', () => {
    expect(SCRIPT).toMatch(/\/dismiss`, \{ method: 'POST', body: \{ reason \} \}\)/)
    expect(SCRIPT).toMatch(/if \(n > 1\) \{\s*try \{\s*await ElMessageBox\.confirm\(/)
    expect(SCRIPT).toContain('這一組的 ${n} 題都不再列。')
    expect(SCRIPT).toContain("'好，這類問題交給真人'")
    expect(SCRIPT).toContain("'已略過'")
    // 失敗講伺服器的原因（`C-308`⑩），不是一律「請再試一次」
    expect(SCRIPT).toMatch(/showToast\(apiErrorText\(err, '沒改成，請再試一次'\), 'error'\)/)
  })

  it('標題那一行照舊（`C-314`）：「客人問了、AI 答不出來（N）」＋小小的「重新掃描」', () => {
    expect(TEMPLATE).toContain('<strong>客人問了、AI 答不出來</strong>')
    expect(TEMPLATE).toMatch(/<el-button v-else-if="canEdit" link type="primary" size="small" class="kb-suggest-head__aside"[^>]*>\s*重新掃描/)
  })

  it('畫面上的量詞是「條」／「題」，⛔ 不出現「張」「卡片」「知識卡」', () => {
    const visible = TEMPLATE.replace(/\{\{[\s\S]*?\}\}/g, '')
    expect(visible).not.toMatch(/張|卡片|知識卡/)
  })
})
