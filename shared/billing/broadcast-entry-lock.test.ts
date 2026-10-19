/**
 * 帶著發送對象進推播頁的入口，照方案在入口就先講（`C-352`①，2026-10-19 老闆「照建議」）。
 *
 * `D-131` 把推播頁鎖好了，但入口沒跟上：輕量方案在好友頁勾了人、按「推播給這 N 位」，
 * 照樣進推播頁寫完整則，才發現那一格鎖住、送不出去。
 *
 * 這支釘兩件事：
 *  ① 每個入口在免費／輕量（入門）／成長三種方案下鎖不鎖、講哪一句——句子一律是推播頁那一句（`broadcastLockText`）
 *  ② 每個入口真的接上了（讀原始碼）：按鈕鎖住、講那一行、有去問方案；以後新開一個帶對象進推播頁的入口，下面那張清單不登記就紅
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BILLING_PLANS, broadcastEntryLockText, broadcastLockText } from './plans'

const ROOT = join(__dirname, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const LOCK_NONE = broadcastLockText('none')
const LOCK_BASIC = broadcastLockText('basic')

/** 每個入口帶進推播頁的是哪一種發送對象 */
const ENTRIES = [
  { name: '好友頁「推播給這 N 位」', file: 'app/pages/admin/[workspaceId]/users.vue', audience: 'import' },
  { name: '好友統計「發推播給這群」', file: 'app/pages/admin/[workspaceId]/friend-stats.vue', audience: 'tags' },
  // 檔期要的是文案：方案不能分眾時後端不挑標籤（`marketing-calendar/draft`），所以只問發不發得了
  { name: '首頁檔期「為這一檔擬推播」', file: 'app/components/admin/AdminMarketingCalendarCard.vue', audience: 'all' },
  { name: '活動精靈「順手留一張推播草稿」', file: 'app/components/admin/AdminCampaignWizard.vue', audience: 'tags' },
] as const

describe('① 三種方案下，每個入口鎖不鎖、講哪一句', () => {
  const EXPECT: Record<'free' | 'lite' | 'starter' | 'growth', Record<'import' | 'tags' | 'all', string | null>> = {
    free: { import: LOCK_NONE, tags: LOCK_NONE, all: LOCK_NONE },
    lite: { import: LOCK_BASIC, tags: LOCK_BASIC, all: null },
    starter: { import: LOCK_BASIC, tags: LOCK_BASIC, all: null },
    growth: { import: null, tags: null, all: null },
  }

  for (const [planId, row] of Object.entries(EXPECT)) {
    it(`${BILLING_PLANS[planId as keyof typeof EXPECT].name}方案`, () => {
      for (const e of ENTRIES) {
        expect(broadcastEntryLockText(BILLING_PLANS[planId as keyof typeof EXPECT].broadcast, e.audience), e.name)
          .toBe(row[e.audience])
      }
    })
  }

  it('讀不到方案（null）→ 每個入口都不鎖（fail-open：推播頁與送出端照擋）', () => {
    for (const e of ENTRIES) expect(broadcastEntryLockText(null, e.audience), e.name).toBeNull()
  })

  it('句子跟推播頁鎖住時同一句（⛔ 入口不另外造句）', () => {
    expect(LOCK_BASIC).toBe('目前的方案只能發給全部好友；依標籤篩選、匯入名單要成長以上的方案才能用。')
    expect(LOCK_NONE).toBe('目前的方案不能發推播，要輕量以上的方案才能發。')
  })
})

describe('② 每個入口真的接上了', () => {
  for (const e of ENTRIES) {
    it(e.name, () => {
      const s = src(e.file)
      expect(s, '照它帶過去的那種對象問').toContain(`broadcastEntryLockText(broadcastTier.value, '${e.audience}')`)
      expect(s, '有去問這個帳號的推播等級').toMatch(/loadBroadcastTier\(\)/)
      expect(s, '講那一行（共用元件：🔒＋那一句＋查看方案）').toMatch(/<AdminBroadcastPlanLock[^>]*:text="broadcastLock"/)
      // 檔期與好友頁／好友統計是按鈕、活動精靈是勾選框：都要被鎖住
      expect(s, '入口那一顆鎖住').toMatch(/:disabled="!!broadcastLock/)
    })
  }

  it('推播頁自己也用同一個元件（鎖住那一行只有一份長相）', () => {
    const s = src('app/pages/admin/[workspaceId]/broadcasts.vue')
    expect(s.match(/<AdminBroadcastPlanLock/g)?.length).toBe(2)
    expect(s, '⛔ 不要再手刻一份「查看方案」').not.toContain('>查看方案<')
  })

  it('小幫手的確認卡：方案做不到時主句換成那一行、⛔ 不給確認鈕（只給「知道了」）', () => {
    const s = src('app/components/agent/AgentOpConfirmCard.vue')
    expect(s).toMatch(/v-if="planLocked"[\s\S]{0,200}<AdminBroadcastPlanLock :text="pending\.preview\.summary"/)
    expect(s).toMatch(/v-if="pending\.preview\.noop \|\| planLocked"[\s\S]{0,400}知道了/)
  })

  it('活動精靈：方案發不了就不建那張草稿（送出去的那份輸入也要關掉，不只是畫面上不勾）', () => {
    expect(src('app/components/admin/AdminCampaignWizard.vue'))
      .toContain('createBroadcastDraft: form.createBroadcastDraft && !broadcastLock.value')
  })
})

describe('③ 掃一遍：帶對象進推播頁的路都登記在上面', () => {
  function listVue(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) out.push(...listVue(full))
      else if (name.endsWith('.vue') || (name.endsWith('.ts') && !name.endsWith('.test.ts'))) out.push(full)
    }
    return out
  }
  const files = listVue(join(ROOT, 'app')).map(f => ({ rel: relative(ROOT, f), s: readFileSync(f, 'utf8') }))
  const known = new Set<string>([...ENTRIES.map(e => e.file), 'app/pages/admin/[workspaceId]/broadcasts.vue'])

  it('掃得到檔案（⛔ 路徑寫錯的話下面會空跑成綠燈）', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('帶 `?from=` 進推播頁、或直接建推播草稿的地方，都在清單上', () => {
    const hits = files
      .filter(f => /broadcasts\?from=|['"`]\/api\/broadcast\/create['"`]/.test(f.s))
      .map(f => f.rel)
    expect(hits.length, '對照組：至少抓得到好友頁那一條').toBeGreaterThan(0)
    const unknown = hits.filter(f => !known.has(f))
    expect(unknown, '新的入口要在入口就照方案先講（broadcastEntryLockText），並登記到上面那張清單').toEqual([])
  })
})
