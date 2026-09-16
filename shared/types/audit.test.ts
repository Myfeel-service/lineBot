/**
 * 操作紀錄的「看得懂」不變量（`C-31` Phase 2 地基）。
 *
 * 守的是同一種老毛病：後端新增一種會寫稽核的動作、卻沒人補白話說明，
 * 畫面上就會出現一列 `alert-fix/knowledge-retry-index-stuck` 給店家看。
 * 這條測試直接掃 server 原始碼裡真的寫進去的動作代號，漏一個就紅。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AUDIT_ACTION_LABELS, auditActionLabel } from './audit'

const SERVER_DIR = fileURLToPath(new URL('../../server', import.meta.url))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : []
  })
}

/**
 * 掃出所有「真的會被寫進 auditLogs」的動作代號（字面字串那種）。
 *
 * ⛔ 只認 `writeAuditLog(` 之後那一段裡的 `action:`：同一個檔案裡常有別的東西也叫
 *    action（broken-module-fix 的請求參數就是 `{ action: 'repoint' }`），
 *    整檔亂掃會把它們當成稽核動作，然後逼人幫一個不存在的東西寫說明。
 */
function actionsWrittenInServerCode(): { action: string, file: string }[] {
  const out: { action: string, file: string }[] = []
  for (const file of walk(SERVER_DIR)) {
    const src = readFileSync(file, 'utf8')
    for (const call of src.matchAll(/writeAuditLog\(/g)) {
      const m = callBody(src, call.index! + call[0].length).match(/action:\s*'([^']+)'/)
      if (m) out.push({ action: m[1]!, file: file.slice(SERVER_DIR.length + 1) })
    }
  }
  return out
}

/**
 * 取這個呼叫括號裡的內容（逐字配對到收括號）。
 * ⛔ 不要用「往後抓 N 個字」：那會抓到呼叫結束之後的程式碼——
 *    2026-09-16 實際踩到，把下一段型別宣告裡的 `action: 'add'` 當成稽核動作，
 *    逼人去幫一個不存在的東西寫說明。
 */
function callBody(src: string, from: number): string {
  let depth = 1
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(from, i)
  }
  return src.slice(from)
}

describe('操作紀錄的動作代號都有白話說明', () => {
  it('server 裡每個寫進稽核的動作，對照表都要有一行', () => {
    const missing = actionsWrittenInServerCode()
      .filter(a => !AUDIT_ACTION_LABELS[a.action])
      .map(a => `${a.action}（${a.file}）`)
    expect(missing, `這些動作會寫進操作紀錄但沒有白話說明，畫面上會直接秀代號：\n${missing.join('\n')}`).toEqual([])
  })

  it('掃得到東西（掃不到就是這條測試自己壞了，不是真的都補齊了）', () => {
    // ⛔ 沒有這一條的話，walk() 走錯路徑時上面那條會永遠綠——
    //    「查不到」被當成「都合格」是這個專案踩過很多次的坑
    expect(actionsWrittenInServerCode().length).toBeGreaterThan(5)
  })

  it('沒有對照時退回顯示代號，不顯示空白', () => {
    expect(auditActionLabel('ai/settings.put')).toBe('改了 AI 設定')
    expect(auditActionLabel('something/new')).toBe('something/new')
  })
})
