import { describe, expect, it } from 'vitest'
import {
  buildDeleteConfirmCopy,
  campaignDeleteConfirmCopy,
  moduleDeleteConfirmCopy,
  richMenuDeleteConfirmCopy,
  richMenusSwitchingTo,
} from './delete-impact'
import type { ConfigRef } from './config-references'

/**
 * 刪除確認框要講的話（`D-110` ④）。
 *
 * 這裡釘的是四件事：
 *   ① 沒有人用 → 維持原本那句簡單確認（按鈕也照舊「刪除／取消」）
 *   ② 有人用 → 分類計數、名字最多三個、其餘講「等 N 個」、同一句後果只講一次
 *   ③ 查不到 → ⛔ 不可以退回簡單確認（查不到不等於沒有人用）
 *   ④ 停用中的設定不算「在用」（否則確認框每次都在講不會發生的事）
 */

const ref = (kind: ConfigRef['kind'], label: string, extra: Partial<ConfigRef> = {}): ConfigRef =>
  ({ kind, id: `${kind}-${label}`, label, ...extra })

describe('moduleDeleteConfirmCopy', () => {
  it('沒有人用：原本那句簡單確認，按鈕照舊', () => {
    const copy = moduleDeleteConfirmCopy({ name: '查詢訂單', refs: [], failedKinds: [] })
    expect(copy).toEqual({
      hasImpact: false,
      message: '確定刪除「查詢訂單」？',
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
    })
  })

  it('拍板的那個例子：分類計數＋名字＋後果，按鈕換成「仍要刪除／先不要」', () => {
    const copy = moduleDeleteConfirmCopy({
      name: '查詢訂單',
      refs: [
        ref('richmenu', '主選單'),
        ref('script', '訂單關鍵字'),
        ref('richmenu', '會員選單'),
      ],
      failedKinds: [],
    })
    expect(copy.hasImpact).toBe(true)
    expect(copy.message).toBe(
      '「查詢訂單」被 1 條自動回應、2 個圖文選單用到（「訂單關鍵字」、「主選單」、「會員選單」）。'
      + '刪掉之後，自動回應走到這一步會沒有回覆，客人按那些按鈕會沒反應。',
    )
    expect(copy.confirmButtonText).toBe('仍要刪除')
    expect(copy.cancelButtonText).toBe('先不要')
  })

  it('名字超過三個：只列前三個，講「等 N 個」（N＝總數），⛔ 不可以安靜少列', () => {
    const copy = moduleDeleteConfirmCopy({
      name: '真人客服',
      refs: ['A', 'B', 'C', 'D', 'E'].map(n => ref('flow', n)),
      failedKinds: [],
    })
    expect(copy.message).toContain('被 5 個模組的按鈕用到（「A」、「B」、「C」等 5 個）')
    expect(copy.message).not.toContain('「D」')
  })

  it('剛好三個不加「等」', () => {
    const copy = moduleDeleteConfirmCopy({
      name: 'x',
      refs: ['A', 'B', 'C'].map(n => ref('flow', n)),
      failedKinds: [],
    })
    expect(copy.message).toContain('（「A」、「B」、「C」）')
    expect(copy.message).not.toContain('等 ')
  })

  it('圖文選單與模組按鈕的後果是同一句，只講一次', () => {
    const copy = moduleDeleteConfirmCopy({
      name: 'x',
      refs: [ref('flow', '上一層'), ref('richmenu', '主選單')],
      failedKinds: [],
    })
    expect(copy.message.match(/客人按那些按鈕會沒反應/g)).toHaveLength(1)
  })

  it('照浮層的固定順序講（自動回應 → 圖文選單 → 模組 → 活動 → 推播 → 客服預存）', () => {
    const copy = moduleDeleteConfirmCopy({
      name: 'x',
      refs: [
        ref('supportPreset', '預存'),
        ref('broadcast', '中秋推播'),
        ref('campaign', '問卷'),
        ref('flow', '上一層'),
      ],
      failedKinds: [],
    })
    expect(copy.message).toContain('被 1 個模組的按鈕、1 個活動、1 則推播、1 則客服預存用到')
    expect(copy.message).toContain('刪掉之後，客人按那些按鈕會沒反應，客人從活動加好友後收不到這則，推播會送不出去，客服按那則預存會送不出去。')
  })

  it('⛔ 停用中的設定不算在用：只剩停用中的就是簡單確認', () => {
    const copy = moduleDeleteConfirmCopy({
      name: '查詢訂單',
      refs: [ref('script', '舊流程', { inactive: true }), ref('broadcast', '已發送', { inactive: true })],
      failedKinds: [],
    })
    expect(copy.hasImpact).toBe(false)
    expect(copy.message).toBe('確定刪除「查詢訂單」？')
  })

  it('停用中的混在裡面：只數在用的', () => {
    const copy = moduleDeleteConfirmCopy({
      name: 'x',
      refs: [ref('script', '在用'), ref('script', '停用', { inactive: true })],
      failedKinds: [],
    })
    expect(copy.message).toContain('被 1 條自動回應用到（「在用」）')
    expect(copy.message).not.toContain('停用')
  })

  it('⛔ 整包查不到：不可以退回簡單確認，要講「沒辦法確定」', () => {
    const copy = moduleDeleteConfirmCopy({
      name: '查詢訂單',
      refs: [],
      failedKinds: ['script', 'richmenu', 'flow', 'campaign', 'broadcast', 'supportPreset'],
    })
    expect(copy.hasImpact).toBe(true)
    expect(copy.message).toBe('這次查不到有哪些地方用到「查詢訂單」，沒辦法確定刪掉會不會影響客人。')
    expect(copy.confirmButtonText).toBe('仍要刪除')
  })

  it('查到一部分、另一部分沒查到：講查到的，再補一句哪幾類沒查到', () => {
    const copy = moduleDeleteConfirmCopy({
      name: 'x',
      refs: [ref('richmenu', '主選單')],
      failedKinds: ['script', 'broadcast'],
    })
    expect(copy.message).toBe(
      '「x」被 1 個圖文選單用到（「主選單」）。刪掉之後，客人按那些按鈕會沒反應。'
      + '另外，自動回應、推播這次沒查到，可能還有別的地方用到它。',
    )
  })
})

