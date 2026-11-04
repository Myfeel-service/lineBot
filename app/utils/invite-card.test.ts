/**
 * 加好友邀請卡（`C-458`／`D-169`）。canvas 用假的 context 收「畫了什麼」，真的畫出來長怎樣另外用瀏覽器看過。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  drawInviteCard,
  drawQr,
  fitFontSize,
  INVITE_CARD_SIZE,
  INVITE_COPY,
  initialOf,
  inviteFileName,
  qrMatrixFrom,
  truncateToWidth,
  type QrMatrix,
} from './invite-card'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const dialog = readFileSync(`${APP_DIR}components/admin/AdminInviteCardDialog.vue`, 'utf8')

/** 只記錄呼叫的假 canvas：每個中文字寬＝字級、英數半個字級 */
function fakeCtx() {
  const texts: string[] = []
  const rects: Array<[number, number, number, number]> = []
  let font = '16px x'
  const px = () => Number(/(\d+)px/.exec(font)?.[1] ?? 16)
  const ctx = {
    set font(v: string) { font = v },
    get font() { return font },
    fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '',
    measureText: (s: string) => ({ width: [...s].reduce((w, ch) => w + (/[ -~]/.test(ch) ? px() / 2 : px()), 0) }),
    fillText: (s: string) => { texts.push(s) },
    fillRect: (x: number, y: number, w: number, h: number) => { rects.push([x, y, w, h]) },
    save() {}, restore() {}, beginPath() {}, closePath() {}, arc() {}, clip() {}, stroke() {}, fill() {},
    moveTo() {}, arcTo() {}, drawImage() {},
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, rects }
}

const QR21: QrMatrix = { size: 21, isDark: (r, c) => (r + c) % 3 === 0 }

describe('排字', () => {
  it('fitFontSize：放得下就用原字級，太寬往下縮、縮到最小為止', () => {
    expect(fitFontSize(p => p * 5, 1000, 76, 44)).toBe(76)
    expect(fitFontSize(p => p * 20, 1000, 76, 44)).toBe(50)
    expect(fitFontSize(p => p * 100, 1000, 76, 44)).toBe(44)
  })
  it('truncateToWidth：放得下原樣、放不下截斷加「…」', () => {
    const m = (s: string) => [...s].length * 10
    expect(truncateToWidth('阿明早午餐', m, 100)).toBe('阿明早午餐')
    expect(truncateToWidth('阿明早午餐信義旗艦店', m, 60)).toBe('阿明早午餐…')
  })
  it('initialOf：取第一個字（英文大寫）、空的給問號', () => {
    expect(initialOf('阿明早午餐')).toBe('阿')
    expect(initialOf(' minime')).toBe('M')
    expect(initialOf('')).toBe('?')
  })
  it('inviteFileName：店名＋哪一張，檔名不能用的字拿掉', () => {
    expect(inviteFileName('a4', '阿明 早午餐')).toBe('阿明早午餐-邀請卡-A4桌牌.png')
    expect(inviteFileName('share', 'A/B:C')).toBe('ABC-邀請卡-分享圖.png')
    expect(inviteFileName('a4', '')).toBe('LINE-邀請卡-A4桌牌.png')
  })
})

describe('QR', () => {
  it('qrMatrixFrom 照套件的 modules 轉', () => {
    const m = qrMatrixFrom({ modules: { size: 2, get: (r, c) => (r === c ? 1 : 0) } })
    expect(m.size).toBe(2)
    expect(m.isDark(0, 0)).toBe(true)
    expect(m.isDark(0, 1)).toBe(false)
  })
  it('模組是整數像素、四周留 2 格白邊、置中在框裡', () => {
    const { ctx, rects } = fakeCtx()
    const side = drawQr(ctx, QR21, 0, 0, 760)
    const cell = Math.floor(760 / 25)
    expect(side).toBe(cell * 25)
    const [bg, ...mods] = rects
    expect(bg).toEqual([Math.round((760 - side) / 2), Math.round((760 - side) / 2), side, side])
    expect(mods.every(([, , w, h]) => w === cell && h === cell && Number.isInteger(w))).toBe(true)
    // 第一格黑的在 (0,0)：從白邊後面開始畫
    expect(mods[0]![0]).toBe(bg![0] + 2 * cell)
  })
})

describe('整張', () => {
  for (const kind of ['a4', 'share'] as const) {
    it(`${kind}：店名、QR、標題、副標、搜尋帳號都畫上去，畫在畫布裡面`, () => {
      const { ctx, texts, rects } = fakeCtx()
      drawInviteCard(ctx, kind, { name: '阿明早午餐', basicId: '@abc1234', avatar: null }, QR21)
      expect(texts).toContain('阿明早午餐')
      expect(texts).toContain(kind === 'a4' ? INVITE_COPY.a4Headline : INVITE_COPY.shareHeadline)
      expect(texts).toContain(INVITE_COPY.sub)
      expect(texts).toContain('或在 LINE 搜尋 @abc1234')
      // 沒有頭像＝畫名字第一個字
      expect(texts).toContain('阿')
      const { w, h } = INVITE_CARD_SIZE[kind]
      expect(rects.every(([x, y, rw, rh]) => x >= 0 && y >= 0 && x + rw <= w && y + rh <= h)).toBe(true)
    })
  }
  it('名稱很長也不會超出寬度（縮字再截斷）', () => {
    const { ctx, texts } = fakeCtx()
    drawInviteCard(ctx, 'share', { name: '阿明早午餐信義旗艦店外帶外送專線', basicId: '@abc', avatar: null }, QR21)
    const name = texts.find(t => t.startsWith('阿明早午餐'))!
    ctx.font = '700 38px x'
    expect(ctx.measureText(name).width).toBeLessThanOrEqual(860)
  })
  it('有頭像就畫頭像、不畫第一個字', () => {
    const { ctx, texts } = fakeCtx()
    drawInviteCard(ctx, 'a4', { name: '阿明早午餐', basicId: '@abc', avatar: {} as CanvasImageSource }, QR21)
    expect(texts).not.toContain('阿')
  })
})

describe('⛔ 規矩', () => {
  it('卡上的字不承諾 AI 會馬上回（新帳號 AI 回覆預設是關的）', () => {
    const all = Object.values(INVITE_COPY).map(v => (typeof v === 'function' ? v('@x') : v)).join('\n')
    expect(all).not.toMatch(/AI|馬上|立即|秒回|24 ?小時/)
  })
  it('QR 直接指 LINE 官方加好友連結（⛔ 不經過我們的網址：印出去的收不回來）', () => {
    expect(dialog).toContain('create(r.addFriendUrl')
    expect(dialog).not.toMatch(/\/api\/r\/|\/api\/t\//)
  })
  it('code review 第 15 條：上次沒畫成（還沒接 LINE、畫失敗）＝再打開就重抓，⛔ 不要整頁重新整理才有', () => {
    expect(dialog).toContain('madeFor === wid && invite.value?.basicId && urls.a4 && urls.share')
  })

  it('第一版不做 Email 邀請', () => {
    expect(dialog).not.toMatch(/sendMail|\/api\/.*email/i)
  })
  it('頭像要帶 avatar=1 拿 data URL（跨網域的圖畫進 canvas 會存不出來）', () => {
    expect(dialog).toContain("query: { avatar: '1' }")
    expect(dialog).toContain('pictureDataUrl')
    expect(dialog).not.toMatch(/loadImage\(r\.pictureUrl/)
  })
})
