import { describe, expect, it } from 'vitest'
import { applySuperSubscriptionEdit, describeSuperSubscriptionEdit, SubscriptionEditError } from './subscription-edit'
import type { WorkspaceSubscription } from './plans'

// 一份「綁了卡、有折抵、有預約降級」的訂閱——正是 B-37 事故裡會被清掉的那種
function liveSubscription(): WorkspaceSubscription {
  return {
    planId: 'starter',
    status: 'active',
    currentPeriodStart: '2026-08-05',
    currentPeriodEnd: '2026-09-04',
    anchorDay: 5,
    payuniCardToken: 'hash-secret',
    payuniCardLast4: '1234',
    payuniCardExpiry: '0328',
    autoRenew: true,
    cancelAtPeriodEnd: false,
    pendingPlanId: 'lite',
    creditBalance: 250,
    lastChargeDate: '2026-08-05',
    chargeAttempts: 1,
    chargePeriodStart: '2026-08-05',
    lastChargeError: null,
    quotaOverride: 3000,
    note: '業務談定',
  }
}

describe('applySuperSubscriptionEdit', () => {
  it('B-37 回歸：只改備註不會清掉綁卡／折抵／續扣狀態', () => {
    const existing = liveSubscription()
    const merged = applySuperSubscriptionEdit(existing, {
      planId: 'starter',
      status: 'active',
      currentPeriodStart: '2026-08-05',
      currentPeriodEnd: '2026-09-04',
      anchorDay: 5,
      quotaOverride: 3000,
      note: '改個備註而已',
    })
    expect(merged.note).toBe('改個備註而已')
    // 計費憑證與狀態一根毛都不能少
    expect(merged.payuniCardToken).toBe('hash-secret')
    expect(merged.payuniCardLast4).toBe('1234')
    expect(merged.autoRenew).toBe(true)
    expect(merged.creditBalance).toBe(250)
    expect(merged.pendingPlanId).toBe('lite')
    expect(merged.lastChargeDate).toBe('2026-08-05')
    expect(merged.chargeAttempts).toBe(1)
  })

  it('改方案／狀態只動那兩個欄位，其餘保留', () => {
    const merged = applySuperSubscriptionEdit(liveSubscription(), {
      planId: 'growth',
      status: 'past_due',
      currentPeriodStart: '2026-08-05',
      currentPeriodEnd: '2026-09-04',
      anchorDay: 5,
    })
    expect(merged.planId).toBe('growth')
    expect(merged.status).toBe('past_due')
    expect(merged.payuniCardToken).toBe('hash-secret')
    expect(merged.creditBalance).toBe(250)
  })

  it('清空 quotaOverride／note 會真的移除，不會殘留舊值', () => {
    const merged = applySuperSubscriptionEdit(liveSubscription(), {
      planId: 'starter',
      currentPeriodStart: '2026-08-05',
      quotaOverride: null,
      note: '',
    })
    expect('quotaOverride' in merged).toBe(false)
    expect('note' in merged).toBe(false)
  })

  it('沒有既有訂閱＝建新的：週期由錨定日推出', () => {
    const merged = applySuperSubscriptionEdit(undefined, {
      planId: 'lite',
      currentPeriodStart: '2026-08-16',
    })
    expect(merged.planId).toBe('lite')
    expect(merged.status).toBe('active')
    expect(merged.currentPeriodStart).toBe('2026-08-16')
    expect(merged.currentPeriodEnd).toBe('2026-09-15')
    expect(merged.anchorDay).toBe(16)
    expect(merged.payuniCardToken).toBeUndefined()
  })

  it('明確指定到期日（合約特例）時尊重之', () => {
    const merged = applySuperSubscriptionEdit(undefined, {
      planId: 'lite',
      currentPeriodStart: '2026-08-16',
      currentPeriodEnd: '2026-12-31',
    })
    expect(merged.currentPeriodEnd).toBe('2026-12-31')
  })

  it('planId／status 不合法要擋（給 API 層轉 400）', () => {
    expect(() => applySuperSubscriptionEdit(undefined, { planId: 'nope' }))
      .toThrow(SubscriptionEditError)
    expect(() => applySuperSubscriptionEdit(undefined, { planId: 'lite', status: 'weird' }))
      .toThrow(SubscriptionEditError)
  })
})

