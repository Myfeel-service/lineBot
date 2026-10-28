/**
 * 好友統計「接下來該做什麼」（`D-155`）的測試。
 *
 * 資料用 MYFEEL 2026-10-28 唯讀盤點的真實數字（窗口 9/28–10/27）：
 * 在看咖啡機新增 40（前 30 天 14）、在看 AI 錄音耳機 25（20）、在等開賣 24（33）、退換貨處理中 62（37）；
 * 推播那兩天各封鎖 29 位、平常約 10 位；小滑手名單 5 天後第二則打開 36% → 22%。
 * 示意頁（畫布 `9FNfkaT1yCCRQjB9KStPLd`）畫的就是這份資料會長出來的樣子。
 *
 * ⛔ 每一條門檻都配一條「差一點就不出」的對照，拿掉門檻測試要會紅。
 */
import { describe, expect, it } from 'vitest'
import {
  buildProposals,
  buildWatchItems,
  isBlockSpike,
  pickProposalFestival,
  proposalOutcomeText,
  proposalsEmptyText,
  unclassifiedHint,
} from './friend-report-advice'
import { reportWindow, type FriendReportPayload, type IntentTagStat, type PushRow } from './friend-report'
import { TAIWAN_FESTIVALS } from './taiwan-festivals'

const NOW = Date.parse('2026-10-28T14:49:00+08:00')
const at = (taipei: string) => Date.parse(`${taipei}+08:00`)

function intent(
  tagId: string,
  name: string,
  category: IntentTagStat['category'],
  members: number,
  recent: number,
  prev: number,
  notPushedRecent: number | null = 0,
  pushedWithin7d: number | null = 0,
): IntentTagStat {
  return { tagId, name, category, members, recent, prev, notPushedRecent, pushedWithin7d }
}

const MYFEEL_INTENTS: IntentTagStat[] = [
  intent('shipping', '問過出貨進度', 'behavior', 141, 71, 66),
  intent('returns', '退換貨處理中', 'behavior', 100, 62, 37),
  intent('coffee', '在看咖啡機', 'interest', 55, 40, 14, 22),
  intent('price', '問過價格優惠', 'behavior', 68, 36, 32),
  intent('complain', '抱怨過', 'member_status', 53, 27, 24),
  intent('earbuds', '在看 AI 錄音耳機', 'interest', 45, 25, 20, 31),
  intent('waiting', '在等開賣', 'interest', 57, 24, 33, 32),
  intent('mic', '在看收音麥克風', 'interest', 25, 18, 7, 21),
]

/** 9/28–10/27 每天 10 位，推播那幾天照實際 */
function myfeelBlocks(): Record<string, number> {
  const out: Record<string, number> = {}
  for (let t = Date.parse('2026-09-28T00:00:00Z'); t <= Date.parse('2026-10-27T00:00:00Z'); t += 86_400_000) {
    out[new Date(t).toISOString().slice(0, 10)] = 10
  }
  return { ...out, '2026-09-29': 29, '2026-09-30': 30, '2026-10-01': 14, '2026-10-04': 29, '2026-10-05': 16, '2026-10-15': 15 }
}

const aud = (tagId: string, name: string): PushRow['audience'] => ({ type: 'tags', tagIds: [tagId], tagNames: [name], label: name })

function push(id: string, name: string, when: string, sent: number, opened: number | null, over: Partial<PushRow> = {}): PushRow {
  return {
    id, name, completedMs: at(when), audience: aud('gl', '問卷_珈樂堤_小滑手'),
    sent, opened, clicked: null, proposalTagId: null, prevOpen: null, ...over,
  }
}

