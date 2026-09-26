/**
 * 🔴 紅線：對客人講話只用點過頭的卡（`C-250`③）。
 *
 * 「等你看過」（draft）的卡有向量，只要有一個檢索點沒走同一支、或旗標沒綁 isTest，
 * LINE 那條路就會用到沒看過的卡——而那不會有任何錯誤、只是客人聽到一段店家沒看過的話。
 * 讀原始碼比對：這幾條的失敗方式是「少改一處」，跑行為測試要把整支 answerWithAi 搬起來。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SERVER = fileURLToPath(new URL('..', import.meta.url))
const answer = readFileSync(`${SERVER}utils/ai-answer.ts`, 'utf8')
const playground = readFileSync(`${SERVER}api/ai/playground.post.ts`, 'utf8')
const handler = readFileSync(`${SERVER}utils/handler.ts`, 'utf8')

describe('試答才讀得到等你看過的卡', () => {
  it('⛔ 旗標一定要配 isTest（誤帶 includeDrafts 的呼叫端照樣只讀可用的卡）', () => {
    expect(answer).toContain('const readDrafts = input.includeDrafts === true && input.isTest === true')
  })

  it('⛔ 五個檢索點全部走 searchChunks，沒有任何一處直接呼叫 searchSimilarChunks', () => {
    const direct = answer.match(/searchSimilarChunks\(db, workspaceId,/g) ?? []
    // 唯一允許的一處是 searchChunks 自己的定義
    expect(direct).toHaveLength(1)
    expect(answer).toMatch(/: searchSimilarChunks\(db, workspaceId, v, k\)/)
    expect((answer.match(/await searchChunks\(|return searchChunks\(/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  it('測試對話頁帶了旗標；⛔ LINE 那條路沒有', () => {
    expect(playground).toContain('includeDrafts: true')
    expect(playground).toContain('isTest: true')
    expect(handler).not.toContain('includeDrafts')
  })
})
