import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：「還沒有現成資料？」那幾條路的**選項順序**與**面板順序**必須一致。
 *
 * 為什麼值得寫：2026-09-13 改推薦順序（見元件裡「三版」那段註解）時，膠囊搬了位置，
 * 但展開面板還留在原地。**這種不一致畫面上完全看不出來**——一次只會有一塊面板出現，
 * 點哪顆就開哪塊，眼睛看起來永遠是對的。代價要到下一個人維護時才出現：
 * 他照畫面順序去改「第一條」，改到的卻是別條的內容，而且沒有任何測試會紅。
 * 同一天的「四版」把三條加到五條，搬動的量更大，這支測試也更值錢。
 *
 * 順帶守住 Vue 的 v-if / v-else-if 鏈：面板是互斥的，第一塊必須 v-if、其餘 v-else-if。
 * 搬動區塊時很容易留下兩個 v-if（行為不變、但鏈斷了）或把 v-else-if 排到 v-if 前面（編譯錯）。
 *
 * ⛔ 這裡刻意**不驗文案**：小註與說明常改，寫進測試只會變成每次改字都要來改測試的稅。
 *    驗的是「順序」這個結構事實。
 */

const SRC = readFileSync(
  fileURLToPath(new URL('./KnowledgeImportDialog.vue', import.meta.url)),
  'utf8',
)

/**
 * 拍板的推薦順序（2026-09-13）。排序依據是兩把尺：**精準度**與**之後會不會自己爛掉**。
 *  · sheet 第一：一列一卡（AI 不用猜分段）＋唯一會自動更新的來源。
 *  · text  第二：內容是自己寫的＝最準，但切法由 AI 決定、且不會自動更新。
 *  · web   第三：零工作量，內容是行銷文案、AI 自己切，至少改了會通知。
 *  · file  第四：手邊已有檔案時零工作量，但 AI 認字要核對、完全不會更新。
 *  · excel 第五：精準度跟 sheet 同級，卻是「做完就開始過期、系統也看不見它過期」，當退路。
 * 要改順序請先更新元件裡「三版／四版」那兩段註解，再改這個陣列——別默默對調。
 */
const EXPECTED_ORDER = ['sheet', 'text', 'web', 'file', 'excel']

/** 只取 template：script 裡也有同名字串的型別宣告，會干擾順序判讀 */
function template(): string {
  const end = SRC.indexOf('<script setup')
  return end > 0 ? SRC.slice(0, end) : SRC
}

/** 膠囊：照原始碼出現順序取 pickStart('x') 的 x */
function chipOrder(tpl: string): string[] {
  return [...tpl.matchAll(/@click="pickStart\('([a-z]+)'\)"/g)].map(m => m[1]!)
}

/** 面板：照原始碼出現順序取 startOpen === 'x' 的 x 與它用的指令 */
function panelOrder(tpl: string): { route: string, directive: string }[] {
  return [...tpl.matchAll(/<div v-(if|else-if)="startOpen === '([a-z]+)'" class="kb-start__panel">/g)]
    .map(m => ({ directive: m[1]!, route: m[2]! }))
}

describe('「還沒有現成資料？」的起步選項', () => {
  const tpl = template()

  it('面板的原始碼順序跟膠囊一致（畫面看不出來，只有維護時會中招）', () => {
    const chips = chipOrder(tpl)
    const panels = panelOrder(tpl).map(p => p.route)

    expect(chips.length, '找不到膠囊的 pickStart(...)').toBeGreaterThan(0)
    expect(
      panels,
      `膠囊順序是 ${chips.join(' → ')}，面板順序卻是 ${panels.join(' → ')}。\n`
      + '修法：把面板區塊搬成跟膠囊一樣的順序（只搬位置、內容別動），並記得第一塊要是 v-if。',
    ).toEqual(chips)
  })

  it('面板是一條完整的 v-if / v-else-if 鏈', () => {
    const panels = panelOrder(tpl)
    const directives = panels.map(p => p.directive)
    const expected = panels.map((_, i) => (i === 0 ? 'if' : 'else-if'))

    expect(
      directives,
      `面板的指令是 ${directives.join(' / ')}。第一塊必須 v-if、其餘全部 v-else-if——`
      + '留下兩個 v-if 雖然現在看起來正常（startOpen 一次只會等於一個值），但鏈一斷，'
      + '之後任何人再加一條路都會踩到兩塊同時出現。',
    ).toEqual(expected)
  })

  it('五條的順序就是拍板的那個順序', () => {
    expect(
      chipOrder(tpl),
      '推薦順序是拍板過的，依據寫在這個檔案上面的 EXPECTED_ORDER 註解與元件的「三版／四版」段落。\n'
      + '真要改順序：先改那兩段說明，再改這裡——別讓程式跟說明各講各的。',
    ).toEqual(EXPECTED_ORDER)
  })

  it('投放框收得了的種類，每一種都有一條教學', () => {
    // ⛔ 這條是「四版」的重點（老闆：這是教學匯入方式，應該要把能怎麼做都列出來）：
    //    detectImportKind 認得 file／url／gsheet／text 四種，四種都要在畫面上找得到入口，
    //    不能因為「我覺得那條不值得推薦」就讓它整個不存在。
    //    excel（下載範本）不是第五種輸入，是 file 的一種起步方式，所以不在這個對照裡。
    const chips = chipOrder(tpl)
    for (const [kind, route] of [
      ['gsheet', 'sheet'],
      ['text', 'text'],
      ['url', 'web'],
      ['file', 'file'],
    ] as const) {
      expect(chips, `投放框收得了「${kind}」，但選項裡沒有對應的 ${route} 那條`).toContain(route)
    }
  })
})
