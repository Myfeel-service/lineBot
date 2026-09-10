import { describe, expect, it } from 'vitest'
import {
  SIGNUP_ENTRY_PATH,
  isSignupStartIntent,
  resolveLoginRedirect,
  shouldFastLaneToOnboarding,
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

    it('帶 intent=start＝把意圖帶去帳號選擇頁', () => {
      expect(resolveLoginRedirect({ intent: 'start' })).toBe('/admin/workspaces?intent=start')
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

    it('redirect 被攔掉但有 intent 時，仍走註冊那條（不要讓他掉回中性落點）', () => {
      expect(resolveLoginRedirect({ redirect: '//evil.com', intent: 'start' }))
        .toBe('/admin/workspaces?intent=start')
    })
  })

  describe('shouldFastLaneToOnboarding', () => {
    const base = { intentIsStart: true, listLoaded: true, groupCount: 0, isSuperAdmin: false }

    it('來註冊、清單查到了、零帳號、不是超管＝直接進開通引導', () => {
      expect(shouldFastLaneToOnboarding(base)).toBe(true)
    })

    it('裸 /login 進來的人維持迎賓頁三選一', () => {
      expect(shouldFastLaneToOnboarding({ ...base, intentIsStart: false })).toBe(false)
    })

    it('⛔ 清單沒查到（斷網／token 過期）時不送——那時的「零帳號」是假的', () => {
      expect(shouldFastLaneToOnboarding({ ...base, listLoaded: false })).toBe(false)
    })

    it('已經有帳號（或有 org 但底下零帳號）的人照舊看帳號選擇頁', () => {
      expect(shouldFastLaneToOnboarding({ ...base, groupCount: 1 })).toBe(false)
    })

    it('超管不送：他的空狀態畫面上有「超級管理員後台」入口，送走就看不到', () => {
      expect(shouldFastLaneToOnboarding({ ...base, isSuperAdmin: true })).toBe(false)
    })
  })
})
