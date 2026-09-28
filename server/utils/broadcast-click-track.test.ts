import { describe, expect, it } from 'vitest'
import {
  broadcastEverHandedToSender,
  clickTargetInBroadcast,
  collectClickTrackableUris,
  collectHttpsStringsDeep,
  wrapBroadcastMessagesForClickTracking,
} from './broadcast-click-track'

/**
 * 推播點擊追蹤（`G-95`）。token 沒有簽章，`/api/r` 改成「拿推播本身比對目標網址」。
 *
 * 最要緊的一條：**包裝時放進 token 的每一個網址，驗證時都要認得**。兩邊一漂開，
 * 已經躺在客人 LINE 裡的舊連結就會被當成偽造、點了回首頁——那是收不回來的。
 */

const ORIGIN = 'https://app.example.com'

/** 把包好的訊息裡每一個 /api/r/ 連結解回 token 裡的目標網址（照 `/api/r/:token` 的解法） */
function targetsInWrapped(wrapped: unknown): string[] {
  const out: string[] = []
  JSON.stringify(wrapped, (_k, v) => {
    if (typeof v === 'string' && v.startsWith(`${ORIGIN}/api/r/`)) {
      const parts = Buffer.from(v.slice(`${ORIGIN}/api/r/`.length), 'base64url').toString('utf-8').split('|')
      out.push(parts.slice(4).join('|'))
    }
    return v
  })
  return out
}

const EVERY_KIND: unknown[] = [
  { type: 'template', altText: 'x', template: { type: 'buttons', text: 't', actions: [
    { type: 'uri', label: 'a', uri: ' https://shop.example.com/a?x=1|2 ' },
    { type: 'postback', label: 'b', data: 'x' },
  ] } },
  { type: 'template', altText: 'x', template: { type: 'confirm', text: 't', actions: [{ type: 'uri', label: 'y', uri: 'https://confirm.example.com' }, { type: 'message', label: 'n', text: 'n' }] } },
  { type: 'template', altText: 'x', template: { type: 'carousel', columns: [
    { text: '1', actions: [{ type: 'uri', label: 'a', uri: 'https://car1.example.com' }] },
    { text: '2', actions: [{ type: 'uri', label: 'b', uri: 'https://car2.example.com' }] },
  ] } },
  { type: 'template', altText: 'x', template: { type: 'image_carousel', columns: [
    { imageUrl: 'https://img.example.com/1.png', action: { type: 'uri', uri: 'https://imgcar.example.com' } },
  ] } },
  { type: 'flex', altText: 'x', contents: { type: 'carousel', contents: [
    { type: 'bubble', hero: { type: 'image', url: 'https://img.example.com/h.png', action: { type: 'uri', uri: 'https://hero.example.com' } },
      footer: { type: 'box', contents: [{ type: 'button', action: { type: 'uri', uri: 'https://footer.example.com' } }] } },
  ] } },
]

describe('包裝與驗證走同一條', () => {
  it('⭐ 每一種版型：包進 token 的目標網址，驗證端全部認得', () => {
    const wrapped = wrapBroadcastMessagesForClickTracking(EVERY_KIND, 'camp1', ORIGIN)
    const targets = targetsInWrapped(wrapped)
    expect(targets).toHaveLength(7)
    const allowed = collectClickTrackableUris(EVERY_KIND)
    for (const t of targets) expect(allowed.has(t), t).toBe(true)
    // token 裡放的是去掉頭尾空白的版本
    expect(allowed.has('https://shop.example.com/a?x=1|2')).toBe(true)
  })

  it('沒被包的不收：http、純文字裡的網址、圖片網址', () => {
    const allowed = collectClickTrackableUris([
      { type: 'template', altText: 'x', template: { type: 'buttons', text: 't', actions: [{ type: 'uri', label: 'a', uri: 'http://insecure.example.com' }] } },
      { type: 'text', text: 'https://in-text.example.com' },
      ...EVERY_KIND.slice(3, 4),
    ])
    expect(allowed.has('http://insecure.example.com')).toBe(false)
    expect(allowed.has('https://in-text.example.com')).toBe(false)
    expect(allowed.has('https://img.example.com/1.png')).toBe(false)
    expect(allowed.has('https://imgcar.example.com')).toBe(true)
  })

  it('怪資料不會炸', () => {
    expect(collectClickTrackableUris(null).size).toBe(0)
    expect(collectClickTrackableUris([null, 1, { type: 'template' }, { type: 'flex', contents: { type: 'carousel', contents: [null] } }]).size).toBe(0)
  })
})

describe('clickTargetInBroadcast', () => {
  it('非模組型：網址在 messages 裡 → 認；不在 → 不認', () => {
    const doc = { messages: EVERY_KIND }
    expect(clickTargetInBroadcast('https://hero.example.com', doc)).toBe(true)
    expect(clickTargetInBroadcast('https://evil.example.com/login', doc)).toBe(false)
    // ⛔ 同網域不同路徑也不認（不是「同網域就放行」）
    expect(clickTargetInBroadcast('https://shop.example.com/phish', doc)).toBe(false)
  })

  it('模組型（`C-246` 之後）：看 sentContent 的編輯器格式，按鈕網址放在哪一格都撿得到', () => {
    const doc = {
      messages: [{ type: 'template', altText: 'x', template: { type: 'buttons', text: 't', actions: [{ type: 'postback', label: '開始', data: 'x' }] } }],
      sentContent: { kind: 'module', messages: [{ type: 'text', text: 'hi', buttons: [{ type: 'uri', label: '看看', uri: 'https://module.example.com/p?id=1' }] }] },
    }
    expect(clickTargetInBroadcast('https://module.example.com/p?id=1', doc)).toBe(true)
    expect(clickTargetInBroadcast('https://evil.example.com', doc)).toBe(false)
  })
})

describe('collectHttpsStringsDeep', () => {
  it('帶 {{變數}} 的網址：推播時變數會被換成空字串，兩個版本都收', () => {
    const got = collectHttpsStringsDeep({ a: [{ uri: 'https://x.example.com/?n={{ displayName }}' }] })
    expect(got.has('https://x.example.com/?n={{ displayName }}')).toBe(true)
    expect(got.has('https://x.example.com/?n=')).toBe(true)
  })

  it('有深度與數量上限（公開端點每點一次都跑，不能被怪資料拖住）', () => {
    let deep: unknown = 'https://too-deep.example.com'
    for (let i = 0; i < 30; i++) deep = [deep]
    expect(collectHttpsStringsDeep(deep).size).toBe(0)
    const many = Array.from({ length: 2000 }, (_, i) => `https://m${i}.example.com`)
    expect(collectHttpsStringsDeep(many).size).toBe(500)
  })
})

describe('broadcastEverHandedToSender', () => {
  it('送出過的才算；從沒送過的草稿不算（⛔ 不然建一則草稿就能組出轉址連結）', () => {
    expect(broadcastEverHandedToSender({ status: 'completed' })).toBe(true)
    expect(broadcastEverHandedToSender({ status: 'processing' })).toBe(true)
    // 看門狗收殮的 failed 可能其實送出去了
    expect(broadcastEverHandedToSender({ status: 'failed' })).toBe(true)
    expect(broadcastEverHandedToSender({ status: 'draft' })).toBe(false)
    expect(broadcastEverHandedToSender({ status: 'scheduled' })).toBe(false)
    expect(broadcastEverHandedToSender({ status: 'cancelled' })).toBe(false)
    // 失敗後重設回草稿：那一輪可能送出去過
    expect(broadcastEverHandedToSender({ status: 'draft', retryCount: 1 })).toBe(true)
  })
})