const MYFEEL_PUSHES: PushRow[] = [
  push('p7', '乾淨方MAX-集資結束推播10/15', '2026-10-15T12:00:00', 819, 110, { audience: aud('max', '問卷 - 乾淨方MAX') }),
  push('p6', '水多會-超早鳥倒數', '2026-10-05T12:00:00', 461, 74, {
    audience: aud('yimi', '問卷-宜米-製冰咖啡飲水機'),
    prevOpen: { name: '水都會_開賣', completedMs: at('2026-10-01T12:00:00'), openRate: 0.2328 },
  }),
  push('p5', '小滑手_超早鳥倒數', '2026-10-04T12:00:00', 2165, 466, {
    prevOpen: { name: '小滑手_開賣', completedMs: at('2026-09-29T12:00:00'), openRate: 0.3594 },
  }),
  push('p4', '電淨艙_超早鳥倒數', '2026-10-04T12:00:00', 1592, 252, {
    audience: aud('chimei', '問卷_奇美_電淨艙'),
    prevOpen: { name: '電淨艙_開賣', completedMs: at('2026-09-29T12:00:00'), openRate: 0.2436 },
  }),
  push('p3', '水都會_開賣', '2026-10-01T12:00:00', 464, 108, { audience: aud('yimi', '問卷-宜米-製冰咖啡飲水機') }),
  push('p2', '小滑手_開賣', '2026-09-29T12:00:00', 2187, 786),
  push('p1', '電淨艙_開賣', '2026-09-29T12:00:00', 1613, 393, { audience: aud('chimei', '問卷_奇美_電淨艙') }),
]

function payload(over: Partial<FriendReportPayload> = {}): FriendReportPayload {
  return {
    version: 2,
    generatedAtMs: NOW,
    window: reportWindow(NOW),
    integrity: {
      failed: [], userTagsTruncated: false, scannedUserTags: 9404, suggestionLogsTruncated: false,
      pendingTruncated: false, newMembersTruncated: false, suggestionLedgerSince: '2026-08-30',
    },
    overview: {
      line: { status: 'ok', followers: 121370, followersDelta: 1282, blocks: 28744, blocksDelta: 353, asOfDate: '2026-10-27', blocksByDay: myfeelBlocks() },
      activeUsers: 811,
      listSize: 10810,
    },
    intents: MYFEEL_INTENTS,
    intentPairs: [
      { a: 'shipping', b: 'returns', users: 15 },
      { a: 'complain', b: 'returns', users: 11 },
      { a: 'coffee', b: 'price', users: 7 },
      { a: 'coffee', b: 'waiting', users: 7 },
      { a: 'earbuds', b: 'mic', users: 5 },
    ],
    pushes: MYFEEL_PUSHES,
    newMembers: { total: 1572, truncated: false, rows: [] },
    upcomingFestival: { id: 'double11-2026', name: '雙 11 購物節', date: '2026-11-11' },
    housekeeping: {
      zeroMember: [], aiOnButNeverProduced: [], untaggedUsers: 3229,
      suggestions: { decided: 142, agreed: 121, autoApplied: 552, acceptanceRate: 85.2 }, pendingUsers: 0,
    },
    ...over,
  }
}

