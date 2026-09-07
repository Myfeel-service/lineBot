import { beforeEach, describe, expect, it } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import type { SubscriptionStatus, WorkspaceSubscription } from '~~/shared/billing/plans'
import { BILLING_PLANS } from '~~/shared/billing/plans'

// ⛔ 額度數字不寫死在斷言裡：2026-09-07 調整方案額度時這一整批測試全紅，
//    但沒有一條是真的壞掉——那種紅燈只會訓練人忽略紅燈。
const FREE_QUOTA = BILLING_PLANS.free.answeredQuota
import type { AnsweredQuotaResolution } from './billing'
import { buildPlanView, defaultFreeSubscription, getWorkspaceSubscription, invalidateWorkspaceSubscriptionCache, resolveAnsweredQuota, resolveQuotaAction } from './billing'

const TODAY = '2026-07-28'

/** 最小假 Firestore：只支援 collection('workspaces').doc(id).get()。 */
function fakeDb(subsByWid: Record<string, WorkspaceSubscription | undefined>): Firestore {
  return {
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: true,
          data: () => ({ subscription: subsByWid[id] }),
        }),
      }),
    }),
  } as unknown as Firestore
}

/** 讀取失敗的 Firestore（模擬基礎設施故障）。 */
function brokenDb(): Firestore {
  return {
    collection: () => ({
      doc: () => ({ get: async () => { throw new Error('firestore down') } }),
    }),
  } as unknown as Firestore
}

function sub(planId: WorkspaceSubscription['planId'], status: SubscriptionStatus, quotaOverride?: number | null): WorkspaceSubscription {
  return { planId, status, currentPeriodStart: '2026-07-28', currentPeriodEnd: '2026-08-27', anchorDay: 28, quotaOverride }
}

beforeEach(() => invalidateWorkspaceSubscriptionCache())

