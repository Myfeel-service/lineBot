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
import { AUDIT_ACTION_LABELS, auditActionLabel, auditChangeLines, auditValueText } from './audit'

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

/**
 * 「改動內容」那一欄要真的講出改了什麼（2026-09-18 老闆反映）。
 *
 * 當時畫面上四列都是「轉真人通知：（一組設定） → （一組設定）」——資料明明都存了
 * （稽核刻意存設定裡的真實層級，「還原」才知道要改回哪一格），只是畫面停在第一層沒展開。
 */
describe('前後對照展開到真的有變的那一格', () => {
  it('巢狀設定會展開，不再只說「（一組設定）」', () => {
    const { lines, omitted } = auditChangeLines(
      { handoffNotify: { slaRemindMinutes: 30 } },
      { handoffNotify: { slaRemindMinutes: 37 } },
    )
    expect(omitted).toBe(0)
    expect(lines).toEqual([
      { key: 'handoffNotify.slaRemindMinutes', label: '轉真人通知 › 等太久的提醒時間（分鐘）', before: '30', after: '37' },
    ])
  })

  it('只有一格開關的設定也講得出開還是關', () => {
    const { lines } = auditChangeLines({ autoTagSuggest: { enabled: true } }, { autoTagSuggest: { enabled: false } })
    expect(lines).toEqual([
      { key: 'autoTagSuggest.enabled', label: 'AI 自動貼標建議 › 開關', before: '開', after: '關' },
    ])
  })

  it('⛔ 同一顆設定裡沒變的那幾格不印（印了會把真正改動的那行淹掉）', () => {
    const { lines } = auditChangeLines(
      { serviceHours: { enabled: true, start: '09:00', end: '18:00', weekendOff: true } },
      { serviceHours: { enabled: true, start: '08:00', end: '18:00', weekendOff: true } },
    )
    expect(lines.map(l => l.label)).toEqual(['勿擾時段 › 服務時段起'])
    expect(lines[0]).toMatchObject({ before: '09:00', after: '08:00' })
  })

  it('清單型欄位講得出多了哪個字，不是只講「19 項 → 20 項」', () => {
    const { lines } = auditChangeLines(
      { sensitiveTopics: ['客訴', '投訴'] },
      { sensitiveTopics: ['客訴', '投訴', '退款'] },
    )
    expect(lines[0]!.after).toBe('3 項（新增「退款」）')
    expect(lines[0]!.before).toBe('2 項')
  })

  it('清單差異太多項就只講數量（一行塞 60 個詞沒人看得完）', () => {
    const before = ['a']
    const after = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const { lines } = auditChangeLines({ sensitiveTopics: before }, { sensitiveTopics: after })
    expect(lines[0]!.after).toBe('7 項（新增 6、移除 0）')
  })

  it('⛔ 值本身是代號的要換成白話（`missed_only` 對店家沒有意義）', () => {
    const { lines } = auditChangeLines(
      { handoffNotify: { mode: 'always' } },
      { handoffNotify: { mode: 'missed_only' } },
    )
    expect(lines[0]).toMatchObject({ before: '每次都通知', after: '沒人接手才通知' })
    expect(auditValueText('draft', 'replyMode')).toBe('只給草稿')
    // 對不到的照樣原樣顯示：寧可秀代號，也不要秀空白
    expect(auditValueText('whatever', 'mode')).toBe('whatever')
  })

  it('⛔ 超過行數上限要繼續數，不是數到一半就停（說得出還有幾項）', () => {
    const many = (v: number) => Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, v]))
    const { lines, omitted } = auditChangeLines(many(1), many(2))
    expect(lines).toHaveLength(12)
    expect(omitted).toBe(8)
    expect(lines.length + omitted).toBe(20)
  })

  it('⛔ 展不出東西時退回第一層，不可以留空白（空白會被讀成「沒改到東西」）', () => {
    // 只有 key 順序不同：JSON 比對說「有變」，但沒有任何一格真的變了
    const { lines } = auditChangeLines({ quota: { a: 1, b: 2 } }, { quota: { b: 2, a: 1 } })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ label: '用量上限', before: '（一組設定）', after: '（一組設定）' })
  })

  it('⛔ 物件被換成一個字時不可以把那個字弄丟', () => {
    const { lines } = auditChangeLines({ endpoint: { url: 'a' } }, { endpoint: 'https://x.example' })
    expect(lines).toEqual([
      { key: 'endpoint', label: '收訊網址', before: '（一組設定）', after: 'https://x.example' },
    ])
  })

  it('新增或整個拿掉一組設定時，缺的那一邊講「（空白）」', () => {
    expect(auditChangeLines(null, { inactiveTag: { days: 30 } }).lines).toEqual([
      { key: 'inactiveTag.days', label: '沉睡客人自動標籤 › 幾天沒來訊算沉睡', before: '（空白）', after: '30' },
    ])
  })
})