describe('行銷提案：挑誰', () => {
  it('MYFEEL：在看咖啡機、在看 AI 錄音耳機兩則（最近新增最多的兩群「興趣偏好」）', () => {
    const out = buildProposals(payload())
    expect(out.map(p => p.tagName)).toEqual(['在看咖啡機', '在看 AI 錄音耳機'])
  })

  it('提案講得出發給誰、為什麼、什麼時候（數字全是程式算的）', () => {
    const [coffee] = buildProposals(payload())
    expect(coffee).toMatchObject({
      title: '雙 11 購物節前，發一則給「在看咖啡機」的 55 位',
      who: '在看咖啡機 55 位，其中 22 位最近 30 天沒收過任何推播',
      why: '最近 30 天新增 40 位，前 30 天 14 位；其中 7 位也有「在等開賣」',
      when: '雙 11 購物節（11/11）前',
    })
  })

  it('⛔ 理由只引用其他「興趣偏好」：客訴、故障、出貨不可以當成推銷的理由（MYFEEL 實跑抓到的）', () => {
    const p = payload({
      intentPairs: [
        { a: 'earbuds', b: 'defect', users: 9 },
        { a: 'earbuds', b: 'mic', users: 5 },
      ],
      intents: [...MYFEEL_INTENTS, intent('defect', '回報過商品故障', 'behavior', 48, 18, 28)],
    })
    const earbuds = buildProposals(p).find(x => x.tagId === 'earbuds')!
    expect(earbuds.why).toBe('最近 30 天新增 25 位，前 30 天 20 位；其中 5 位也有「在看收音麥克風」')
    expect(earbuds.why).not.toContain('故障')
  })

  it('⛔ 消費行為／好友狀態（出貨、退換貨）不提案——那是要照顧的人，不是要推銷的人', () => {
    const out = buildProposals(payload())
    expect(out.map(p => p.tagId)).not.toContain('returns')
    expect(out.map(p => p.tagId)).not.toContain('shipping')
  })

  it('最近新增不到 10 位不提（對照：剛好 10 位就提）', () => {
    const nine = payload({ intents: [intent('a', 'A', 'interest', 30, 9, 0)] })
    const ten = payload({ intents: [intent('a', 'A', 'interest', 30, 10, 0)] })
    expect(buildProposals(nine)).toEqual([])
    expect(buildProposals(ten)).toHaveLength(1)
  })

  it('⛔ 這群人一半以上 7 天內收過推播就不提——連著發，封鎖的人會變多（對照：不到一半照提）', () => {
    const half = payload({ intents: [intent('a', 'A', 'interest', 40, 20, 5, 10, 20)] })
    const less = payload({ intents: [intent('a', 'A', 'interest', 40, 20, 5, 10, 19)] })
    expect(buildProposals(half)).toEqual([])
    expect(buildProposals(less)).toHaveLength(1)
  })

  it('最多兩則', () => {
    const many = payload({ intents: [1, 2, 3, 4].map(i => intent(`t${i}`, `T${i}`, 'interest', 50, 10 + i, 0)) })
    expect(buildProposals(many)).toHaveLength(2)
  })

  it('沒有檔期：標題不提檔期、時機寫「這週就可以」', () => {
    const [coffee] = buildProposals(payload({ upcomingFestival: null }))
    expect(coffee!.title).toBe('發一則給「在看咖啡機」的 55 位')
    expect(coffee!.when).toBe('這週就可以')
  })

  it('推播讀不到時不講「沒收過推播」（⛔ 不當成都沒收過）', () => {
    const p = payload({ intents: [intent('coffee', '在看咖啡機', 'interest', 55, 40, 14, null, null)] })
    expect(buildProposals(p)[0]!.who).toBe('在看咖啡機 55 位')
  })

  it('⛔ 檔期已經過了就不搭（C-404：10/28 的報告 11/15 才看，不可以還說「雙 11 前」）；當天還算', () => {
    const [late] = buildProposals(payload(), '2026-11-15')
    expect(late!.title).toBe('發一則給「在看咖啡機」的 55 位')
    expect(late!.festival).toBeNull()
    expect(buildProposals(payload(), '2026-11-11')[0]!.festival?.id).toBe('double11-2026')
  })

  it('⛔ 讀不到標籤資料時不提案，講「這次讀不到」（不說成沒標籤或量不夠）', () => {
    const p = payload({ integrity: { ...payload().integrity, userTagsFailed: true } })
    expect(buildProposals(p)).toEqual([])
    expect(proposalsEmptyText(p)).toBe('這次讀不到標籤資料，提案先空著，重新產生一次看看。')
    expect(buildWatchItems(p).filter(w => w.kind === 'rising')).toEqual([])
  })
})

describe('還沒設分類的 AI 標籤（C-404：標籤頁新建的預設是「自訂」）', () => {
  const custom = intent('c1', '在看咖啡機', 'custom', 55, 40, 14)

  it('⛔ 不拿去提案、也不當成要留意的服務訊號——不知道它是想買還是在抱怨', () => {
    const p = payload({ intents: [custom] })
    expect(buildProposals(p)).toEqual([])
    expect(buildWatchItems(p).filter(w => w.kind === 'rising')).toEqual([])
  })

  it('講清楚設成「興趣偏好」就會提案', () => {
    const t = unclassifiedHint(payload({ intents: [custom] }))
    expect(t).toContain('「在看咖啡機」')
    expect(t).toContain('分類是「自訂」')
    expect(t).toContain('設成「興趣偏好」')
  })

  it('量不夠、或已經分好類的不提醒（對照組）', () => {
    expect(unclassifiedHint(payload({ intents: [intent('c1', 'A', 'custom', 9, 9, 0)] }))).toBeNull()
    expect(unclassifiedHint(payload())).toBeNull()
  })
})