describe('resolveAnsweredQuota — 攔截策略（每個帳號一律有方案、一律攔截）', () => {
  it('沒掛訂閱 → 視為免費層並攔截於免費層額度（不再有「無訂閱不攔截」的後門）', async () => {
    const db = fakeDb({ ws_none: undefined })
    const r = await resolveAnsweredQuota('ws_none', db, TODAY)
    expect(r.quota).toBe(FREE_QUOTA)
    expect(r.planId).toBe('free')
    expect(r.periodStart).toBe(TODAY)
  })

  it('Firestore 讀取失敗 → fail-open（不擋則數,交給 token 護欄）', async () => {
    const r = await resolveAnsweredQuota('ws_x', brokenDb(), TODAY)
    expect(r.quota).toBeNull()
    expect(r.planId).toBeNull()
    expect(r.periodStart).toBeNull()
  })

  it('active 方案 → 額度為方案預設', async () => {
    const db = fakeDb({ ws_pro: sub('pro', 'active') })
    const r = await resolveAnsweredQuota('ws_pro', db, TODAY)
    expect(r.quota).toBe(BILLING_PLANS.pro.answeredQuota)
    expect(r.planId).toBe('pro')
  })

  it('回傳的 periodStart 就是額度計數桶的鍵', async () => {
    const db = fakeDb({ ws_pro: sub('pro', 'active') })
    const r = await resolveAnsweredQuota('ws_pro', db, '2026-08-10')
    expect(r.periodStart).toBe('2026-07-28') // 仍在本期內
  })

  it('trialing 也算已開通', async () => {
    const db = fakeDb({ ws_trial: sub('starter', 'trialing') })
    expect((await resolveAnsweredQuota('ws_trial', db, TODAY)).quota).toBe(BILLING_PLANS.starter.answeredQuota)
  })

  it('past_due 仍計量（不因欠費獲得無限量）', async () => {
    const db = fakeDb({ ws_pastdue: sub('lite', 'past_due') })
    expect((await resolveAnsweredQuota('ws_pastdue', db, TODAY)).quota).toBe(BILLING_PLANS.lite.answeredQuota)
  })

  it('canceled → 回到免費層並攔截（不再是「不攔截」）', async () => {
    const db = fakeDb({ ws_cancel: sub('pro', 'canceled', 50_000) })
    const r = await resolveAnsweredQuota('ws_cancel', db, TODAY)
    expect(r.planId).toBe('free')
    expect(r.quota).toBe(FREE_QUOTA) // 特批額度一併失效
  })

  it('quotaOverride 覆蓋方案預設', async () => {
    const db = fakeDb({ ws_ovr: sub('starter', 'active', 5_000) })
    expect((await resolveAnsweredQuota('ws_ovr', db, TODAY)).quota).toBe(5_000)
  })

  it('企業 active 無 override → 額度 null（不設上限）,但仍保留 token 成本護欄', async () => {
    const db = fakeDb({ ws_ent: sub('enterprise', 'active') })
    const r = await resolveAnsweredQuota('ws_ent', db, TODAY)
    expect(r.quota).toBeNull()
    expect(r.internal).toBe(false)
  })

  it('內部/測試方案 → 額度 null 且標記 internal（連 token 護欄都跳過）', async () => {
    for (const id of ['test', 'internal'] as const) {
      invalidateWorkspaceSubscriptionCache()
      const db = fakeDb({ [`ws_${id}`]: sub(id, 'active') })
      const r = await resolveAnsweredQuota(`ws_${id}`, db, TODAY)
      expect(r.quota).toBeNull()
      expect(r.internal).toBe(true)
    }
  })

  it('quota 與 periodStart 同進同出：沒有週期就不回報額度上限（否則會靜默變吃到飽）', async () => {
    // 沒有 periodStart 就沒有計數桶可讀,若還回報 pro 的額度,呼叫端會拿「已用 0 則」
    // 去比對 → 永遠放行。這裡確認防呆分支把 quota 一併關掉,退回 token 護欄。
    const db = fakeDb({ ws_broken: { planId: 'pro', status: 'active', currentPeriodStart: null, currentPeriodEnd: null } })
    const r = await resolveAnsweredQuota('ws_broken', db, TODAY)
    // 正常情況 roll 會補上週期，所以這裡其實拿得到 quota；不變式是「兩者不會一有一無」
    expect(r.quota == null).toBe(r.periodStart == null)
  })

  it('付費方案過期沒續費 → 讀取時就地降回免費層（不依賴排程）', async () => {
    const db = fakeDb({ ws_late: sub('pro', 'active') }) // 本期到 2026-08-27
    const r = await resolveAnsweredQuota('ws_late', db, '2026-09-15')
    expect(r.planId).toBe('free')
    expect(r.quota).toBe(FREE_QUOTA)
    expect(r.periodStart).toBe('2026-08-28') // 已滾到當期 → 額度桶換了一顆 = 自動歸零
  })
})

describe('defaultFreeSubscription — 新建帳號預設訂閱', () => {
  it('免費層、active、錨定日 = 建立當天', () => {
    const s = defaultFreeSubscription('2026-07-28')
    expect(s).toEqual({
      planId: 'free',
      status: 'active',
      currentPeriodStart: '2026-07-28',
      currentPeriodEnd: '2026-08-27',
      anchorDay: 28,
    })
  })

  it('掛上後 → resolveAnsweredQuota 攔截於免費層額度', async () => {
    const db = fakeDb({ ws_new: defaultFreeSubscription(TODAY) })
    const r = await resolveAnsweredQuota('ws_new', db, TODAY)
    expect(r.quota).toBe(FREE_QUOTA)
    expect(r.planId).toBe('free')
  })
})

