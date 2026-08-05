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