describe('沒有提案時講為什麼（三種原因三句話）', () => {
  it('沒有任何意圖標籤', () => {
    expect(proposalsEmptyText(payload({ intents: [] }))).toContain('還沒有標籤開 AI 判斷')
  })

  it('量不夠', () => {
    expect(proposalsEmptyText(payload({ intents: [intent('a', 'A', 'interest', 30, 3, 0)] }))).toContain('新增到 10 位以上')
  })

  it('剛發過：點名是哪幾群', () => {
    const t = proposalsEmptyText(payload({ intents: [intent('a', '在看咖啡機', 'interest', 40, 20, 5, 0, 30)] }))
    expect(t).toContain('「在看咖啡機」最近 7 天才收過推播')
  })
})

describe('提案搭哪一檔', () => {
  it('10/28：萬聖節（3 天後）來不及準備、跳過；搭雙 11（14 天後）', () => {
    expect(pickProposalFestival(TAIWAN_FESTIVALS, '2026-10-28', {})?.id).toBe('double11-2026')
  })

  it('他把雙 11 收起來了就不搭（聖誕節 58 天後太遠，也不搭）', () => {
    expect(pickProposalFestival(TAIWAN_FESTIVALS, '2026-10-28', { 'double11-2026': 1 })).toBeNull()
  })

  it('店家自己的檔期也算，取最近的那一檔', () => {
    const own = { id: 'own-anniv', date: '2026-11-05', name: '週年慶', angle: '', own: true }
    expect(pickProposalFestival([...TAIWAN_FESTIVALS, own], '2026-10-28', {})?.name).toBe('週年慶')
  })
})

describe('也要留意', () => {
  it('MYFEEL：退換貨變多＋推播那天封鎖是平常的 3 倍，兩件', () => {
    const items = buildWatchItems(payload())
    expect(items.map(w => w.kind)).toEqual(['rising', 'push'])
  })

  it('服務類訊號：退換貨 62（前 30 天 37）→ 講出來，附上一起出現最多的那一顆', () => {
    const [rising] = buildWatchItems(payload())
    expect(rising).toMatchObject({
      title: '「退換貨處理中」的人變多了',
      why: '最近 30 天新增 62 位，前 30 天 37 位；其中 15 位也有「問過出貨進度」。',
      action: { type: 'users', tagId: 'returns', label: '看這 100 位' },
    })
  })

  it('沒有多一半以上不講（問過出貨 71 vs 66 是常態）；前 30 天是 0 也算變多', () => {
    const steady = payload({ intents: [intent('ship', '問過出貨進度', 'behavior', 141, 71, 66)] })
    const fresh = payload({ intents: [intent('defect', '回報過商品故障', 'behavior', 12, 12, 0)] })
    expect(buildWatchItems(steady).filter(w => w.kind === 'rising')).toEqual([])
    expect(buildWatchItems(fresh)[0]?.title).toBe('「回報過商品故障」的人變多了')
  })

  it('推播那天封鎖：哪幾天、平常幾位、同一群人第二則打開掉多少（同一句講完）', () => {
    const pushItem = buildWatchItems(payload()).find(w => w.kind === 'push')!
    expect(pushItem.title).toBe('推播那天，封鎖的人是平常的 3 倍')
    expect(pushItem.why).toBe('9/29、10/4 各封鎖 29 位，平常一天約 10 位。「問卷_珈樂堤_小滑手」5 天後收到第二則，打開的比例從 36% 掉到 22%。')
  })

  it('⛔ 打開掉不到 10 個百分點的不講（電淨艙 24% → 16%）', () => {
    const only = payload({ pushes: MYFEEL_PUSHES.filter(r => r.id === 'p4'), overview: { ...payload().overview, line: { ...payload().overview.line, blocksByDay: {} } } })
    expect(buildWatchItems(only).filter(w => w.kind === 'push')).toEqual([])
  })

  it('封鎖沒有跳、但打開掉很多 → 只講打開', () => {
    const flat = payload({ overview: { ...payload().overview, line: { ...payload().overview.line, blocksByDay: {} } } })
    const item = buildWatchItems(flat).find(w => w.kind === 'push')!
    expect(item.title).toBe('同一群人連著收，打開的人變少了')
  })

  it('⛔ 平常不到 1 位封鎖時不講倍數（0 位 vs 3 位的「倍數」沒有意義）', () => {
    const quiet: Record<string, number> = {}
    for (const d of Object.keys(myfeelBlocks())) quiet[d] = 0
    quiet['2026-09-29'] = 6
    const p = payload({ pushes: [MYFEEL_PUSHES[6]!], overview: { ...payload().overview, line: { ...payload().overview.line, blocksByDay: quiet } } })
    expect(buildWatchItems(p).filter(w => w.kind === 'push')).toEqual([])
  })

  it('⛔ 這一則發完還不到 7 天不拿去比打開（數字還在長，比了一定「掉很多」，C-404）', () => {
    const young = payload({
      generatedAtMs: at('2026-10-08T12:00:00'),
      overview: { ...payload().overview, line: { ...payload().overview.line, blocksByDay: {} } },
    })
    expect(buildWatchItems(young).filter(w => w.kind === 'push')).toEqual([])
    // 對照組：同一份資料、滿 7 天之後就會講
    const mature = payload({ overview: { ...payload().overview, line: { ...payload().overview.line, blocksByDay: {} } } })
    expect(buildWatchItems(mature).filter(w => w.kind === 'push')).toHaveLength(1)
  })

  it('封鎖跳起來的判斷：表格與這一條共用（平常不到 1 位不講、要 2 倍以上且至少 5 位）', () => {
    expect(isBlockSpike(29, 10)).toBe(true)
    expect(isBlockSpike(19, 10)).toBe(false)
    expect(isBlockSpike(4, 1)).toBe(false)
    expect(isBlockSpike(6, 0)).toBe(false)
    expect(isBlockSpike(undefined, 10)).toBe(false)
  })

  it('沒有推播就沒有推播那一條', () => {
    expect(buildWatchItems(payload({ pushes: [] })).filter(w => w.kind === 'push')).toEqual([])
    expect(buildWatchItems(payload({ pushes: null })).filter(w => w.kind === 'push')).toEqual([])
  })
})

