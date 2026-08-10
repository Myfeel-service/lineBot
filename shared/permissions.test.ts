import { describe, expect, it } from 'vitest'
import type { WorkspaceMemberRole } from './types/organization'
import type { Capability } from './permissions'
import { CAPABILITIES, ROLE_LEVEL, can, hasMinRole } from './permissions'

const ROLES: WorkspaceMemberRole[] = ['viewer', 'agent', 'admin', 'owner']

describe('hasMinRole', () => {
  it('respects the owner > admin > agent > viewer ordering', () => {
    expect(hasMinRole('owner', 'admin')).toBe(true)
    expect(hasMinRole('admin', 'admin')).toBe(true)
    expect(hasMinRole('agent', 'admin')).toBe(false)
    expect(hasMinRole('viewer', 'agent')).toBe(false)
  })
})

describe('can — role × capability matrix', () => {
  // 期望門檻（與政策一致：內容維護 agent，設定類 admin，讀取 viewer）
  const EXPECTED: Record<Capability, WorkspaceMemberRole> = {
    'ai.read': 'viewer',
    'members.read': 'viewer',
    'knowledge.write': 'agent',
    'sources.write': 'agent',
    'folders.write': 'agent',
    'scripts.write': 'agent',
    'playground.use': 'agent',
    'ai.settings.write': 'admin',
    'usage.read': 'admin',
    'knowledge.reindexAll': 'admin',
    'members.manage': 'admin',
    'line.manage': 'admin',
  }

  it('CAPABILITIES 表與政策期望一致（有新增能力必須同步更新測試）', () => {
    expect(CAPABILITIES).toEqual(EXPECTED)
  })

  it('每個角色對每個能力的 can() 結果都符合門檻', () => {
    for (const cap of Object.keys(EXPECTED) as Capability[]) {
      const min = EXPECTED[cap]
      for (const role of ROLES) {
        const expected = ROLE_LEVEL[role] >= ROLE_LEVEL[min]
        expect(can(role, cap), `${role} × ${cap}`).toBe(expected)
      }
    }
  })

  it('null / undefined 角色一律無權限', () => {
    expect(can(null, 'ai.read')).toBe(false)
    expect(can(undefined, 'scripts.write')).toBe(false)
  })

  it('關鍵回歸：agent 可維護內容但不能改設定', () => {
    expect(can('agent', 'scripts.write')).toBe(true)
    expect(can('agent', 'sources.write')).toBe(true)
    expect(can('agent', 'folders.write')).toBe(true)
    expect(can('agent', 'ai.settings.write')).toBe(false)
    expect(can('agent', 'knowledge.reindexAll')).toBe(false)
  })

  it('關鍵回歸：viewer 只能讀', () => {
    expect(can('viewer', 'ai.read')).toBe(true)
    expect(can('viewer', 'knowledge.write')).toBe(false)
    expect(can('viewer', 'playground.use')).toBe(false)
  })
})

/**
 * 2026-08-10：AI 表現頁（原「用量監控」）從 usage.read 降到 ai.read。
 * 理由是「最該先看的那頁權限最嚴」不合理——第一線客服要看得到自己照顧的 AI 做得好不好；
 * 計費資訊（方案／額度／超量單價）改由 API 逐欄位擋，不再用頁面層級一刀切。
 * 這組把那次決策釘住：能力表本身沒變，變的是「哪一頁要求哪個能力」，
 * 所以這裡驗的是兩個能力的門檻仍然分開、沒有被合併回去。
 */
describe('AI 表現頁 vs 計費資訊的分界（2026-08-10）', () => {
  it('頁面本體（ai.read）viewer 起看得到', () => {
    expect(can('viewer', 'ai.read')).toBe(true)
    expect(can('agent', 'ai.read')).toBe(true)
  })

  it('⛔ 同一頁裡的方案／額度（usage.read）仍然只給 admin+', () => {
    expect(can('viewer', 'usage.read')).toBe(false)
    expect(can('agent', 'usage.read')).toBe(false)
    expect(can('admin', 'usage.read')).toBe(true)
    expect(can('owner', 'usage.read')).toBe(true)
  })

  it('兩者門檻必須不同——合併回同一個門檻就等於這次改動被回退', () => {
    expect(CAPABILITIES['ai.read']).not.toBe(CAPABILITIES['usage.read'])
  })
})
