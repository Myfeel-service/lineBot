import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 前端的按鈕顯隱只能讀權限表（`G-109`，跟後端的 `server/utils/endpoint-guards.test.ts` 成對）。
 *
 * ⛔ 不可以再用「客服以上／管理員以上」兩顆大開關（`canOperate`、`canManageSettings`、`canWrite`、
 *    `hasMinRole`）決定某一顆按鈕要不要出現——要寫 `can('<那顆按鈕打的端點用的能力>')`。
 *    為什麼：後端每支端點已經各自讀表（`requireCapability`），前端還用大開關猜的話，只要有人調了
 *    某一項的門檻，畫面就跟端點對不上——「看得到卻 403」或「藏起來卻其實能做」（`G-102` 那種）。
 *
 * 允許的例外只有「身分本身的外觀」：觀察者模式那條提示、唯讀樣式（`isViewer`）——那是在講
 * 「你是誰」，不是「這個功能誰能用」。
 */

const ROOT = join(__dirname, '..', '..')

/**
 * 大開關的名字：app/ 裡任何地方出現就紅（含註解與測試——名字留著就有人照抄）。
 * `G-109` 第二步之後 `useWorkspace` 已經不提供這幾顆，沒有例外清單。
 */
const ROLE_LEVEL_HELPERS = /\b(canOperate|canManageSettings|canWrite|hasMinRole)\b/

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full))
    else if ((name.endsWith('.vue') || name.endsWith('.ts')) && name !== 'capability-usage.test.ts') out.push(full)
  }
  return out
}

const files = listSourceFiles(join(ROOT, 'app'))
  .map(full => ({ rel: relative(ROOT, full), src: readFileSync(full, 'utf8') }))

describe('前端按鈕顯隱讀權限表（G-109）', () => {
  it('掃得到檔案（⛔ 路徑寫錯的話下面會空跑成綠燈）', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('app/ 裡沒有任何一處用大開關', () => {
    const offenders = files
      .filter(f => ROLE_LEVEL_HELPERS.test(f.src))
      .map(f => f.rel)
    expect(offenders, '改成 can(\'<那顆按鈕打的端點用的能力>\')').toEqual([])
  })

  it('對照組：網子抓得到（⛔ 正規表示式寫壞的話上面那關會空跑成綠燈）', () => {
    expect(ROLE_LEVEL_HELPERS.test('const { canOperate } = useWorkspace()')).toBe(true)
    expect(ROLE_LEVEL_HELPERS.test('if (hasMinRole(role, \'admin\'))')).toBe(true)
    expect(ROLE_LEVEL_HELPERS.test('can(\'conversations.reply\')')).toBe(false)
  })
})
