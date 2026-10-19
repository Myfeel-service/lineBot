/**
 * 後台節慶提示的判定測試。
 *
 * 為什麼值得測：它的失效方式是「該出現的沒出現」——畫面上跟平常一模一樣，
 * 沒有錯誤訊息，沒有人會發現（同側欄狀態點、欄位圈框的理由）。
 * 日期用節日表裡查證過的中秋節 2026-09-25 當錨。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { festivalHint } from './festival-hint'

describe('節日 7 天窗', () => {
  it('窗外（前 20 天）→ 不顯示，元件整塊不渲染', () => {
    expect(festivalHint('2026-09-05')).toBeNull()
  })

  it('前 7 天進窗：講「備素材」那一檔', () => {
    const h = festivalHint('2026-09-18')
    expect(h?.name).toBe('中秋節')
    expect(h?.daysUntil).toBe(7)
    expect(h?.text).toContain('再過 7 天就是中秋節')
    expect(h?.text).toContain('先把檔期優惠')
  })

  it('剩 3 天換檔：講「今天就去排推播」——跟 LINE 上同一句', () => {
    const h = festivalHint('2026-09-22')
    expect(h?.text).toContain('再過 3 天就是中秋節')
    expect(h?.text).toContain('推播')
  })

  it('節日當天還在：講「今天」，過了才消失', () => {
    expect(festivalHint('2026-09-25')?.daysUntil).toBe(0)
    // 隔天就沒了（過了的節日不追講）——除非又踩進下一個節日的窗
    const after = festivalHint('2026-09-26')
    if (after) expect(after.name).not.toBe('中秋節')
  })

  it('後台是常駐的：窗內每一天都有話講（不像 LINE 講過一次就閉嘴）', () => {
    for (const d of ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-23', '2026-09-24']) {
      expect(festivalHint(d), d).not.toBeNull()
    }
  })
})

/**
 * `C-357`：免費方案（不能發推播）——小幫手節日卡、推播頁上方那行都吃這一支，⛔ 不叫他去排推播。
 * 卡片上「擬草稿／去推播頁／去排推播」那幾顆也要跟著收（元件那一層用原始碼守）。
 */
describe('免費方案的後台節日提醒（C-357）', () => {
  it('窗內每一天都不出現「推播」', () => {
    for (const d of ['2026-09-18', '2026-09-20', '2026-09-22', '2026-09-24', '2026-09-25']) {
      const h = festivalHint(d, { canBroadcast: false })
      expect(h, d).not.toBeNull()
      expect(h!.text, d).not.toContain('推播')
    }
  })

  it('等級讀不到（不給）＝照舊：3 天前照樣叫他去排', () => {
    expect(festivalHint('2026-09-22')?.text).toContain('推播')
    expect(festivalHint('2026-09-22', {})?.text).toBe(festivalHint('2026-09-22')?.text)
  })

  const src = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8')

  it('小幫手節日卡：字吃方案、免費時推播那幾顆收起來', () => {
    const ta = src('components/TutorialAgent.vue')
    expect(ta).toContain('festivalHint(taipeiDate(), { canBroadcast: canBroadcast.value })')
    expect(ta).toMatch(/<template v-if="canBroadcast">\s*<div v-if="can\(ADMIN_OP_CAPABILITY\[AGENT_FESTIVAL_ASK\.op\]\)"[\s\S]{0,700}去排推播 →<\/button>\s*<\/template>/)
  })

  it('推播頁上方那行、LINE 通知設定頁的說明：都照方案改口', () => {
    expect(src('pages/admin/[workspaceId]/broadcasts.vue')).toContain('festivalHint(taipeiDate(), { canBroadcast: planBroadcastTier.value !== \'none\' })')
    expect(src('pages/admin/[workspaceId]/settings/line-notify.vue')).toMatch(/broadcastTier\.value === 'none'\s*\?\s*'節日前 7／3／1 天各講一次：先備素材、再確認庫存和出貨/)
  })
})