describe('上次照提案發的成績', () => {
  it('最近 30 天沒有照提案發過 → 不講', () => {
    expect(proposalOutcomeText(payload())).toBeNull()
  })

  it('有的話講打開、點連結，跟其他推播的打開比例比', () => {
    const mine = push('mine', '在看咖啡機・雙 11 購物節', '2026-10-20T12:00:00', 55, 20, { clicked: 9, proposalTagId: 'coffee' })
    const t = proposalOutcomeText(payload({ pushes: [mine, MYFEEL_PUSHES[1]!, MYFEEL_PUSHES[5]!] }))
    expect(t).toBe('上次照提案發的「在看咖啡機・雙 11 購物節」（10/20）：打開 36%、點連結 16%；最近 30 天其他推播打開 16%–36%。')
  })

  it('⛔ 提案那則發完還不到 7 天：講數字還會再長，而且只跟已經滿 7 天的推播比（C-404）', () => {
    const mine = push('mine', '在看咖啡機', '2026-10-26T12:00:00', 55, 15, { proposalTagId: 'coffee' })
    const youngOther = push('y', '另一則剛發的', '2026-10-27T12:00:00', 100, 5)
    const t = proposalOutcomeText(payload({ pushes: [youngOther, mine, MYFEEL_PUSHES[1]!, MYFEEL_PUSHES[5]!] }))
    expect(t).toBe('上次照提案發的「在看咖啡機」（10/26）：打開 27%（發完還不到 7 天，打開的人還會再多一些）；最近 30 天其他推播打開 16%–36%。')
  })

  it('LINE 還沒給數字時講什麼時候才有，⛔ 不寫 0%', () => {
    const mine = push('mine', '在看咖啡機', '2026-10-27T20:00:00', 55, null, { proposalTagId: 'coffee' })
    expect(proposalOutcomeText(payload({ pushes: [mine] }))).toBe('上次照提案發的「在看咖啡機」（10/27）：LINE 還沒給打開人數，發完隔天才有。')
  })
})
