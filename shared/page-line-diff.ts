/**
 * 網址資料「網頁改了哪幾行」（`C-368`，設計見 `docs/KB-URL-UPDATE-DESIGN-20261021.md`）。純函式。
 *
 * 為什麼要有：重新同步以前比的是「AI 上次寫的卡 vs AI 這次重寫的卡」，措辭每次都會飄，
 * 畫面上永遠一堆「修改」、未變常是 0。網頁本身是穩的（2026-10-21 MYFEEL 12 個網址各抓兩次，
 * 抹掉會自己跳的數字後每一行都一樣），所以先拿「這批知識是照哪一版網頁做的」原文跟這一版
 * 一行一行比，再決定 AI 重寫的結果哪些要採用。
 *
 * 規則：
 * - 一行＝抓網頁程式輸出的一行（`extractUrlText` 把連結寫成「文字（網址）」，一個商品通常一行）。
 * - 空白收成一個、去頭尾；太短（一兩個字）的行不算。
 * - 順序不算、重複不算：首頁商品換位置不是改版（changedetection.io 的「只有出現新的行才算」同一個意思）。
 * - `ignoreNumbers`：這個網址的數字本來就會自己跳（集資金額、人數、剩幾天）時，比對前把數字抹掉；
 *   平常數字不動的網址照樣比數字——改價就是那一行變了。
 */
import { normalizeVolatileNumbers } from './knowledge-fingerprint'

export interface PageLine {
  /** 比對用的那一行（空白收過；ignoreNumbers 時數字換成 #） */
  key: string
  /** 給人看的：網址拿掉、太長截斷 */
  display: string
  /** 這一行裡的連結，正規化過（見 normalizePageLink） */
  links: string[]
  /** 在它那一版網頁裡是第幾行（去掉空行、重複行之後）；「問句緊挨著答句」要靠它認 */
  index: number
}

export interface PageLineDiff {
  /** 這一版有、上一版沒有的行 */
  added: PageLine[]
  /** 上一版有、這一版沒有的行 */
  removed: PageLine[]
  baselineLineCount: number
  currentLineCount: number
  /** 比的時候有沒有把數字抹掉（數字會自己跳的網址）。沒抹＝改價就是那一行變了 */
  ignoreNumbers: boolean
}

/** 一行至少幾個字才算（「Q」「>」這種單字元不算一行內容） */
const MIN_LINE_CHARS = 2
/**
 * 給人看的那一行最多幾個字。80：一行商品名稱＋特色放得下；再長就是集資金額、人數那串
 *（MYFEEL 首頁一行 150 字，整串攤開「網頁改了這幾行」變成一面數字牆）
 */
const DISPLAY_MAX_CHARS = 80

const URL_RE = /https?:\/\/[^\s）)」』]+/g

/**
 * 連結正規化：host 小寫、去 query／hash、去尾斜線。跟知識卡「連結：」那行的配對（`extractCardLink`）
 * **必須是同一套**，網頁上的那一行才認得出是哪一條知識。
 */
export function normalizePageLink(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
  }
  catch {
    return null
  }
}

function displayOf(line: string): string {
  const t = line
    .replace(/（\s*https?:\/\/[^）]*）/g, '')
    .replace(URL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > DISPLAY_MAX_CHARS ? `${t.slice(0, DISPLAY_MAX_CHARS)}…` : t
}

/** 把網頁文字切成一行一行（同一行出現兩次只留一次） */
export function splitPageLines(text: string, opts: { ignoreNumbers: boolean }): PageLine[] {
  const seen = new Set<string>()
  const out: PageLine[] = []
  for (const raw of String(text ?? '').split('\n')) {
    const collapsed = raw.replace(/\s+/g, ' ').trim()
    if (collapsed.length < MIN_LINE_CHARS) continue
    const key = opts.ignoreNumbers ? normalizeVolatileNumbers(collapsed) : collapsed
    if (seen.has(key)) continue
    seen.add(key)
    const links = [...new Set((collapsed.match(URL_RE) ?? []).map(normalizePageLink).filter((l): l is string => !!l))]
    out.push({ key, display: displayOf(collapsed), links, index: out.length })
  }
  return out
}

export function diffPageLines(baselineText: string, currentText: string, opts: { ignoreNumbers: boolean }): PageLineDiff {
  const before = splitPageLines(baselineText, opts)
  const after = splitPageLines(currentText, opts)
  const beforeKeys = new Set(before.map(l => l.key))
  const afterKeys = new Set(after.map(l => l.key))
  return {
    added: after.filter(l => !beforeKeys.has(l.key)),
    removed: before.filter(l => !afterKeys.has(l.key)),
    baselineLineCount: before.length,
    currentLineCount: after.length,
    ignoreNumbers: opts.ignoreNumbers,
  }
}

export function pageLinesChanged(d: PageLineDiff): boolean {
  return d.added.length > 0 || d.removed.length > 0
}

/**
 * 網頁大改：改了的行超過一半（而且不是只有一兩行的小頁面）。這種不自動更新、停下來問——
 * 多半是網站改版或抓網頁的方式變了，一行一行對已經沒有意義。
 */
export const LARGE_CHANGE_MIN_LINES = 10
export function pageChangeIsLarge(d: PageLineDiff): boolean {
  const changed = Math.max(d.added.length, d.removed.length)
  const base = Math.max(d.baselineLineCount, d.currentLineCount)
  return changed >= LARGE_CHANGE_MIN_LINES && changed > base * 0.5
}
