/**
 * LINE 通知裡的短網址（`C-270`⑦）。
 * ⚠️ 這條要守的是「在 LINE 裡點得開」：後台是 Google 彈窗登入，LINE 內建瀏覽器登不進去，
 *    所以轉址端看到 LINE 內建瀏覽器要先轉回自己、加上 `openExternalBrowser=1`，讓 LINE 改用手機瀏覽器開。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNotifyLink, isLineInAppBrowser, isValidNotifyLinkCode, NOTIFY_LINK_TTL_MS, notifyLinksEnabled, resolveNotifyRedirect } from './notify-links'

vi.mock('./firebase', () => ({ getDb: vi.fn() }))

describe('連結開關（2026-09-27 預設關：後台還沒有手機版）', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const fakeDb = () => {
    const created: any[] = []
    return { created, db: { collection: () => ({ doc: (id: string) => ({ create: async (d: any) => { created.push({ id, d }) } }) }) } as any }
  }
  it('開關沒開 → 不產連結（⛔ 也不寫任何一筆短網址）', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: 'https://x.test', notifyLinksEnabled: false }))
    const { db, created } = fakeDb()
    expect(notifyLinksEnabled()).toBe(false)
    expect(await createNotifyLink('W', '/admin/W', db)).toBeUndefined()
    expect(created).toHaveLength(0)
  })
  it('開關開了、但沒有對外網址 → 一樣不放（⛔ 不放相對路徑）', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: '', notifyLinksEnabled: true }))
    expect(notifyLinksEnabled()).toBe(false)
  })
  it('開關開了＋有網址 → 產一條 7 碼短網址，存下它要去的後台路徑', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: 'https://x.test/', notifyLinksEnabled: true }))
    const { db, created } = fakeDb()
    const url = await createNotifyLink('W', '/admin/W/conversations?userId=U1', db)
    expect(url).toMatch(/^https:\/\/x\.test\/c\/[A-Za-z0-9]{7}$/)
    expect(created[0].d).toMatchObject({ workspaceId: 'W', path: '/admin/W/conversations?userId=U1' })
  })
  it('⛔ 不是後台路徑一律不產', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: 'https://x.test', notifyLinksEnabled: true }))
    const { db } = fakeDb()
    expect(await createNotifyLink('W', 'https://evil.test', db)).toBeUndefined()
  })
})

const LINE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.2.0'
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const now = 1_800_000_000_000
const doc = { path: '/admin/W1/conversations?userId=U123', createdAt: now - 60_000 }

describe('resolveNotifyRedirect', () => {
  it('🔴 LINE 內建瀏覽器、還沒帶參數 → 先轉回自己加 openExternalBrowser=1（⛔ 直接轉去後台會卡在登入）', () => {
    expect(resolveNotifyRedirect({ code: 'Ab3dE7x', userAgent: LINE_UA, hasExternalParam: false, doc, nowMs: now }))
      .toBe('/c/Ab3dE7x?openExternalBrowser=1')
  })
  it('已經帶參數（外部瀏覽器打開的那一次）→ 轉去那一頁；不會繞圈', () => {
    expect(resolveNotifyRedirect({ code: 'Ab3dE7x', userAgent: SAFARI_UA, hasExternalParam: true, doc, nowMs: now })).toBe(doc.path)
    // LINE 沒有攔下來、還是在內建瀏覽器打開帶參數的那一次：也要走得下去，⛔ 不可以再轉回自己
    expect(resolveNotifyRedirect({ code: 'Ab3dE7x', userAgent: LINE_UA, hasExternalParam: true, doc, nowMs: now })).toBe(doc.path)
  })
  it('一般瀏覽器 → 直接轉去那一頁', () => {
    expect(resolveNotifyRedirect({ code: 'Ab3dE7x', userAgent: SAFARI_UA, hasExternalParam: false, doc, nowMs: now })).toBe(doc.path)
  })
  it('查不到、過期、路徑不是後台 → 後台首頁（⛔ 不顯示錯誤頁、⛔ 不轉去站外）', () => {
    const r = (d: any) => resolveNotifyRedirect({ code: 'Ab3dE7x', userAgent: SAFARI_UA, hasExternalParam: false, doc: d, nowMs: now })
    expect(r(null)).toBe('/admin')
    expect(r({ ...doc, createdAt: now - NOTIFY_LINK_TTL_MS - 1 })).toBe('/admin')
    expect(r({ ...doc, path: 'https://evil.test/' })).toBe('/admin')
    expect(r({ ...doc, path: '//evil.test/admin/x' })).toBe('/admin')
  })
})

describe('isLineInAppBrowser／碼格式', () => {
  it('認得 LINE 內建瀏覽器', () => {
    expect(isLineInAppBrowser(LINE_UA)).toBe(true)
    expect(isLineInAppBrowser(SAFARI_UA)).toBe(false)
    expect(isLineInAppBrowser('')).toBe(false)
  })
  it('只收 7 碼英數', () => {
    expect(isValidNotifyLinkCode('Ab3dE7x')).toBe(true)
    expect(isValidNotifyLinkCode('../etc')).toBe(false)
    expect(isValidNotifyLinkCode('Ab3dE7xx')).toBe(false)
  })
})
