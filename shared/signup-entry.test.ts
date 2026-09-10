import { describe, expect, it } from 'vitest'
import {
  SIGNUP_ENTRY_PATH,
  isSignupStartIntent,
  resolveLoginRedirect,
} from './signup-entry'

// 這條路上的每個判斷都只在「第一次註冊」跑一次，而且錯了不會噴錯、只會把人送錯地方
// （最壞的一種：把已經有帳號的人推進「建立新帳號」的劇本）。人工很難重現，用測試釘住。
describe('signup-entry', () => {
  it('入口網址是由參數常數組出來的（門面八顆按鈕都連這一個）', () => {
    expect(SIGNUP_ENTRY_PATH).toBe('/login?intent=start')
  })

  describe('isSignupStartIntent', () => {
    it('認得 start，前後空白剝掉', () => {
      expect(isSignupStartIntent('start')).toBe(true)
      expect(isSignupStartIntent(' start ')).toBe(true)
    })

    it('沒帶、帶空的、帶別的值都當成沒帶（回中性文案，不丟例外）', () => {
      expect(isSignupStartIntent(undefined)).toBe(false)
      expect(isSignupStartIntent(null)).toBe(false)
      expect(isSignupStartIntent('')).toBe(false)
      expect(isSignupStartIntent('Start')).toBe(false)
      expect(isSignupStartIntent('startx')).toBe(false)
      expect(isSignupStartIntent(1)).toBe(false)
    })

    it('query 值是陣列時（?intent=a&intent=start）只要有一個是 start 就算', () => {
      expect(isSignupStartIntent(['start'])).toBe(true)
      expect(isSignupStartIntent(['other', 'start'])).toBe(true)
      expect(isSignupStartIntent(['other'])).toBe(false)
      expect(isSignupStartIntent([])).toBe(false)
    })
  })

  describe('resolveLoginRedirect', () => {
    it('沒帶任何東西＝原本的帳號選擇頁（裸 /login 的舊行為不變）', () => {
      expect(resolveLoginRedirect({})).toBe('/admin/workspaces')
    })

    // ⚠️ 2026-09-10 `D-77`：這條的期待值被**刻意反轉**——原本是
    //    「帶 intent=start 就把意圖帶去帳號選擇頁」（給已移除的「註冊快車道」用）。
    //    現在那一頁沒有任何東西讀它，所以不再帶過去。⛔ 這不是壞掉的測試，是拍板改了。
    it('帶 intent=start 也只去帳號選擇頁（`D-77` 推翻快車道後，那一頁不再讀這個參數）', () => {
      expect(resolveLoginRedirect({ intent: 'start' })).toBe('/admin/workspaces')
    })

    it('redirect 優先於 intent：被 middleware 擋下來的人有明確目的地，不可被註冊意圖劫走', () => {
      expect(resolveLoginRedirect({ redirect: '/admin/e8dda/conversations', intent: 'start' }))
        .toBe('/admin/e8dda/conversations')
    })

    it('redirect 只認 /admin 開頭，站外網址攔掉（沿用原本的判斷）', () => {
      expect(resolveLoginRedirect({ redirect: '//evil.com' })).toBe('/admin/workspaces')
      expect(resolveLoginRedirect({ redirect: 'https://evil.com/admin' })).toBe('/admin/workspaces')
      expect(resolveLoginRedirect({ redirect: '/liff/lead' })).toBe('/admin/workspaces')
    })

    it('站外 redirect 被攔掉、有沒有 intent 都落在帳號選擇頁', () => {
      expect(resolveLoginRedirect({ redirect: '//evil.com', intent: 'start' }))
        .toBe('/admin/workspaces')
    })
  })

  // ⛔ `shouldFastLaneToOnboarding` 那一組測試（5 條）2026-09-10 `D-77` 連同函式一起移除：
  //    使用者看實際行為後推翻 `D-74` A 案的「零帳號直接進開通引導」，改成
  //    「第一次登入先看到迎賓三選一，按下開始使用才進引導」。
  //    ⛔ 不要因為「測試少了幾條」就把函式與測試復活——理由寫在 signup-entry.ts 檔尾。
})
