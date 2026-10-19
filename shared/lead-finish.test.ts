import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildLineAppDeepLink,
  decideLeadFinish,
  hasOutsideMarker,
  leadDoneHint,
  leadOpenedOutsideLine,
} from './lead-finish'
import { autoReplyActionSendsMessage } from './auto-reply-content'

/**
 * 活動連結綁定完成後怎麼收尾（`D-46`，2026-10-20 老闆照建議學 Omnichat）：
 * 從 LINE 外面進來的停在「綁定完成」頁、靠通知回聊天室；從 LINE 裡面開的照舊開聊天室。
 */
const LEAD = 'https://lineminime.com/liff/lead?liffId=2000009466-abc&ct=tok&c=camp'
const inLine = { isInClient: true, isLineUserAgent: true }

describe('從外面跳進 LINE App 時掛記號', () => {
  it('深連結照搬參數、再掛 from=web', () => {
    const d = new URL(buildLineAppDeepLink(LEAD, '2000009466-abc'))
    expect(d.protocol).toBe('line:')
    expect(d.searchParams.get('ct')).toBe('tok')
    expect(d.searchParams.get('c')).toBe('camp')
    expect(d.searchParams.get('from')).toBe('web')
  })

  it('記號在網址上、或被 LIFF 包在 liff.state 裡都認得', () => {
    expect(hasOutsideMarker(`${LEAD}&from=web`)).toBe(true)
    const wrapped = `https://lineminime.com/liff/lead?liff.state=${encodeURIComponent('?ct=tok&from=web')}`
    expect(hasOutsideMarker(wrapped)).toBe(true)
    expect(hasOutsideMarker(LEAD)).toBe(false)
    expect(hasOutsideMarker('not a url')).toBe(false)
  })
})

describe('這一趟是不是從 LINE 外面進來的', () => {
  it('LINE 聊天室裡開的（utou）＝裡面', () => {
    expect(leadOpenedOutsideLine({ href: LEAD, contextType: 'utou', ...inLine })).toBe(false)
    expect(leadOpenedOutsideLine({ href: LEAD, contextType: 'group', ...inLine })).toBe(false)
  })

  it('帶著記號（外部瀏覽器跳進來的）＝外面，就算現在人在 LIFF 裡', () => {
    expect(leadOpenedOutsideLine({ href: `${LEAD}&from=web`, contextType: 'utou', ...inLine })).toBe(true)
  })

  it('LIFF 裡、但 LIFF 說不是從聊天室開的（none）＝外面', () => {
    expect(leadOpenedOutsideLine({ href: LEAD, contextType: 'none', ...inLine })).toBe(true)
  })

  it('不在 LIFF、也不是 LINE 內建瀏覽器（Safari／Chrome）＝外面；LINE 內建瀏覽器（context 是 external）＝裡面', () => {
    expect(leadOpenedOutsideLine({ href: LEAD, contextType: 'external', isInClient: false, isLineUserAgent: false })).toBe(true)
    expect(leadOpenedOutsideLine({ href: LEAD, contextType: 'external', isInClient: false, isLineUserAgent: true })).toBe(false)
  })
})

describe('收尾怎麼走', () => {
  it('⛔ 外面進來的：停在完成頁（以前會主動開聊天室再關窗）', () => {
    expect(decideLeadFinish({ href: `${LEAD}&from=web`, contextType: 'utou', ...inLine })).toBe('stay')
    expect(decideLeadFinish({ href: LEAD, contextType: 'none', ...inLine })).toBe('stay')
    expect(decideLeadFinish({ href: LEAD, isInClient: false, isLineUserAgent: false })).toBe('stay')
  })

  it('LINE 裡面開的：照舊（LIFF 裡開聊天室再關窗；LINE 內建瀏覽器用網址跳）', () => {
    expect(decideLeadFinish({ href: LEAD, contextType: 'utou', ...inLine })).toBe('open-chat-and-close')
    expect(decideLeadFinish({ href: LEAD, contextType: null, ...inLine })).toBe('open-chat-and-close')
    expect(decideLeadFinish({ href: LEAD, isInClient: false, isLineUserAgent: true })).toBe('go-chat-by-location')
    expect(decideLeadFinish({ href: LEAD, contextType: 'external', isInClient: false, isLineUserAgent: true })).toBe('go-chat-by-location')
  })

  it('店家設了「完成後前往」：不管從哪裡來都照舊去那裡', () => {
    expect(decideLeadFinish({ href: `${LEAD}&from=web`, redirectUrl: 'https://shop.example/coupon', ...inLine })).toBe('redirect')
    expect(decideLeadFinish({ href: LEAD, contextType: 'utou', redirectUrl: 'https://shop.example/coupon', ...inLine })).toBe('redirect')
    expect(decideLeadFinish({ href: LEAD, contextType: 'utou', redirectUrl: '  ', ...inLine })).toBe('open-chat-and-close')
  })
})

