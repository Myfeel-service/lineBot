import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HUMAN_HANDLING_BOT_NOTE } from './human-handling-copy'

/**
 * `D-31`（2026-10-20）之後，真人接手期間客人自己按的查詢按鈕照樣會回——
 * 「機器人與 AI 不會再自動回覆這位客人」這類說法變成錯的。這裡掃畫面的來源檔，
 * 舊說法回來就紅（同事看到選單回了訊息會以為機器人在搶話）。
 */
const ROOT = resolve(__dirname, '..')
const SOURCES = [
  'app/components/conversations/AdminPanel.vue',
  'app/utils/tutorial-topics.ts',
  'app/composables/useWorkspaceAlerts.ts',
  'server/api/conversations/sessions/[sessionId]/takeover.post.ts',
]
const OLD_PHRASES = [
  '不會再自動回覆這位客人',
  '機器人與 AI 不會再自動回覆',
  '機器人與 AI 暫停自動回覆',
  '機器人與 AI 會暫停自動回覆',
  '機器人已停止自動回覆',
  '客人只能等你們回',
]

/** 剝掉註解：說明舊說法為什麼錯的那幾行註解會引用舊句子，不算畫面上的字 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('真人接手期間機器人做什麼：全站同一句、而且講對', () => {
  it('那一句講的是「不回打的字、按鈕照樣回」', () => {
    expect(HUMAN_HANDLING_BOT_NOTE).toMatch(/不再回客人打的字/)
    expect(HUMAN_HANDLING_BOT_NOTE).toMatch(/查詢按鈕照樣會回/)
  })

  for (const file of SOURCES) {
    it(`⛔ ${file} 畫面上不再出現舊說法`, () => {
      const src = stripComments(readFileSync(resolve(ROOT, file), 'utf8'))
      for (const p of OLD_PHRASES) expect(src, `${file} 還寫著「${p}」`).not.toContain(p)
    })
  }

  it('對話頁與新手導覽都吃同一句（不是各寫一份）', () => {
    for (const file of ['app/components/conversations/AdminPanel.vue', 'app/utils/tutorial-topics.ts']) {
      expect(readFileSync(resolve(ROOT, file), 'utf8')).toContain('HUMAN_HANDLING_BOT_NOTE')
    }
  })
})
