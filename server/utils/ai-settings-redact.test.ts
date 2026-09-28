/**
 * AI 設定依角色拿掉欄位（`G-103`）。
 *
 * 釘住的：
 * 1. 🔴 平台管的三格（模型、embedding 模型、回覆長度）只有超管拿得到——連帳號管理員都不行。
 * 2. 🔴 觀察者拿不到 LINE 通知名單（他連那一頁都進不去），但拿得到「有幾個人在收」。
 *    ⛔ 不可以回空陣列頂替：那是在說「沒人收」。
 * 3. token 上限只給改得動它的人（管理員）；那是店家自己設的保護，管理員一定要看得到。
 * 4. ⛔ 不可以改到傳進來的那份：它是快取裡的同一個物件，改到＝整台機器的 AI 讀到殘缺的設定。
 */
import { describe, expect, it } from 'vitest'
import { buildDefaultAiSettings } from '~~/shared/types/ai-knowledge'
import type { AiSettingsDoc } from '~~/shared/types/ai-knowledge'
import { redactAiSettingsForRole } from './ai-settings-redact'

function sample(): AiSettingsDoc {
  const d = buildDefaultAiSettings() as AiSettingsDoc
  return {
    ...d,
    answerModel: 'gemini-2.5-flash-lite',
    replyMaxLen: 420,
    quota: { monthlyTokenCap: 3_000_000, onExceed: 'handoff_all' },
    handoffNotify: {
      ...d.handoffNotify,
      enabled: true,
      lineUserIds: ['Uaaa', 'Ubbb'],
      displayNames: { Uaaa: '小美', Ubbb: '阿明' },
      slaRemindMinutes: 15,
    },
  }
}

describe('redactAiSettingsForRole', () => {
  it('超管：整份原樣', () => {
    const v = redactAiSettingsForRole(sample(), { role: 'owner', isSuperAdmin: true })
    expect(v.answerModel).toBe('gemini-2.5-flash-lite')
    expect(v.embeddingModel).toBe('gemini-embedding-001')
    expect(v.replyMaxLen).toBe(420)
    expect(v.quota.monthlyTokenCap).toBe(3_000_000)
    expect(v.handoffNotify.lineUserIds).toEqual(['Uaaa', 'Ubbb'])
  })

  it('🔴 帳號擁有者／管理員也拿不到模型與回覆長度（成本槓桿收歸平台）', () => {
    for (const role of ['owner', 'admin'] as const) {
      const v = redactAiSettingsForRole(sample(), { role, isSuperAdmin: false })
      expect('answerModel' in v, role).toBe(false)
      expect('embeddingModel' in v, role).toBe(false)
      expect('replyMaxLen' in v, role).toBe(false)
    }
  })

  it('管理員看得到自己設的 token 上限與通知名單（存檔要用、而且改得動）', () => {
    const v = redactAiSettingsForRole(sample(), { role: 'admin', isSuperAdmin: false })
    expect(v.quota).toEqual({ monthlyTokenCap: 3_000_000, onExceed: 'handoff_all' })
    expect(v.handoffNotify.lineUserIds).toEqual(['Uaaa', 'Ubbb'])
    expect(v.handoffNotify.displayNames).toEqual({ Uaaa: '小美', Ubbb: '阿明' })
  })

  it('客服：看得到通知名單（他自己也在收），token 上限不給（畫面本來就不顯示、也改不了）', () => {
    const v = redactAiSettingsForRole(sample(), { role: 'agent', isSuperAdmin: false })
    expect(v.handoffNotify.lineUserIds).toEqual(['Uaaa', 'Ubbb'])
    expect('monthlyTokenCap' in v.quota).toBe(false)
    expect(v.quota.onExceed).toBe('handoff_all')
  })

  it('🔴 觀察者：名單與顯示名稱都拿不到，⛔但要知道有幾個人在收（不可以講成沒人）', () => {
    const v = redactAiSettingsForRole(sample(), { role: 'viewer', isSuperAdmin: false })
    expect('lineUserIds' in v.handoffNotify).toBe(false)
    expect('displayNames' in v.handoffNotify).toBe(false)
    expect(v.handoffNotify.recipientCount).toBe(2)
    expect(v.handoffNotify.enabled).toBe(true)
    // 其他通知設定照給：觀察者看得到「什麼時候通知」不是洞
    expect(v.handoffNotify.slaRemindMinutes).toBe(15)
    expect('monthlyTokenCap' in v.quota).toBe(false)
    expect(JSON.stringify(v)).not.toMatch(/Uaaa|小美/)
  })

  it('每個角色都有 recipientCount（畫面判斷「有沒有人在收」用同一格）', () => {
    for (const role of ['viewer', 'agent', 'admin', 'owner'] as const)
      expect(redactAiSettingsForRole(sample(), { role, isSuperAdmin: false }).handoffNotify.recipientCount, role).toBe(2)
  })

  it('一般欄位原封不動（⛔只拿掉該拿的）', () => {
    const s = sample()
    const v = redactAiSettingsForRole(s, { role: 'viewer', isSuperAdmin: false })
    expect(v.enabled).toBe(s.enabled)
    expect(v.systemPrompt).toBe(s.systemPrompt)
    expect(v.serviceHours).toEqual(s.serviceHours)
    expect(v.sensitiveTopics).toEqual(s.sensitiveTopics)
  })

  it('🔴 不改到傳進來的那份（那是快取裡的同一個物件）', () => {
    const s = sample()
    const before = structuredClone(s)
    const v = redactAiSettingsForRole(s, { role: 'viewer', isSuperAdmin: false })
    expect(s).toEqual(before)
    // 超管拿到的名單也是複本：呼叫端改它不會回頭改到快取
    const sa = redactAiSettingsForRole(s, { role: 'owner', isSuperAdmin: true })
    sa.handoffNotify.lineUserIds!.push('Uzzz')
    expect(s.handoffNotify.lineUserIds).toEqual(['Uaaa', 'Ubbb'])
    expect(v).not.toBe(s)
  })
})