describe('完成頁那一句（客人看的）', () => {
  it('⛔ 不寫「貼標」；活動沒設訊息就不承諾訊息', () => {
    const all = [
      leadDoneHint({ needAddFriend: false, sendsMessage: true }),
      leadDoneHint({ needAddFriend: false, sendsMessage: false }),
      leadDoneHint({ needAddFriend: true, sendsMessage: true }),
      leadDoneHint({ needAddFriend: true, sendsMessage: false }),
    ]
    for (const t of all) expect(t).not.toContain('貼標')
    expect(all[0]).toBe('活動訊息會傳到你的 LINE，收到通知時點開就能看到。')
    expect(all[1]).not.toContain('訊息')
    expect(all[2]).toContain('加入官方帳號為好友')
    expect(all[3]).not.toContain('訊息')
  })

  it('舊版後端沒回 sendsMessage：照「會傳」講（以前那一句就是這樣講）', () => {
    expect(leadDoneHint({ needAddFriend: false, sendsMessage: null })).toBe(leadDoneHint({ needAddFriend: false, sendsMessage: true }))
  })
})

describe('活動綁定完會不會傳訊息（跟送出端同一條）', () => {
  it('模組型看有沒有指定模組；文字／網址看組不組得出訊息；none 不傳', () => {
    expect(autoReplyActionSendsMessage({ type: 'module', moduleId: 'm1', text: '', uri: '' })).toBe(true)
    expect(autoReplyActionSendsMessage({ type: 'module', moduleId: '', text: '', uri: '' })).toBe(false)
    expect(autoReplyActionSendsMessage({ type: 'message', moduleId: '', text: '歡迎！', uri: '' })).toBe(true)
    expect(autoReplyActionSendsMessage({ type: 'message', moduleId: '', text: '   ', uri: '' })).toBe(false)
    expect(autoReplyActionSendsMessage({ type: 'uri', moduleId: '', text: '', uri: 'https://x.example' })).toBe(true)
    expect(autoReplyActionSendsMessage({ type: 'none' as never, moduleId: '', text: '', uri: '' })).toBe(false)
  })
})

describe('活動頁（lead.vue）照這支收尾', () => {
  const page = readFileSync(fileURLToPath(new URL('../app/pages/liff/lead.vue', import.meta.url)), 'utf8')
  const claim = readFileSync(fileURLToPath(new URL('../server/api/liff/claim.post.ts', import.meta.url)), 'utf8')

  it('跳 LINE App 的深連結走掛記號那一支；收尾走 decideLeadFinish', () => {
    expect(page).toContain('return buildLineAppDeepLink(window.location.href, liffId)')
    expect(page).toContain('const finish = decideLeadFinish({')
    // ⛔ 舊的「LIFF 裡一律開聊天室」不可以留在判斷之外
    expect(page).not.toMatch(/if \(liff\.isInClient\(\)\) \{\s*finishInLineClientWithoutCampaignRedirect/)
    expect(page).not.toContain('系統會自動完成活動貼標')
  })

  it('claim 回 sendsMessage（照 action／moduleId 推，跟送出端同一條）', () => {
    expect(claim).toContain('autoReplyActionSendsMessage(normalizeAutoReplyAction(claim.action, String(claim.moduleId ?? \'\')))')
    expect(claim).toMatch(/redirectUrl,\s*sendsMessage,/)
  })
})