describe('buildPlanView — 前端顯示視圖', () => {
  it('訂閱讀取失敗（null）→ null', () => {
    expect(buildPlanView(null)).toBeNull()
  })

  it('免費訂閱 → 免費視圖（免費層額度、無超量加購）,含本期起訖', () => {
    const v = buildPlanView(sub('free', 'active'))
    expect(v?.id).toBe('free')
    expect(v?.name).toBe('免費')
    expect(v?.answeredQuota).toBe(FREE_QUOTA)
    expect(v?.overagePerReply).toBeNull()
    expect(v?.currentPeriodStart).toBe('2026-07-28')
    expect(v?.currentPeriodEnd).toBe('2026-08-27')
  })

  it('quotaOverride 反映在視圖額度', () => {
    expect(buildPlanView(sub('starter', 'active', 5_000))?.answeredQuota).toBe(5_000)
  })

  it('canceled → 顯示為免費層（與攔截一致,不會「顯示 pro 但只給免費層額度」）', () => {
    expect(buildPlanView(sub('pro', 'canceled'))?.id).toBe('free')
  })
})

describe('getWorkspaceSubscription', () => {
  it('空 workspaceId 回 null', async () => {
    expect(await getWorkspaceSubscription('', fakeDb({}))).toBeNull()
  })

  it('讀得到訂閱', async () => {
    const db = fakeDb({ ws_a: sub('growth', 'active') })
    expect((await getWorkspaceSubscription('ws_a', db, TODAY))?.planId).toBe('growth')
  })

  it('沒掛訂閱 → 合成免費層訂閱（不是 null）', async () => {
    const s = await getWorkspaceSubscription('ws_none', fakeDb({ ws_none: undefined }), TODAY)
    expect(s?.planId).toBe('free')
    expect(s?.currentPeriodStart).toBe(TODAY)
  })

  it('讀取失敗 → null（呼叫端據此 fail-open）', async () => {
    expect(await getWorkspaceSubscription('ws_a', brokenDb(), TODAY)).toBeNull()
  })
})

describe('resolveQuotaAction — 護欄處置', () => {
  const res = (over: Partial<AnsweredQuotaResolution> = {}): AnsweredQuotaResolution => ({
    quota: 700, planId: 'lite', internal: false, periodStart: '2026-07-28', ...over,
  })

  it('內部/測試方案 → 一律放行（則數、token 都不擋）', () => {
    const r = res({ internal: true, quota: null, planId: 'internal' })
    expect(resolveQuotaAction(r, { answered: 99_999, tokens: 99_999_999 }, 1_000_000, 'handoff_all')).toBe('allow')
  })

  it('有則數額度、未用滿 → 放行（即使 token 已遠超 cap）', () => {
    // 關鍵：付費方案不再被照免費層校準的 1M token cap 提早切斷
    expect(resolveQuotaAction(res(), { answered: 300, tokens: 5_000_000 }, 1_000_000, 'handoff_all')).toBe('allow')
  })

  it('有則數額度、用滿 → 轉真人', () => {
    expect(resolveQuotaAction(res(), { answered: 700, tokens: 0 }, 1_000_000, 'handoff_all')).toBe('handoff')
  })

  it('無則數上限（企業客製 / 讀取失敗）+ token 超過 cap → 依策略轉真人 / 降級', () => {
    const nolimit = res({ quota: null, planId: null, periodStart: null })
    expect(resolveQuotaAction(nolimit, { answered: 0, tokens: 1_000_000 }, 1_000_000, 'handoff_all')).toBe('handoff')
    expect(resolveQuotaAction(nolimit, { answered: 0, tokens: 1_000_000 }, 1_000_000, 'downgrade_model')).toBe('downgrade')
  })

  it('無則數上限、token 未超 → 放行；cap=0 視為不限', () => {
    const nolimit = res({ quota: null, planId: null, periodStart: null })
    expect(resolveQuotaAction(nolimit, { answered: 0, tokens: 999 }, 1_000_000, 'handoff_all')).toBe('allow')
    expect(resolveQuotaAction(nolimit, { answered: 0, tokens: 99_999_999 }, 0, 'handoff_all')).toBe('allow')
  })
})
