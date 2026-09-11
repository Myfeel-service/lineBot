import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import zhTw from 'element-plus/es/locale/lang/zh-tw'

/**
 * 導覽（el-tour）的「上一步／下一步／結束導覽」是 Element Plus 自己出的字，
 * 由 el-config-provider 的 locale 決定。zh-cn 那份是簡體（finish = 结束导览），
 * 掛上去畫面就會冒出簡體字，而且我們自己的 grep 掃不到——字串不在 repo 裡。
 * 這支測試盯兩件事：元件掛的是 zh-tw、而 zh-tw 那份的確是繁體。
 */

const TUTORIAL_AGENT = fileURLToPath(new URL('../components/TutorialAgent.vue', import.meta.url))

describe('導覽 locale', () => {
  it('TutorialAgent 掛的是 zh-tw，不是簡體的 zh-cn', () => {
    const source = readFileSync(TUTORIAL_AGENT, 'utf8')
    expect(source).toContain('element-plus/es/locale/lang/zh-tw')
    expect(source).not.toContain('element-plus/es/locale/lang/zh-cn')
  })

  it('zh-tw 的導覽按鈕是繁體', () => {
    expect(zhTw.el.tour).toMatchObject({
      next: '下一步',
      previous: '上一步',
      finish: '結束導覽',
      close: '關閉此對話框',
    })
  })
})