describe('campaignDeleteConfirmCopy', () => {
  it('還沒產過連結、也沒人綁定：原本那句簡單確認', () => {
    const copy = campaignDeleteConfirmCopy({ name: '春季問卷', hasPublishedLink: false, isActive: true, boundCount: 0 })
    expect(copy).toEqual({
      hasImpact: false,
      message: '確定刪除「春季問卷」？此操作無法復原。',
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
    })
  })

  it('啟用中、有連結、有人綁定：講連結會失效＋數字救不回來，只想暫停的指去「停用」（`G-108`）', () => {
    const copy = campaignDeleteConfirmCopy({ name: '春季問卷', hasPublishedLink: true, isActive: true, boundCount: 12 })
    expect(copy.hasImpact).toBe(true)
    expect(copy.message).toBe(
      '刪掉「春季問卷」之後，已經發出去的連結會失效，客人點進去會看到活動已結束，'
      + '已綁定 12 人的成效數字也看不到了。只是想先暫停的話，把「啟用狀態」關掉再儲存就好，之後還開得回來。',
    )
    expect(copy.confirmButtonText).toBe('仍要刪除')
  })

  it('停用中、沒人綁定：連結本來就點不開，⛔ 不再講「會失效」這種已經發生的事——回簡單確認', () => {
    const copy = campaignDeleteConfirmCopy({ name: '春季問卷', hasPublishedLink: true, isActive: false, boundCount: 0 })
    expect(copy.hasImpact).toBe(false)
    expect(copy.message).toBe('確定刪除「春季問卷」？此操作無法復原。')
  })

  it('停用中但有人綁定過：只講數字會不見，不建議停用（本來就停著）', () => {
    const copy = campaignDeleteConfirmCopy({ name: '春季問卷', hasPublishedLink: true, isActive: false, boundCount: 3 })
    expect(copy.message).toBe('刪掉「春季問卷」之後，已綁定 3 人的成效數字也看不到了。')
  })

  it('人數查不到（null）時不講數字，⛔ 也不講成 0 人', () => {
    const copy = campaignDeleteConfirmCopy({ name: 'x', hasPublishedLink: true, isActive: true, boundCount: null })
    expect(copy.message).not.toMatch(/\d+ 人/)
    expect(copy.hasImpact).toBe(true)
  })
})

