/**
 * webhook 收到「加好友」時要清 LINE 通知的退件紀錄（`C-271`②，2026-09-27）。
 *
 * 為什麼要這條守門：清紀錄的函式本身有單元測試（`line-notify-delivery.test.ts`），但**呼叫它的那一行**
 * 在 webhook 路由裡，沒有任何測試碰得到——哪天整理 follow 那一段時被刪掉，還沒加好友就綁定的人
 * 加了好友之後，那一列會永遠黃著寫「封鎖」，小幫手也永遠亮著，而且畫面上零線索。
 * 字串比對擋不了「呼叫了但參數寫錯」，那一層歸 `syncNotifyRecipientFollowState` 自己的測試。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const route = readFileSync(fileURLToPath(new URL('../routes/webhook.post.ts', import.meta.url)), 'utf8')
/** 剝掉註解：守門不可以被旁邊引用那一行的註解騙過（`C-259` 踩過） */
const code = route.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

describe('webhook 的加好友／封鎖要同步 LINE 通知的送達紀錄', () => {
  it('follow 那一段呼叫 syncNotifyRecipientFollowState(…, false)', () => {
    const follow = code.slice(code.indexOf("e.type === 'follow'"), code.indexOf("e.type === 'unfollow'"))
    expect(follow.length).toBeGreaterThan(0)
    expect(follow).toMatch(/syncNotifyRecipientFollowState\([^)]*,\s*false\)/)
  })
})
