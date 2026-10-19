/**
 * AI 讀的對話有時間上限（`C-4`）。每一條都是正式站真的發生過的排列。
 */
import { describe, expect, it } from 'vitest'
import {
  AI_HISTORY_MAX_AGE_MS,
  contextWindowFlags,
  PRODUCT_CONTEXT_MAX_AGE_MS,
  PUSH_PRODUCT_CONTEXT_MAX_AGE_MS,
  type ContextWindowMessage,
} from './ai-context-window'

const NOW = Date.parse('2026-10-16T15:55:31Z')
const H = 60 * 60 * 1000
const D = 24 * H
const ago = (ms: number) => NOW - ms

/** 由舊到新寫比較好讀；函式吃的是新的在前 */
function flags(oldestFirst: ContextWindowMessage[]) {
  return contextWindowFlags([...oldestFirst].reverse(), NOW).reverse()
}

describe('三把尺各自的上限', () => {
  it('給 AI 讀的：72 小時內進、超過就不進', () => {
    const f = flags([
      { direction: 'incoming', messageType: 'text', text: '舊的', timestampMs: ago(AI_HISTORY_MAX_AGE_MS + 60_000) },
      { direction: 'incoming', messageType: 'text', text: '前天的', timestampMs: ago(AI_HISTORY_MAX_AGE_MS - 60_000) },
    ])
    expect(f.map(x => x.forAi)).toEqual([false, true])
  })

  it('認商品的：7 天內進（C-344 那位隔了 3 天多要認得到），超過就不進', () => {
    const f = flags([
      { direction: 'incoming', messageType: 'customer_action', actionType: 'button_module', text: '客人點了「出貨進度查詢 - 電淨艙」', timestampMs: ago(PRODUCT_CONTEXT_MAX_AGE_MS + 60_000) },
      { direction: 'incoming', messageType: 'customer_action', actionType: 'button_module', text: '客人點了「出貨進度查詢 - 電淨艙」', timestampMs: ago(3.5 * D) },
    ])
    expect(f.map(x => x.forProduct)).toEqual([false, true])
    // 3.5 天前的按鈕：認商品看得到、給 AI 讀的看不到（AI 本來就不讀按鈕紀錄，這裡也過了 72 小時）
    expect(f[1]!.forAi).toBe(false)
  })

  it('時間讀不到的（正式資料不會發生）當作剛剛：寧可多讀一則', () => {
    const f = flags([{ direction: 'incoming', messageType: 'text', text: '?', timestampMs: null }])
    expect(f[0]).toEqual({ forAi: true, forProduct: true, push: false })
  })
})

describe('系統主動發的（加好友、活動登記帶出來的開賣通知）只在 72 小時內拿來認商品', () => {
  /** 10/16 那位客人：65 天前加好友＋登記「乾淨方max問卷」，收到開賣通知；之後第一次開口 */
  const campaign = (at: number): ContextWindowMessage[] => [
    { direction: 'incoming', messageType: 'customer_action', actionType: 'follow', text: '客人加入好友', timestampMs: at },
    { direction: 'outgoing', messageType: 'image', sender: 'bot', text: '[圖片]', timestampMs: at + 1000 },
    { direction: 'incoming', messageType: 'customer_action', actionType: 'campaign_claim', text: '客人從活動「乾淨方max問卷」登記', timestampMs: at + 1500 },
    { direction: 'outgoing', messageType: 'text', sender: 'bot', text: 'Hi 恭喜你成功啟動專屬開賣通知！ SHARP 最新機種《乾淨方MAX》', timestampMs: at + 2000 },
  ]

  it('65 天前的開賣通知：認商品、給 AI 讀都不進（這次的災情）', () => {
    const f = flags([...campaign(ago(65 * D)), { direction: 'incoming', messageType: 'text', text: '我為何9/3買是22900？', timestampMs: NOW }])
    expect(f.slice(0, 4).map(x => x.forProduct)).toEqual([false, false, false, false])
    expect(f.slice(0, 4).map(x => x.forAi)).toEqual([false, false, false, false])
  })

  it('5 天前登記的：一般訊息 5 天還算數，但推播超過 72 小時就不拿來認商品', () => {
    const f = flags([
      ...campaign(ago(5 * D)),
      { direction: 'incoming', messageType: 'text', text: '什麼時候開賣', timestampMs: NOW },
    ])
    expect(f.slice(0, 4).map(x => x.push)).toEqual([true, true, true, true])
    expect(f.slice(0, 4).map(x => x.forProduct)).toEqual([false, false, false, false])
  })

  it('剛登記就來問「什麼時候開賣」：開賣通知是唯一線索，要留著', () => {
    const f = flags([
      ...campaign(ago(PUSH_PRODUCT_CONTEXT_MAX_AGE_MS - H)),
      { direction: 'incoming', messageType: 'text', text: '什麼時候開賣', timestampMs: NOW },
    ])
    expect(f.slice(0, 4).map(x => x.forProduct)).toEqual([true, true, true, true])
  })

  it('推播到客人開口為止：之後機器人回他按鈕的那則不是推播（5 天前一樣認得到商品）', () => {
    const at = ago(5 * D)
    const f = flags([
      ...campaign(at),
      { direction: 'incoming', messageType: 'customer_action', actionType: 'button_module', text: '客人點了「出貨進度查詢 - 乾淨方MAX」', timestampMs: at + 60_000 },
      { direction: 'outgoing', messageType: 'text', sender: 'bot', text: '乾淨方MAX 10 月中旬出貨', timestampMs: at + 61_000 },
    ])
    expect(f.slice(4).map(x => x.push)).toEqual([false, false])
    expect(f.slice(4).map(x => x.forProduct)).toEqual([true, true])
  })

  it('推播比「客人從活動登記」那一行早存進來（兩邊並行寫）也認得出是推播', () => {
    const at = ago(5 * D)
    const f = flags([
      { direction: 'outgoing', messageType: 'text', sender: 'bot', text: '恭喜你成功啟動開賣通知《小耳記》', timestampMs: at },
      { direction: 'incoming', messageType: 'customer_action', actionType: 'campaign_claim', text: '客人從活動「小耳記問卷」登記', timestampMs: at + 800 },
    ])
    expect(f.map(x => x.push)).toEqual([true, true])
    expect(f.map(x => x.forProduct)).toEqual([false, false])
  })

  it('真人主動傳的不算推播（客人沒開口，也是一對一講的話）', () => {
    const at = ago(5 * D)
    const f = flags([
      { direction: 'incoming', messageType: 'customer_action', actionType: 'follow', text: '客人加入好友', timestampMs: at },
      { direction: 'outgoing', messageType: 'text', sender: 'human', text: '您好，您訂的電淨艙…', timestampMs: at + 3 * H },
    ])
    expect(f[1]).toEqual({ forAi: false, forProduct: true, push: false })
  })

  it('舊資料沒有 actionType 時看那一行的字', () => {
    const at = ago(5 * D)
    const f = flags([
      { direction: 'incoming', messageType: 'customer_action', text: '客人從活動「乾淨方max問卷」登記', timestampMs: at },
      { direction: 'outgoing', messageType: 'text', text: '恭喜你成功啟動專屬開賣通知！', timestampMs: at + 1000 },
    ])
    expect(f.map(x => x.push)).toEqual([true, true])
  })
})
