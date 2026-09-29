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

/** 大開關的名字（出現在這些檔以外就紅） */
const ROLE_LEVEL_HELPERS = /\b(canOperate|canManageSettings|canWrite|hasMinRole)\b/

/** 定義它們的地方（還留著給下面那批沒換完的檔用） */
const DEFINITIONS = new Set([
  'app/composables/useWorkspace.ts',
])

/**
 * 還沒換的（`G-109` 第二步）：導覽、小幫手面板、就緒度與提醒條這一串互相依賴，
 * 而另一個工作階段（`D-109`）正在改其中幾支，等它 commit 完一起換。⛔ 只能刪、不能加。
 */
const PENDING_SECOND_STEP = new Set([
  'app/components/TutorialAgent.vue',
  'app/composables/useTutorial.ts',
  'app/components/admin/AdminPageHelpButton.vue',
  'app/utils/tutorial-step-visibility.ts',
  'app/utils/tutorial-step-visibility.test.ts',
  'app/utils/tutorial-topics.ts',
  'app/utils/tutorial-topics.test.ts',
  'app/composables/useSetupStatus.ts',
  'app/composables/useSetupStatus.test.ts',
  'app/composables/useWorkspaceAlerts.ts',
  'app/composables/useWorkspaceAlerts.test.ts',
])

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

  it('大開關只剩定義處與還沒換的那批', () => {
    const offenders = files
      .filter(f => ROLE_LEVEL_HELPERS.test(f.src))
      .map(f => f.rel)
      .filter(rel => !DEFINITIONS.has(rel) && !PENDING_SECOND_STEP.has(rel))
    expect(offenders, '改成 can(\'<那顆按鈕打的端點用的能力>\')').toEqual([])
  })

  it('還沒換的清單不留死項：已經換完的要從清單拿掉（清單只能變短）', () => {
    const stillUsing = new Set(files.filter(f => ROLE_LEVEL_HELPERS.test(f.src)).map(f => f.rel))
    expect([...PENDING_SECOND_STEP].filter(rel => !stillUsing.has(rel))).toEqual([])
  })
})
