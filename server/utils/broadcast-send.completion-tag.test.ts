/**
 * 「發完幫收到的人貼記號」的把關（`C-213`）。
 *
 * ⛔ 這一條**只能貼給真的收到的人**：失敗的多半是封鎖了官方帳號，貼上去就是一句謊話，
 * 而且之後照那顆標籤挑名單會把他們算進去。整支檔案就是為了釘住這一條。
 *
 * ⚠️ 不去跑真正的 `sendBroadcast`（那會呼叫 LINE、寫 Firestore）——
 * 這裡驗的是「誰該被貼」這個判斷本身，把它當純邏輯測。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/** 與 `broadcast-send.ts` 同一條規則：送成功的才貼 */
function recipientsToTag(
  recipients: Array<{ docId: string; lineUserId: string }>,
  failedIds: string[],
): string[] {
  const failed = new Set(failedIds)
  return recipients.filter(r => !failed.has(r.lineUserId)).map(r => r.docId)
}

const RECIPIENTS = [
  { docId: 'ws_U1', lineUserId: 'U1' },
  { docId: 'ws_U2', lineUserId: 'U2' },
  { docId: 'ws_U3', lineUserId: 'U3' },
]

describe('發完貼記號：只貼給真的收到的人', () => {
  it('全部成功 → 全部都貼', () => {
    expect(recipientsToTag(RECIPIENTS, [])).toEqual(['ws_U1', 'ws_U2', 'ws_U3'])
  })

  it('⛔ 有人失敗 → 那幾位不可以被貼（他們沒收到）', () => {
    expect(recipientsToTag(RECIPIENTS, ['U2'])).toEqual(['ws_U1', 'ws_U3'])
  })

  it('全部失敗 → 一個都不貼', () => {
    expect(recipientsToTag(RECIPIENTS, ['U1', 'U2', 'U3'])).toEqual([])
  })

  /**
   * ⛔ 這一條是「程式碼真的長這樣」的守門：上面那個純函式是複製品，
   * 真正跑的是 `broadcast-send.ts` 裡那一段。有人把過濾拿掉時，上面三條不會紅。
   */
  it('⛔ broadcast-send.ts 真的有把失敗的濾掉', () => {
    const src = readFileSync(new URL('./broadcast-send.ts', import.meta.url), 'utf8')
    expect(src).toContain('const succeeded = recipients.filter(r => !failedForTagging.has(r.lineUserId))')
  })

  it('⛔ 貼標必須在 checkpoint 之後（壞掉不可以害推播卡在發送中）', () => {
    const src = readFileSync(new URL('./broadcast-send.ts', import.meta.url), 'utf8')
    const checkpoint = src.indexOf('送出後立刻落地發送結果（checkpoint）')
    const tagging = src.indexOf('發完幫「真的收到的人」貼標')
    expect(checkpoint).toBeGreaterThan(0)
    expect(tagging).toBeGreaterThan(checkpoint)
  })

  it('⛔ 貼標結果要寫回文件，不可以只寫 log', () => {
    const src = readFileSync(new URL('./broadcast-send.ts', import.meta.url), 'utf8')
    expect(src).toContain('completionTagOutcome')
  })
})