describe('richMenusSwitchingTo（別張選單有沒有按鈕切到它）', () => {
  const target = { id: 'rm-main', aliasId: 'rmmain', name: '主選單' }

  it('兩種存法都認：postback switchMenu=<id>，以及發佈後的 richmenuswitch＋別名', () => {
    const names = richMenusSwitchingTo(target, [
      target,
      { id: 'a', name: '會員選單', areas: [{ action: { type: 'postback', data: 'switchMenu=rm-main&tags=t1' } }] },
      { id: 'b', name: '活動選單', areas: [{ action: { type: 'richmenuswitch', richMenuAliasId: 'rmmain', data: 'x' } }] },
      { id: 'c', name: '無關選單', areas: [{ action: { type: 'message', data: 'switchMenu=rm-other' } }] },
    ])
    expect(names).toEqual(['會員選單', '活動選單'])
  })

  it('自己切到自己不算；沒名字的講「未命名選單」', () => {
    const names = richMenusSwitchingTo(target, [
      { ...target, areas: [{ action: { type: 'postback', data: 'switchMenu=rm-main' } }] },
      { id: 'd', name: ' ', areas: [{ action: { type: 'postback', data: 'switchMenu=rm-main' } }] },
    ])
    expect(names).toEqual(['未命名選單'])
  })
})

describe('richMenuDeleteConfirmCopy', () => {
  it('不是預設、沒人切到它：原本那句簡單確認', () => {
    const copy = richMenuDeleteConfirmCopy({ name: '會員選單', isDefault: false, switchedFrom: [], listIncomplete: false })
    expect(copy).toEqual({
      hasImpact: false,
      message: '確定刪除「會員選單」？此動作無法復原。',
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
    })
  })

  it('預設選單＋別張切到它：先講誰切到它，再講它是所有人看到的，後果一次講完', () => {
    const copy = richMenuDeleteConfirmCopy({ name: '主選單', isDefault: true, switchedFrom: ['會員選單', '活動選單'], listIncomplete: false })
    expect(copy.hasImpact).toBe(true)
    expect(copy.message).toBe(
      '「主選單」被 2 個圖文選單的切換按鈕用到（「會員選單」、「活動選單」）。「主選單」是所有好友現在看到的選單。'
      + '刪掉之後，客人按那些切換按鈕會沒反應，好友聊天室下方的選單會消失。',
    )
    expect(copy.confirmButtonText).toBe('仍要刪除')
  })

  it('⛔ 清單沒載完：不可以當成沒人切到它', () => {
    const copy = richMenuDeleteConfirmCopy({ name: '會員選單', isDefault: false, switchedFrom: [], listIncomplete: true })
    expect(copy.hasImpact).toBe(true)
    expect(copy.message).toContain('沒辦法確定')
  })
})

describe('buildDeleteConfirmCopy（給圖文選單之後接的通用形狀）', () => {
  it('只有事實、沒有「被誰用到」：事實當開場，後面不再重複名字', () => {
    const copy = buildDeleteConfirmCopy({
      name: '主選單',
      plainMessage: '確定刪除「主選單」？',
      facts: ['「主選單」是所有好友現在看到的選單'],
      effects: ['好友聊天室下方的選單會消失'],
    })
    expect(copy.message).toBe('「主選單」是所有好友現在看到的選單。刪掉之後，好友聊天室下方的選單會消失。')
  })

  it('空名字不會印出「」', () => {
    const copy = buildDeleteConfirmCopy({
      name: '  ',
      plainMessage: 'p',
      groups: [{ countText: '1 個圖文選單', names: [''], effect: 'e' }],
    })
    expect(copy.message).not.toContain('「」')
  })

  it('空的組不算數：全部是空組就是簡單確認', () => {
    const copy = buildDeleteConfirmCopy({
      name: 'x',
      plainMessage: '確定刪除「x」？',
      groups: [{ countText: '0 個圖文選單', names: [], effect: '客人按那些按鈕會沒反應' }],
    })
    expect(copy.hasImpact).toBe(false)
    expect(copy.message).toBe('確定刪除「x」？')
  })
})
