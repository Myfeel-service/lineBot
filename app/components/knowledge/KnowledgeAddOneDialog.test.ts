import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：「補一條知識」小視窗（`C-317`，2026-10-15 老闆拍板 D-126③）。
 * 每個「補一條」入口都打開這一個：客人問＋正確答案（一兩句）→ 可以按「AI 幫我整理」→ 加入就上線。
 * 元件在 node 測試環境掛不起來，所以讀原始碼驗結構與字；送出去長什麼樣子在 utils/kb-add-one 有單元測試。
 */

const SRC = readFileSync(fileURLToPath(new URL('./KnowledgeAddOneDialog.vue', import.meta.url)), 'utf8')
const CODE = SRC
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '')).join('\n')
const TEMPLATE = CODE.slice(0, CODE.indexOf('<script'))
const SCRIPT = CODE.slice(CODE.indexOf('<script'))

describe('補一條知識', () => {
  it('小視窗：標題、寬度跟其他視窗一樣、兩格（客人問／正確答案）＋「AI 幫我整理」', () => {
    expect(TEMPLATE).toContain('title="補一條知識"')
    expect(TEMPLATE).toContain('width="min(560px, 92vw)"')
    expect(TEMPLATE).toContain('text="客人問"')
    expect(TEMPLATE).toContain('text="正確答案（一兩句就好）"')
    expect(TEMPLATE).toMatch(/AI 幫我整理/)
  })

  it('⛔ 不出現標籤、問法編輯器（客人問的那句自動放進去）', () => {
    expect(TEMPLATE).not.toContain('標籤')
    expect(TEMPLATE).not.toContain('<el-select')
    expect(TEMPLATE).not.toContain('客人可能怎麼問')
  })

  it('一題以上的建議：勾選清單取代「客人問」那一格（`C-311`，同樣的題目不列兩次）', () => {
    expect(TEMPLATE).toMatch(/<div v-if="isMulti" class="kb-suggest-queries">[\s\S]*這一條回答了哪幾題？[\s\S]*<el-checkbox-group v-model="ticked"[\s\S]*v-for="q in queries"[\s\S]*<div v-else class="admin-field-group">\s*<AdminFieldLabel text="客人問"/)
  })

  it('AI 整理用的是編輯視窗「AI 整理一下」那一支；整理好的那一塊可以直接改', () => {
    expect(SCRIPT).toContain("'/api/ai/knowledge/normalize'")
    expect(TEMPLATE).toMatch(/<el-input v-model="preview\.title"/)
    expect(TEMPLATE).toMatch(/<el-input v-model="preview\.content" type="textarea"/)
    // 答案一改，舊的整理就作廢
    expect(SCRIPT).toMatch(/watch\(answer, \(a\) => \{\s*if \(preview\.value && !previewStillFits\(preview\.value, a\)\) preview\.value = null/)
  })

  it('AI 沒整理成照樣加得進去；⛔ 5xx 的工程用語不給店家看', () => {
    expect(SCRIPT).toMatch(/const why = s >= 400 && s < 500 \? apiErrorText\(err, 'AI 這次沒整理成'\) : 'AI 這次沒整理成'/)
    expect(SCRIPT).toContain('可以直接按「加入」')
  })

  it('手動那條路：建一條直接上線的（⛔ 不帶 draft，不進「等你看過」）', () => {
    expect(SCRIPT).toContain("'/api/ai/knowledge/create'")
    expect(SCRIPT).not.toMatch(/draft:\s*true/)
    expect(SCRIPT).not.toMatch(/answeredQueries: payload/)
  })

  it('建議那條路：走 accept（額度、搶同一筆、只回答其中幾題、稽核都在那支），送的就是 addOnePayload', () => {
    expect(SCRIPT).toMatch(/\/api\/ai\/knowledge\/suggestions\/\$\{encodeURIComponent\(s\.id\)\}\/accept`, \{\s*method: 'POST',\s*body: payload,/)
  })

  it('額度滿了這類錯：伺服器的原因留在視窗裡（不只 toast）', () => {
    expect(SCRIPT).toMatch(/errorText\.value = apiErrorText\(err, '沒加成，請再試一次'\)/)
    expect(TEMPLATE).toMatch(/<p v-if="errorText" class="kb-addone__error">\{\{ errorText \}\}<\/p>/)
  })

  it('props／emits 照約定（頁面靠這幾個接）', () => {
    expect(SCRIPT).toMatch(/open: boolean/)
    expect(SCRIPT).toMatch(/initialQuestion\?: string/)
    expect(SCRIPT).toMatch(/suggestion\?: AddOneSuggestion \| null/)
    expect(SCRIPT).toMatch(/\(e: 'update:open', v: boolean\): void/)
    expect(SCRIPT).toMatch(/\(e: 'created', payload: AddOneCreated\): void/)
  })

  it('畫面上的量詞是「條」，⛔ 不出現「張」「卡片」「知識卡」', () => {
    const visible = TEMPLATE.replace(/\{\{[\s\S]*?\}\}/g, '')
    expect(visible).not.toMatch(/張|卡片|知識卡/)
  })
})
