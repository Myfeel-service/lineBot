import { describe, expect, it } from 'vitest'
import {
  TONE_ROLES,
  TONE_ROLES_BY_BIZ,
  TONE_SAMPLE_QUESTION,
  pickDefaultToneRole,
  replaceToneVoiceLine,
  toneRoleOf,
  toneRoleVoiceLine,
  toneRolesFor,
  toneSampleAnswer,
  type ToneRoleId,
} from './ai-tone-roles'
import { buildToneDraft, TONE_SAFETY_RULES } from './store-profile-drafts'
import { emptyStoreProfile } from './types/store-profile'
import type { StoreBizType } from './store-profile-biz'

const BIZ: StoreBizType[] = ['goods', 'service', 'class', 'neutral']

describe('像誰說話（`D-175`）', () => {
  it('每一型四個、不重複；⛔ 做服務、教課的沒有「綜藝主持」', () => {
    for (const b of BIZ) {
      expect(TONE_ROLES_BY_BIZ[b]).toHaveLength(4)
      expect(new Set(TONE_ROLES_BY_BIZ[b]).size).toBe(4)
    }
    expect(TONE_ROLES_BY_BIZ.service).not.toContain('host')
    expect(TONE_ROLES_BY_BIZ.class).not.toContain('host')
    expect(toneRolesFor('醫療／健康').map(r => r.label)).not.toContain('綜藝主持')
    // 自己打的產業別＝中性型（⛔ 不猜）
    expect(toneRolesFor('手工皂工作室').map(r => r.id)).toEqual([...TONE_ROLES_BY_BIZ.neutral])
  })

  it('⛔ 只用職業類型，不用真人：名字裡沒有人名、沒有「像某某」', () => {
    for (const r of Object.values(TONE_ROLES)) {
      expect(r.label.length).toBeLessThanOrEqual(4)
      expect(r.voice.startsWith('像')).toBe(true)
    }
  })

  it('每一型的四個都回答「同一題」，而且示範裡 ⛔ 沒有數字（價格、時間我們不知道）', () => {
    for (const b of BIZ) {
      expect(TONE_SAMPLE_QUESTION[b].length).toBeGreaterThan(0)
      const answers = TONE_ROLES_BY_BIZ[b].map(id => toneSampleAnswer(id, b, '黑豆水'))
      expect(new Set(answers).size, b).toBe(4)
      for (const a of answers) expect(a, b).not.toMatch(/[0-9０-９]/)
    }
  })

  it('「有推薦的嗎？」那題帶他的第一樣主打；沒有就講「我們的招牌」', () => {
    expect(toneSampleAnswer('anchor', 'goods', '黑豆水')).toContain('黑豆水')
    expect(toneSampleAnswer('anchor', 'goods', '')).toContain('我們的招牌')
  })

  it('預選：照網站猜的口氣挑最接近的，猜不出來就是那一型的第一個', () => {
    expect(pickDefaultToneRole('零售／電商', '活潑、熱情')).toBe('host')
    expect(pickDefaultToneRole('零售／電商', '專業、沉穩')).toBe('anchor')
    expect(pickDefaultToneRole('醫療／健康', '專業、沉穩')).toBe('advisor')
    expect(pickDefaultToneRole('醫療／健康', '溫暖貼心')).toBe('receptionist')
    expect(pickDefaultToneRole('教育／課程', '親切')).toBe('senior')
    expect(pickDefaultToneRole('零售／電商', '')).toBe('shopkeeper')
    // 診所網站很活潑也不會被預選「綜藝主持」（那一型根本沒有它）
    expect(TONE_ROLES_BY_BIZ.service).toContain(pickDefaultToneRole('醫療／健康', '活潑'))
  })

  it('換角色只換「說話的口氣：」那一行，開頭、事實行與安全規則一字不動', () => {
    const ctx = { shopName: '山丘咖啡', profile: emptyStoreProfile(), today: '2026-11-06' }
    const before = buildToneDraft(ctx, { voice: TONE_ROLES.shopkeeper.voice })
    const r = replaceToneVoiceLine(before, 'anchor')
    expect(r.replaced).toBe(true)
    expect(r.text).toBe(buildToneDraft(ctx, { voice: TONE_ROLES.anchor.voice }))
    expect(r.text).toContain(TONE_SAFETY_RULES)
    expect(toneRoleOf(r.text)).toBe('anchor')
  })

  it('沒有口氣那一行（自己寫的、舊範本）＝不動，交給呼叫端決定要不要整段換', () => {
    const own = '你是品牌的線上客服，語氣親切。'
    expect(replaceToneVoiceLine(own, 'anchor')).toEqual({ text: own, replaced: false })
    expect(toneRoleOf(own)).toBeNull()
  })

  it('口氣那一行自己改過＝不算任何一個角色（⛔ 不可以講成某個角色）', () => {
    const edited = `你是山丘咖啡的客服助理。\n${toneRoleVoiceLine('anchor').replace('沉穩', '沉穩幽默')}`
    expect(toneRoleOf(edited)).toBeNull()
    for (const id of Object.keys(TONE_ROLES) as ToneRoleId[]) {
      expect(toneRoleOf(`x\n${toneRoleVoiceLine(id)}\ny`)).toBe(id)
    }
  })
})
