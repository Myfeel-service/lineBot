import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：審核視窗的「這一條回答了哪幾題？」（`C-311`，2026-10-14）。
 *
 * 以前：同一組裡是同一個產品的不同問題（正式站「小滑手」那組四題），寫一條回答其中一題、按採用就整組消失，
 * 其他題目沒人回答。元件在 node 測試環境掛不起來，所以讀原始碼驗結構與字；勾選規則本身在 utils 有單元測試。
 */

const SRC = readFileSync(fileURLToPath(new URL('./KnowledgeSuggestions.vue', import.meta.url)), 'utf8')
/** 拿掉註解：只驗畫面上會出現的字與真的會跑的程式 */
const CODE = SRC
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '')).join('\n')
const TEMPLATE = CODE.slice(0, CODE.indexOf('<script'))
const SCRIPT = CODE.slice(CODE.indexOf('<script'))

describe('審核視窗：這一條回答了哪幾題', () => {
  it('一題以上才出勾選清單，而且取代「客人這樣問」清單（同樣的題目不列兩次）', () => {
    expect(TEMPLATE).toContain('這一條回答了哪幾題？')
    expect(TEMPLATE).toMatch(/<template v-if="isMulti">[\s\S]*<el-checkbox-group v-model="answeredModel"[\s\S]*<template v-else>[\s\S]*客人這樣問/)
    // 勾選清單列的是這一組全部的題目，不是只有 5 條樣本（沒列出來的勾不到、採用後會莫名留在清單上）
    expect(SCRIPT).toMatch(/groupQueries = \(s: SuggestionRow\) => \(s\.queries\?\.length \? s\.queries : s\.sampleQueries\)/)
    expect(TEMPLATE).toMatch(/v-for="q in reviewQueries"/)
  })

  it('預設勾選走 defaultAnsweredQueries（⛔ 不是全勾），問法跟著勾選連動', () => {
    // 第三個參數是「標題欄實際會填的字」（草稿標題，沒有就是主題名），不是只看草稿標題
    expect(SCRIPT).toMatch(/const title = s\.draft\?\.title \?\? s\.topic/)
    expect(SCRIPT).toMatch(/defaultAnsweredQueries\(qs, s\.draft\?\.questions, title\)/)
    expect(SCRIPT).not.toMatch(/answered\.value = \[\.\.\.qs\]/)
    expect(SCRIPT).toMatch(/form\.value\.questions = syncTickedQuestions\(form\.value\.questions, answered\.value, next\)/)
    // ⛔ 沒有草稿時不再拿前 3 句客人原句當問法（一題以上的組）
    expect(SCRIPT).toMatch(/syncTickedQuestions\(s\.draft\?\.questions \?\? \[\], \[\], ticked\)/)
  })

  it('採用時送勾了哪幾題；一題都沒勾就擋下', () => {
    expect(SCRIPT).toMatch(/answeredQueries: reviewQueries\.value\.filter\(q => answered\.value\.includes\(q\)\)/)
    expect(TEMPLATE).toMatch(/:disabled="[^"]*\|\| noneTicked"/)
    expect(TEMPLATE).toContain("'至少勾一題'")
  })

  it('只回答了其中幾題：重讀清單（沒勾的那筆還在、名字與次數伺服器重算過），提示講沒勾的去哪了', () => {
    expect(SCRIPT).toMatch(/if \(left > 0\) \{\s*await load\(\)/)
    expect(SCRIPT).toContain('沒勾的 ${left} 題還在清單上')
  })

  it('忽略照舊是整組；好幾題時先問，講清楚會全部拿掉', () => {
    expect(SCRIPT).toMatch(/if \(n > 1\) \{\s*try \{\s*await ElMessageBox\.confirm\(/)
    expect(SCRIPT).toContain('這一組的 ${n} 題會全部從清單拿掉。')
    expect(SCRIPT).toContain("confirmButtonText: '全部忽略'")
  })

  it('畫面上的量詞是「條」／「題」，⛔ 不出現「張」「卡片」「知識卡」', () => {
    const visible = TEMPLATE.replace(/\{\{[\s\S]*?\}\}/g, '')
    expect(visible).not.toMatch(/張|卡片|知識卡/)
  })
})
