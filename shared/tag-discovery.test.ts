import { describe, expect, it } from 'vitest'
import {
  discoveryScanOutcomeText,
  discoveryState,
  discoveryTiming,
  MAX_PROPOSALS_PER_SCAN,
  MIN_DISTINCT_USERS,
  pickSampleNames,
  normalizeTagName,
  sanitizeDiscoveryProposals,
  sanitizeDiscoveryProposalsDetailed,
  sanitizeTagCode,
  type DiscoveryScanOutcome,
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

/**
 * 守門員刷掉東西要說得出「誰、為什麼」（C-94）。
 *
 * ⛔ 這組存在的理由：08-26 查線上「為什麼提 0 個」時，掃描正常跑完、模型也有回東西，
 * 全部被守門員刷掉——但資料裡一個字都沒留，完全無從查起。
 * `kept` 必須與舊的那支**逐字相同**，否則等於偷偷改了守門標準。
 */
describe('守門員：被刷掉的要留下名字與原因', () => {
  it('kept 與舊介面逐字相同（只多回一份被刷掉的清單，不動判斷標準）', () => {
    const raw = [
      topic(),
      topic({ name: '想送禮', code: 'gift', sessions: [5, 6, 7, 8] }),
      topic({ name: '問過運費', code: 'ship', sessions: [0, 1] }), // 人數不足
    ]
    const ctx = { sessionUserIds: USERS, takenNames: ['抱怨過'] }
    expect(sanitizeDiscoveryProposalsDetailed(raw, ctx).kept).toEqual(sanitizeDiscoveryProposals(raw, ctx))
  })

  it('撞既有名 → duplicate；人數不足 → too_few_users；缺欄位 → incomplete', () => {
    const { kept, dropped } = sanitizeDiscoveryProposalsDetailed([
      topic(), // 撞下面的 takenNames
      topic({ name: '想送禮', code: 'gift', sessions: [0, 1] }),
      topic({ name: '問過運費', code: 'ship', criteria: '' }),
    ], { sessionUserIds: USERS, takenNames: ['在看除濕機'] })

    expect(kept).toHaveLength(0)
    expect(dropped).toEqual([
      { name: '在看除濕機', reason: 'duplicate' },
      { name: '想送禮', reason: 'too_few_users' },
      { name: '問過運費', reason: 'incomplete' },
    ])
  })

  /** ⛔ 舊版在超過上限時直接 break，後面的連名字都沒看過＝「AI 其實提了 5 個」畫面上等於沒發生 */
  it('超過一次上限的那幾條要記成 over_limit，不可以默默消失', () => {
    const raw = ['在看除濕機', '想送禮', '問過運費', '抱怨過', '想找維修'].map((name, i) =>
      topic({ name, code: `c${i}`, sessions: [0, 1, 2, 3, 4] }))
    const { kept, dropped } = sanitizeDiscoveryProposalsDetailed(raw, { sessionUserIds: USERS, takenNames: [] })

    expect(kept).toHaveLength(MAX_PROPOSALS_PER_SCAN)
    expect(dropped).toEqual([
      { name: '抱怨過', reason: 'over_limit' },
      { name: '想找維修', reason: 'over_limit' },
    ])
  })

  it('連名字都沒有的那條不記進清單（「『』因為…被排除」是空話）', () => {
    const { dropped } = sanitizeDiscoveryProposalsDetailed(
      [topic({ name: '' })],
      { sessionUserIds: USERS, takenNames: [] },
    )
    expect(dropped).toEqual([])
  })
})

/**
 * 「按了幾次都沒有新的」到底是哪一種沒有（老闆 2026-08-28 直接問的）。
 *
 * ⛔ 這組釘的是**三種「沒有」不可以印同一句話**：樣本太少（等對話累積）、
 * AI 看完覺得沒主題（這通常就是正確答案）、AI 有提但被擋掉（可以去看是不是擋錯了）
 * ——下一步完全不同，混講等於什麼都沒講。
 */
describe('這次掃描為什麼沒有新的', () => {
  const base: DiscoveryScanOutcome = {
    atMs: 0, kind: 'no_topics', sessionCount: 40, userCount: 31, rawCount: 0, keptCount: 0, dropped: [],
  }

  it('樣本太少 → 講樣本、講門檻，⛔不可以說成「AI 沒找到主題」（LLM 根本沒被呼叫）', () => {
    const t = discoveryScanOutcomeText({ ...base, kind: 'too_few_sessions', sessionCount: 3, userCount: 2 })!
    expect(t).toContain('3 段對話')
    expect(t).toContain(`${MIN_DISTINCT_USERS} 位不同客人`)
    expect(t).not.toContain('AI 沒有找到')
  })

  it('AI 看完覺得沒主題 → 講讀了多少、幾位客人（讓人知道它真的讀了東西）', () => {
    const t = discoveryScanOutcomeText(base)!
    expect(t).toContain('40 段對話')
    expect(t).toContain('31 位客人')
  })

  it('⛔ AI 有提但全被擋掉 → 要講出提了幾個、是哪幾個、為什麼，這是最容易被誤讀成「壞掉」的情況', () => {
    const t = discoveryScanOutcomeText({
      ...base,
      kind: 'all_filtered',
      rawCount: 3,
      dropped: [
        { name: '在看除濕機', reason: 'duplicate' },
        { name: '想送禮', reason: 'duplicate' },
        { name: '問過運費', reason: 'too_few_users' },
      ],
    })!
    expect(t).toContain('3 個主題')
    // 同原因併成一組講，否則三個主題就是三句話
    expect(t).toContain('「在看除濕機、想送禮」')
    expect(t).toContain('「問過運費」')
    expect(t).toContain('已經有相同或很接近的標籤')
  })

  it('⛔ 沒有明細（舊資料）→ 回 null，讓呼叫端退回泛用句，不要硬掰一個原因', () => {
    expect(discoveryScanOutcomeText(null)).toBeNull()
    expect(discoveryScanOutcomeText(undefined)).toBeNull()
  })

  it('細條那行會把明細接在主句後面（有明細就不再印那句泛用的）', () => {
    const NOW = Date.parse('2026-08-28T12:00:00+08:00')
    const s = discoveryState({
      enabled: true,
      lastScanMs: NOW - 86_400_000,
      stalled: false,
      handledThisVisit: false,
      lastScan: { ...base, kind: 'too_few_sessions', sessionCount: 3, userCount: 2 },
      now: NOW,
    })
    expect(s.tone).toBe('idle')
    expect(s.text).toContain('可用的樣本太少')
    expect(s.text).not.toContain('沒有發現足夠明確的新主題')
  })

  it('⛔ 壞掉／太久沒跑仍然優先：有明細也不可以把「一直失敗」講成掃描結果', () => {
    const s = discoveryState({
      enabled: true,
      lastScanMs: 0,
      stalled: true,
      handledThisVisit: false,
      lastScan: base,
    })
    expect(s.tone).toBe('danger')
    expect(s.text).toContain('一直失敗')
    expect(s.text).not.toContain('段對話')
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

describe('證據名字：挑得出「真的有名字」的那幾位', () => {
  it('空字串跳過往後找——LINE 用戶沒設暱稱是常態，不補位的話證據會整段消失', () => {
    expect(pickSampleNames(['', '', '', '王小明', 'Amy', '陳大文'], 3)).toEqual(['王小明', 'Amy', '陳大文'])
  })

  it('undefined／全空白／重複名字都跳過', () => {
    expect(pickSampleNames([undefined, '  ', '王小明', '王小明', 'Amy'], 3)).toEqual(['王小明', 'Amy'])
  })

  it('全部都沒名字 → 回空陣列（呼叫端就不顯示「包括…」那段）', () => {
    expect(pickSampleNames(['', '   ', undefined], 3)).toEqual([])
  })

  it('吃 max 上限', () => {
    expect(pickSampleNames(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
  })
})

describe('標籤頁那行小字：狀態怎麼判（C-68 的沉默死亡不可以再演一次）', () => {
  const NOW = Date.parse('2026-08-25T12:00:00+08:00')
  const base = { enabled: true, lastScanMs: NOW - 86_400_000, stalled: false, handledThisVisit: false, now: NOW }

  it('總開關關著 → 講怎麼開，不講掃描結果', () => {
    const s = discoveryState({ ...base, enabled: false })
    expect(s.tone).toBe('idle')
    expect(s.text).toContain('AI 設定')
  })

  /** 這條是整輪 review 最重要的一項：掃描每輪都炸時 lastScanMs 永遠是 0 */
  it('⛔ 掃描連續失敗且從沒成功過 → 必須講「一直失敗」，不可以講「第一次掃描還沒跑」', () => {
    const s = discoveryState({ ...base, stalled: true, lastScanMs: 0 })
    expect(s.tone).toBe('danger')
    expect(s.text).toContain('一直失敗')
    expect(s.text).not.toContain('還沒跑')
  })

  it('成功過但之後一直失敗 → 一樣講失敗，不講「沒發現新主題」', () => {
    const s = discoveryState({ ...base, stalled: true })
    expect(s.tone).toBe('danger')
    expect(s.text).not.toContain('沒有發現')
  })

  it('從沒掃過（而且沒在失敗）→ 講「第一次還沒跑」', () => {
    const s = discoveryState({ ...base, lastScanMs: 0 })
    expect(s.tone).toBe('idle')
    expect(s.text).toContain('第一次掃描還沒跑')
  })

  it('⛔ 上次成功掃描太久以前 → 要警告，不可以照樣講「這次沒發現主題」', () => {
    const s = discoveryState({ ...base, lastScanMs: NOW - 20 * 86_400_000 })
    expect(s.tone).toBe('warning')
    expect(s.text).toContain('超過兩週')
  })

  it('⛔ 使用者剛把建議處理完 → 不可以說「掃描沒有發現主題」（它有發現，是人處理掉的）', () => {
    const s = discoveryState({ ...base, handledThisVisit: true })
    expect(s.text).toContain('都處理完了')
    expect(s.text).not.toContain('沒有發現')
  })

  it('一切正常、這次真的沒東西 → 才講「沒有發現足夠明確的新主題」', () => {
    const s = discoveryState(base)
    expect(s.tone).toBe('idle')
    expect(s.text).toContain('沒有發現足夠明確的新主題')
  })
})

/**
 * 「上次掃描什麼時候、下次落在哪天」——老闆 2026-08-26 直接提的：
 * 細條上一個時間都沒有，功能看起來像沒在動。
 *
 * 實測當時的真實資料：上次掃描 8/26 14:40、下次 9/2 02:40（6.5 天後），
 * 但畫面上一個字都沒提。這幾條就是釘住那三個數字要講得出來、而且不准硬掰。
 */
describe('細條上的時間：上次掃了沒、下次什麼時候', () => {
  const NOW = Date.parse('2026-08-26T20:00:00+08:00')
  const base = { enabled: true, lastScanMs: Date.parse('2026-08-26T14:40:00+08:00'), now: NOW }

  it('正常情況：講得出上次幾點、下次哪一天、還有幾天', () => {
    const t = discoveryTiming(base)
    expect(t).toContain('今天 14:40')
    expect(t).toContain('9/2') // 上次 ＋ 6.5 天
    expect(t).toContain('天後')
  })

  it('昨天掃的講「昨天」、更早的講日期（不要一律印完整時間戳）', () => {
    expect(discoveryTiming({ ...base, lastScanMs: Date.parse('2026-08-25T09:05:00+08:00') })).toContain('昨天 09:05')
    expect(discoveryTiming({ ...base, lastScanMs: Date.parse('2026-08-21T09:05:00+08:00') })).toContain('8/21 09:05')
  })

  it('⛔ 按過「立即掃描一次」之後，最想知道的是「所以會不會跑」——排隊訊息要蓋過一切', () => {
    const t = discoveryTiming({ ...base, rescanRequestedMs: NOW })
    expect(t).toContain('10 分鐘內')
    expect(t).not.toContain('下次自動掃描') // 排隊中就不要再講一週後那個時間，會互相打架
  })

  it('已經超過該掃的時間、排程還沒撿走 → 講「隨時會跑」，不要印一個過去的日期', () => {
    const t = discoveryTiming({ ...base, lastScanMs: NOW - 8 * 86_400_000 })
    expect(t).toContain('隨時會跑')
  })

  it('⛔ 功能關著 → 不講時間（主句已經在教怎麼開，硬擠一個時間是誤導）', () => {
    expect(discoveryTiming({ ...base, enabled: false })).toBeNull()
  })

  it('⛔ 從沒成功掃過 → 不講時間（沒有誠實的數字可講，不要拿 0 去算出 1970）', () => {
    expect(discoveryTiming({ ...base, lastScanMs: 0 })).toBeNull()
  })

  it('請求標記比上次掃描舊＝那次已經被撿走跑完了，不可以還顯示「排隊中」', () => {
    const t = discoveryTiming({ ...base, rescanRequestedMs: base.lastScanMs - 60_000 })
    expect(t).toContain('上次掃描')
    expect(t).not.toContain('排進佇列')
  })
})
