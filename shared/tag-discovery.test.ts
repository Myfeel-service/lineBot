import { describe, expect, it } from 'vitest'
import {
  MAX_PROPOSALS_PER_SCAN,
  normalizeTagName,
  sanitizeDiscoveryProposals,
  sanitizeTagCode,
  type RawDiscoveryTopic,
} from './tag-discovery'

/** 場次 0~9 依序屬於 u0~u9（預設每場都是不同客人） */
const USERS = Array.from({ length: 10 }, (_, i) => `ws_u${i}`)

function topic(over: Partial<RawDiscoveryTopic> = {}): RawDiscoveryTopic {
  return {
    name: '在看除濕機',
    code: 'intent_dehumidifier',
    category: 'interest',
    criteria: '客人詢問、比較除濕機。只問維修的不算。',
    usage: '除濕機品類意向客',
    reason: '兩週內多位客人問到除濕機',
    sessions: [0, 1, 2, 3, 4],
    ...over,
  }
}

describe('AI 發現新標籤：模型輸出的守門員', () => {
  it('正常提案通過，場次索引對回客人主鍵', () => {
    const out = sanitizeDiscoveryProposals([topic()], { sessionUserIds: USERS, takenNames: [] })
    expect(out).toHaveLength(1)
    expect(out[0]!.userDocIds).toEqual(['ws_u0', 'ws_u1', 'ws_u2', 'ws_u3', 'ws_u4'])
  })

  it('⛔ 門檻數的是「不同客人」不是場次：同一人五場只算一位 → 整條丟掉', () => {
    // 五場全是同一位客人
    const sameUser = ['ws_uA', 'ws_uA', 'ws_uA', 'ws_uA', 'ws_uA']
    const out = sanitizeDiscoveryProposals([topic()], { sessionUserIds: sameUser, takenNames: [] })
    expect(out).toHaveLength(0)
  })

  it('支持場次不足門檻 → 丟掉（模型硬湊的主題進不來）', () => {
    const out = sanitizeDiscoveryProposals([topic({ sessions: [0, 1] })], { sessionUserIds: USERS, takenNames: [] })
    expect(out).toHaveLength(0)
  })

  it('撞到既有標籤名 → 丟掉，而且擋得住空白／標點／大小寫的變體', () => {
    for (const existing of ['在看除濕機', '在看 除濕機', '在看除濕機。']) {
      const out = sanitizeDiscoveryProposals([topic()], { sessionUserIds: USERS, takenNames: [existing] })
      expect(out, `撞「${existing}」應該被擋`).toHaveLength(0)
    }
  })

  it('撞到否決過的名字 → 丟掉（否決票永久有效）', () => {
    const out = sanitizeDiscoveryProposals([topic()], {
      sessionUserIds: USERS,
      takenNames: ['在看除濕機'], // dismissedNames 也是走 takenNames 進來
    })
    expect(out).toHaveLength(0)
  })

  it('提案彼此同名只留第一條；總數吃上限', () => {
    const raw = [
      topic(),
      topic({ code: 'x2' }), // 同名第二條
      topic({ name: '想送禮', code: 'gift', sessions: [5, 6, 7, 8] }),
      topic({ name: '問過運費', code: 'ship', sessions: [1, 3, 5, 7] }),
      topic({ name: '抱怨過', code: 'complain', sessions: [0, 2, 4, 6] }),
    ]
    const out = sanitizeDiscoveryProposals(raw, { sessionUserIds: USERS, takenNames: [] })
    expect(out.map(p => p.name)).toEqual(['在看除濕機', '想送禮', '問過運費'].slice(0, MAX_PROPOSALS_PER_SCAN))
    expect(out.length).toBeLessThanOrEqual(MAX_PROPOSALS_PER_SCAN)
  })

  it('沒名稱／沒條件／亂給的 sessions 索引 → 各自處理不炸掉', () => {
    const raw = [
      topic({ name: '' }),
      topic({ criteria: '' }),
      topic({ name: '想送禮', sessions: [99, -1, 'x', 0, 1, 2, 3] as unknown[] }), // 只有 0~3 有效
    ]
    const out = sanitizeDiscoveryProposals(raw, { sessionUserIds: USERS, takenNames: [] })
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('想送禮')
    expect(out[0]!.userDocIds).toEqual(['ws_u0', 'ws_u1', 'ws_u2', 'ws_u3'])
  })

  it('白名單外的 category 一律降成 custom（模型發明的分類不進下拉選單）', () => {
    const out = sanitizeDiscoveryProposals([topic({ category: 'vip_zone' })], { sessionUserIds: USERS, takenNames: [] })
    expect(out[0]!.category).toBe('custom')
  })

  it('超長的 criteria 截斷到編輯器上限、不丟棄', () => {
    const out = sanitizeDiscoveryProposals(
      [topic({ criteria: '長'.repeat(500) })],
      { sessionUserIds: USERS, takenNames: [] },
    )
    expect(out[0]!.criteria).toHaveLength(200)
  })
})

describe('主題名比對鍵', () => {
  it('空白、全形空白、常見標點、大小寫都不影響比對', () => {
    expect(normalizeTagName('在看 除濕機')).toBe(normalizeTagName('在看除濕機'))
    expect(normalizeTagName('在看　除濕機。')).toBe(normalizeTagName('在看除濕機'))
    expect(normalizeTagName('VIP Zone')).toBe(normalizeTagName('vipzone'))
  })
})

describe('標籤 code 清洗', () => {
  it('合法照收、大寫轉小寫、不合法回空字串（退路由呼叫端給）', () => {
    expect(sanitizeTagCode('intent_dehumidifier')).toBe('intent_dehumidifier')
    expect(sanitizeTagCode('Intent_X2')).toBe('intent_x2')
    expect(sanitizeTagCode('中文code')).toBe('')
    expect(sanitizeTagCode('9starts_with_digit')).toBe('')
    expect(sanitizeTagCode('')).toBe('')
  })
})
