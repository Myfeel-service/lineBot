import { describe, expect, it } from 'vitest'
import {
  addConfigRef,
  collectTagRefs,
  configRefKindIsDeepLinkable,
  configRefPath,
  summarizeConfigRefs,
  type ConfigRef,
} from './config-references'
import { encodeSwitchMenu, encodeTriggerMessage, encodeTriggerModule } from './action-schema'

describe('collectTagRefs — 已編碼的 postback 字串（圖文選單存的就是這個）', () => {
  it('認得 triggerModule 後面掛的 tags', () => {
    const data = encodeTriggerModule('mod-1', ['tag-a', 'tag-b'])
    expect([...collectTagRefs(data)]).toEqual(['tag-a', 'tag-b'])
  })

  it('認得 switchMenu 後面掛的 tags', () => {
    expect([...collectTagRefs(encodeSwitchMenu('menu-1', ['tag-c']))]).toEqual(['tag-c'])
  })

  it('認得 triggerMessage（那是一包 JSON）', () => {
    expect([...collectTagRefs(encodeTriggerMessage('你好', ['tag-d']))]).toEqual(['tag-d'])
  })

  it('⛔ 少認一種就會漏報一整批：三種混在同一張選單裡要全部撈到', () => {
    const menu = {
      name: '主選單',
      areas: [
        { action: { type: 'postback', data: encodeTriggerModule('m1', ['t1']) } },
        { action: { type: 'postback', data: encodeSwitchMenu('menu2', ['t2']) } },
        { action: { type: 'postback', data: encodeTriggerMessage('嗨', ['t3']) } },
      ],
    }
    expect([...collectTagRefs(menu)].sort()).toEqual(['t1', 't2', 't3'])
  })

  it('沒有掛 tags 的字串不會生出東西', () => {
    expect([...collectTagRefs(encodeTriggerModule('m1'))]).toEqual([])
    expect([...collectTagRefs('隨便一句話')]).toEqual([])
  })
})

describe('collectTagRefs — 未編碼的設定物件', () => {
  it('模組按鈕的 tagging 開著才算用到', () => {
    const on = { tagging: { enabled: true, addTagIds: ['t1'] } }
    const off = { tagging: { enabled: false, addTagIds: ['t1'] } }
    expect([...collectTagRefs(on)]).toEqual(['t1'])
    expect([...collectTagRefs(off)]).toEqual([])
  })

  it('⛔ 關掉的 tagging 不可以被下面那條通用的 addTagIds 規則撿回來', () => {
    // 這一條是實作時最容易破的地方：通用規則會看到 tagging.addTagIds
    const doc = { messages: [{ actions: [{ tagging: { enabled: false, addTagIds: ['t9'] } }] }] }
    expect([...collectTagRefs(doc)]).toEqual([])
  })

  it('自動回應的貼標步驟（type: tag）', () => {
    const script = { nodes: [{ id: 'n1', type: 'tag', addTagIds: ['t1', 't2'] }] }
    expect([...collectTagRefs(script)].sort()).toEqual(['t1', 't2'])
  })

  it('活動的 tagIds 與推播的 audienceSource.tagIds', () => {
    expect([...collectTagRefs({ name: '問卷', tagIds: ['t1'] })]).toEqual(['t1'])
    expect([...collectTagRefs({ audienceSource: { type: 'tags', tagIds: ['t2'] } })]).toEqual(['t2'])
  })

  it('去重、去空白、忽略空字串', () => {
    const doc = { tagIds: [' t1 ', 't1', '', null, 't2'] }
    expect([...collectTagRefs(doc)]).toEqual(['t1', 't2'])
  })

  it('壞掉的輸入不會炸', () => {
    expect([...collectTagRefs(null)]).toEqual([])
    expect([...collectTagRefs(undefined)]).toEqual([])
    expect([...collectTagRefs(123)]).toEqual([])
    expect([...collectTagRefs({ tagIds: 'not-an-array' })]).toEqual([])
    expect([...collectTagRefs({ tagging: 'nope' })]).toEqual([])
  })
})

describe('addConfigRef', () => {
  it('同一個來源對同一個目標只記一次', () => {
    const index: Record<string, ConfigRef[]> = {}
    addConfigRef(index, 't1', { kind: 'flow', id: 'f1', label: '查詢訂單' })
    addConfigRef(index, 't1', { kind: 'flow', id: 'f1', label: '查詢訂單' })
    expect(index.t1 ?? []).toHaveLength(1)
  })

  it('同一個目標被不同來源用到要各記一筆', () => {
    const index: Record<string, ConfigRef[]> = {}
    addConfigRef(index, 't1', { kind: 'flow', id: 'f1', label: 'A' })
    addConfigRef(index, 't1', { kind: 'richmenu', id: 'r1', label: 'B' })
    expect((index.t1 ?? []).map(r => r.kind)).toEqual(['flow', 'richmenu'])
  })

  it('空的 targetId 直接忽略', () => {
    const index: Record<string, ConfigRef[]> = {}
    addConfigRef(index, '  ', { kind: 'flow', id: 'f1', label: 'A' })
    expect(Object.keys(index)).toEqual([])
  })
})

describe('summarizeConfigRefs', () => {
  it('照固定順序講，同類合併計數', () => {
    const refs: ConfigRef[] = [
      { kind: 'richmenu', id: 'r1', label: '主選單' },
      { kind: 'script', id: 's1', label: '查訂單' },
      { kind: 'script', id: 's2', label: '退貨' },
    ]
    expect(summarizeConfigRefs(refs)).toBe('自動回應 2、圖文選單 1')
  })

  it('⛔ 空清單回空字串，不在這裡硬寫一句話（兩個呼叫端的語氣不一樣）', () => {
    expect(summarizeConfigRefs([])).toBe('')
  })
})

/**
 * `D-86`：名字要點得進「那一筆」，不是只帶到那一頁。
 *
 * ⛔ 這一組真正在守的是**別把還沒做的頁面也加上 `?id=`**：帶一個那頁根本不看的參數，
 *    人點過去還是落在 71 筆的清單上，卻會以為自己按錯了——那比不給連結更糟。
 */
describe('configRefPath — 深連結只給真的吃得到 ?id= 的頁面', () => {
  const WS = 'ws-1'

  it('機器人模組：帶 id 就直接開那一個', () => {
    expect(configRefPath(WS, 'flow', 'mod-1')).toBe(`/admin/${WS}/flow?id=mod-1`)
    expect(configRefKindIsDeepLinkable('flow')).toBe(true)
  })

  it('沒帶 id 時維持原樣（只連到那一頁）', () => {
    expect(configRefPath(WS, 'flow')).toBe(`/admin/${WS}/flow`)
  })

  it('⛔ 還沒做 ?id= 的五頁，就算給了 id 也不可以掛上去', () => {
    for (const kind of ['richmenu', 'script', 'campaign', 'broadcast', 'supportPreset'] as const) {
      const path = configRefPath(WS, kind, 'some-id')
      expect(path).not.toContain('?')
      expect(configRefKindIsDeepLinkable(kind)).toBe(false)
    }
  })

  it('id 有特殊字元時要編碼（uuid 不會，但別人貼進來的 id 會）', () => {
    expect(configRefPath(WS, 'flow', 'a b&c')).toBe(`/admin/${WS}/flow?id=a%20b%26c`)
  })

  it('空字串 id 當成沒給（⛔ 不可以產出 `?id=` 這種半截網址）', () => {
    expect(configRefPath(WS, 'flow', '')).toBe(`/admin/${WS}/flow`)
  })
})
