import { describe, expect, it } from 'vitest'
import { classifyDriveShareError, classifyGoogleAuthError, createSheetFailureMessage, googleSheetUrl } from './google-drive-share'
import { GSHEET_PATTERN } from './knowledge-import-detect'

/**
 * 錯誤的形狀照 Drive v3 錯誤參考頁（developers.google.com/drive/api/guides/handle-errors）。
 * 分類錯了畫面就會叫人做錯的事：例如公司擋了對外共用，卻叫他「照三步手動共用」——那也會被擋。
 */
const err = (code: number, reason: string, message: string) => ({ error: { code, message, errors: [{ reason, message }] } })

describe('classifyDriveShareError', () => {
  it('只是編輯者、擁有者關了共用 → 請擁有者來挑', () => {
    const r = classifyDriveShareError(403, err(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.'))
    expect(r.kind).toBe('cannot_share')
    expect(r.message).toContain('擁有者')
  })

  it('⛔ 公司擋對外共用 → 不叫他手動共用（手動也會被擋），給 Excel 那條路', () => {
    const r = classifyDriveShareError(403, err(403, 'shareOutNotPermitted', 'The user does not have permission to share this item outside of the domain.'))
    expect(r.kind).toBe('domain_blocked')
    expect(r.message).toContain('Excel')
    expect(r.message).not.toContain('照下面三步')
  })

  it('沒有代碼、只有 400＋網域字樣 → 也算公司擋', () => {
    expect(classifyDriveShareError(400, err(400, 'invalidSharingRequest', 'Sharing is not allowed by your organization\'s domain policy.')).kind).toBe('domain_blocked')
  })

  it('授權過期 → 呼叫端自己重拿，不用讓店家知道', () => {
    expect(classifyDriveShareError(401, err(401, 'authError', 'Invalid Credentials')).kind).toBe('expired')
  })

  it('太頻繁、伺服器錯、斷線 → 再挑一次', () => {
    expect(classifyDriveShareError(429, err(429, 'userRateLimitExceeded', 'User rate limit exceeded')).kind).toBe('temporary')
    expect(classifyDriveShareError(503, err(503, 'backendError', 'Backend Error')).kind).toBe('temporary')
    expect(classifyDriveShareError(0, null).kind).toBe('temporary')
  })

  it('猜不出來 → 照實說、附原文', () => {
    const r = classifyDriveShareError(404, err(404, 'notFound', 'File not found: abc.'))
    expect(r.kind).toBe('unknown')
    expect(r.detail).toBe('File not found: abc.')
  })
})

describe('createSheetFailureMessage', () => {
  it('⛔ 開新表被擋（403 沒有代碼）不可以講成「只有擁有者能共用」——新表沒有擁有者的問題（2026-10-29 /code-review）', () => {
    const f = classifyDriveShareError(403, { error: { code: 403, message: 'The caller does not have permission' } })
    expect(f.kind).toBe('cannot_share') // 共用那邊的分類照舊
    const m = createSheetFailureMessage(f)
    expect(m).toContain('沒讓我們開新表')
    expect(m).not.toContain('擁有者')
  })
  it('暫時出狀況、授權過期 → 叫他再按一次「幫我開一份新的」，不是「再挑一次」', () => {
    for (const code of [429, 401]) {
      const m = createSheetFailureMessage(classifyDriveShareError(code, null))
      expect(m).toContain('再按一次「幫我開一份新的」')
      expect(m).not.toContain('挑')
    }
  })
  it('猜不出來 → 附 Google 原文', () => {
    expect(createSheetFailureMessage(classifyDriveShareError(400, err(400, 'badRequest', 'Invalid value')))).toContain('Invalid value')
  })
})

describe('classifyGoogleAuthError', () => {
  it('他自己關掉視窗 → 安靜，不跳紅字', () => {
    expect(classifyGoogleAuthError('popup_closed')).toBeNull()
  })
  it('其他都要講一句、而且給手動那條路或再按一次', () => {
    for (const t of ['popup_failed_to_open', 'access_denied', 'admin_policy_enforced', 'whatever']) {
      expect(classifyGoogleAuthError(t)).toMatch(/再按一次|照下面三步/)
    }
  })
})

describe('googleSheetUrl', () => {
  it('組出來的網址後面判別、讀表都認得', () => {
    const url = googleSheetUrl('1AbC_dEf-123')
    expect(url).toBe('https://docs.google.com/spreadsheets/d/1AbC_dEf-123/edit')
    expect(GSHEET_PATTERN.test(url)).toBe(true)
  })
})