describe('describeSuperSubscriptionEdit（超管改方案前的確認框，`B-43`④）', () => {
  // 一份正常續訂中的入門方案（10/20～11/19，11/20 自動扣 799）
  const live = (over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription => ({
    planId: 'starter', status: 'active', currentPeriodStart: '2026-10-20', currentPeriodEnd: '2026-11-19', anchorDay: 20,
    autoRenew: true, payuniCardToken: 'hash', payuniCardLast4: '1234', ...over,
  })
  /** 表單送出的樣子（跟 workspaces.vue saveEdit 組的一樣） */
  const form = (sub: WorkspaceSubscription, over: Record<string, unknown> = {}) => ({
    planId: sub.planId, status: sub.status, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd,
    anchorDay: sub.anchorDay, quotaOverride: sub.quotaOverride ?? null, note: sub.note ?? null, ...over,
  })
  const TODAY = '2026-10-25'

  it('只改備註 → 不用確認', () => {
    expect(describeSuperSubscriptionEdit(live(), form(live(), { note: '改個備註' }), TODAY).changed).toBe(false)
  })

  it('🔴 有綁卡的帳號換方案 → 講清楚下次自動扣款會照新方案扣多少（原本多少），客戶額度立刻變', () => {
    const p = describeSuperSubscriptionEdit(live(), form(live(), { planId: 'growth' }), TODAY)
    expect(p.changed).toBe(true)
    expect(p.changes).toEqual(['方案：入門 → 成長'])
    expect(p.money[0]).toBe('存檔本身不會扣錢，也不會開發票。')
    expect(p.warnings).toEqual(['下次自動扣款：2026-11-20 扣 NT$1,499（成長方案），原本是 2026-11-20 扣 NT$799。'])
    expect(p.customer).toEqual(['每期 AI 回覆額度：500 則 → 1,500 則，存檔後立刻生效。'])
  })

  it('🔴 狀態改成「逾期未付」而且有綁卡 → 警告存檔後 10 分鐘內會真的扣款（跟續扣排程同一個判斷）', () => {
    const p = describeSuperSubscriptionEdit(live(), form(live(), { status: 'past_due' }), '2026-10-21')
    expect(p.changes).toEqual(['狀態：啟用中 → 逾期未付'])
    expect(p.warnings).toEqual(['存檔後 10 分鐘內，系統會向客戶的卡（•••• 1234）扣 NT$799（入門方案）。'])
    expect(p.customer).toContain('帳單頁會出現「這期的自動扣款尚未成功」的黃色警示。')
  })

  it('🔴 改完之後下一輪對帳會直接降回免費（例：逾期未付但這期早過了寬限期）→ 要講', () => {
    const p = describeSuperSubscriptionEdit(live(), form(live(), { status: 'past_due' }), TODAY)
    expect(p.warnings).toEqual(['存檔後 10 分鐘內會被降回免費方案（每期 50 則），之後也不會再自動扣款。'])
    expect(p.money).toEqual(['存檔本身不會扣錢，也不會開發票。']) // ⛔ 不能同時又說「下次自動扣款…」
  })

  it('🔴 刪掉訂閱 → 綁卡、折抵一起消失要講（卡片約定之後解不掉）', () => {
    const p = describeSuperSubscriptionEdit(live({ creditBalance: 300 }), null, TODAY)
    expect(p.changed).toBe(true)
    expect(p.changes).toEqual(['刪掉訂閱資料（目前是入門方案）'])
    expect(p.customer).toEqual(['會被當成免費方案：每期 AI 回覆 500 則 → 50 則，存檔後立刻生效。'])
    expect(p.warnings).toHaveLength(2)
    expect(p.warnings[0]).toContain('綁卡資料（•••• 1234）會一起刪掉')
    expect(p.warnings[1]).toBe('客戶的折抵餘額 NT$300 會一起消失。')
  })

  it('換成不會自動扣款的方案（內部）→ 講「之後不會再自動扣款」', () => {
    const p = describeSuperSubscriptionEdit(live(), form(live(), { planId: 'internal' }), TODAY)
    expect(p.warnings).toEqual(['改完之後不會再自動扣款（原本 2026-11-20 要扣 NT$799）；綁的卡保留。'])
    expect(p.customer).toEqual(['每期 AI 回覆額度：500 則 → 不設上限，存檔後立刻生效。'])
  })

  it('沒綁卡的帳號延長到期日 → 只講改了什麼，沒有扣款那一段', () => {
    const sub = live({ autoRenew: false, payuniCardToken: undefined, payuniCardLast4: undefined })
    const p = describeSuperSubscriptionEdit(sub, form(sub, { currentPeriodEnd: '2026-12-31' }), TODAY)
    expect(p.changes).toEqual(['到期日：2026-11-19 → 2026-12-31'])
    expect(p.money).toEqual(['存檔本身不會扣錢，也不會開發票。'])
    expect(p.warnings).toEqual([])
  })

  it('額度覆蓋：講改前改後與客戶額度', () => {
    const p = describeSuperSubscriptionEdit(live(), form(live(), { quotaOverride: 2000 }), TODAY)
    expect(p.changes).toEqual(['額度覆蓋：用方案預設 → 2,000 則'])
    expect(p.customer).toEqual(['每期 AI 回覆額度：500 則 → 2,000 則，存檔後立刻生效。'])
    expect(p.money).toContain('下次自動扣款：2026-11-20 扣 NT$799（入門方案）。')
  })

  it('新開一份訂閱（原本沒有）→ 講開了什麼方案、本期起訖', () => {
    const p = describeSuperSubscriptionEdit(null, { planId: 'lite', status: 'active', currentPeriodStart: '2026-10-25' }, TODAY)
    expect(p.changes).toEqual(['新開一份訂閱：輕量方案（啟用中），本期 2026-10-25 ～ 2026-11-24'])
    expect(p.customer).toEqual(['每期 AI 回覆額度：50 則 → 200 則，存檔後立刻生效。'])
  })
})
