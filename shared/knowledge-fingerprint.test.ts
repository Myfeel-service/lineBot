import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DETECT_STALLED_ROUNDS,
  decideSourceChange,
  normalizeVolatileNumbers,
  type SourceChangeDecision,
  type SourceDetectState,
} from './knowledge-fingerprint'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const fp = (text: string) => ({ hash: sha(text), textHash: sha(normalizeVolatileNumbers(text)) })

function emptyState(): SourceDetectState {
  return {
    contentHash: '',
    textHash: '',
    appliedContentHash: '',
    observedHash: '',
    observedTextHash: '',
    numericDriftRounds: 0,
    pendingRounds: 0,
  }
}

/**
 * 模擬排程一輪：套用判斷結果並把狀態寫回，跟 cron-maintenance 的寫入規則一致。
 * 測狀態機一定要跑多輪——單輪測不出「永遠卡在 pending」這種只有跨輪才看得到的洞。
 */
function runRound(state: SourceDetectState, text: string): { state: SourceDetectState; decision: SourceChangeDecision } {
  const next = fp(text)
  const decision = decideSourceChange(state, next)
  const s: SourceDetectState = {
    ...state,
    observedHash: next.hash,
    observedTextHash: next.textHash,
    numericDriftRounds: decision.numericDriftRounds,
    pendingRounds: decision.pendingRounds,
  }
  // baseline / unchanged / back-to-applied / numeric-drift / changed 都會推進 contentHash；
  // 只有 pending 刻意不推進（還沒確認的東西不能當成基準）
  if (decision.kind !== 'pending') {
    s.contentHash = next.hash
    s.textHash = next.textHash
  }
  // pending 只做一次性開機：沒有抹數字基準時補上（對齊 cron-maintenance 的寫入規則）
  else if (!s.textHash) s.textHash = next.textHash
  // 卡片被重新整理過才會推進 applied；這裡只測偵測，套用另有流程
  if (decision.kind === 'baseline') s.appliedContentHash = next.hash
  return { state: s, decision }
}

const HOME = `MYFEEL 群眾集資
BOYA mini2 迷你無線 AI 降噪麥克風 NT$1,255,409 12,554% 7天 730人支持
MATELASER W1 REGEN 多波長紅光舒緩儀 NT$1,167,416 2,335% 20天 161人支持
發起專案 產品館 品味誌`

/** 隔天的同一頁：金額、人數往上跳，倒數天數 -1 */
const HOME_TOMORROW = `MYFEEL 群眾集資
BOYA mini2 迷你無線 AI 降噪麥克風 NT$1,262,880 12,628% 6天 742人支持
MATELASER W1 REGEN 多波長紅光舒緩儀 NT$1,180,003 2,360% 19天 164人支持
發起專案 產品館 品味誌`

const HOME_DAY3 = `MYFEEL 群眾集資
BOYA mini2 迷你無線 AI 降噪麥克風 NT$1,301,455 13,014% 5天 771人支持
MATELASER W1 REGEN 多波長紅光舒緩儀 NT$1,199,870 2,399% 18天 170人支持
發起專案 產品館 品味誌`

describe('normalizeVolatileNumbers', () => {
  it('只有數字在動的兩份內容，抹掉數字後完全一樣', () => {
    expect(normalizeVolatileNumbers(HOME)).toBe(normalizeVolatileNumbers(HOME_TOMORROW))
  })

  it('文字改了就一定不一樣', () => {
    const changed = HOME.replace('發起專案 產品館 品味誌', '發起專案 產品館 品味誌 退換貨政策：到貨後 7 天內可申請')
    expect(normalizeVolatileNumbers(HOME)).not.toBe(normalizeVolatileNumbers(changed))
  })

  it('吃全形數字與百分比', () => {
    expect(normalizeVolatileNumbers('售價 １２３４ 元，達成 87.5%')).toBe('售價 # 元，達成 #')
  })
})

describe('decideSourceChange — 集資首頁（數字天天在動）', () => {
  it('學會數字會自己跑之後就不再吵，而且不會卡在 pending', () => {
    let s = emptyState()
    ;({ state: s } = runRound(s, HOME)) // 第一輪：建立基準

    const d2 = runRound(s, HOME_TOMORROW)
    s = d2.state
    expect(d2.decision.kind).toBe('pending') // 還沒學會，先等一輪

    const d3 = runRound(s, HOME_DAY3)
    s = d3.state
    expect(d3.decision.kind).toBe('numeric-drift') // 連兩輪只有數字在動 → 認定是計數器
    expect(d3.decision.numbersVolatile).toBe(true)
    expect(d3.decision.pendingRounds).toBe(0)

    // 再跑幾輪都該保持安靜，而且永遠不會累積成 stalled
    for (const day of [4, 5, 6]) {
      const text = HOME.replace(/730人支持/, `${730 + day * 13}人支持`).replace(/7天/, `${7 - day}天`)
      const r = runRound(s, text)
      s = r.state
      expect(r.decision.kind).toBe('numeric-drift')
      expect(r.decision.stalled).toBe(false)
    }
  })

  it('學會之後，文字真的改版仍然照常提醒', () => {
    let s = emptyState()
    ;({ state: s } = runRound(s, HOME))
    ;({ state: s } = runRound(s, HOME_TOMORROW))
    ;({ state: s } = runRound(s, HOME_DAY3)) // 已學會

    const REVISED = `${HOME_DAY3}\n退換貨政策更新：到貨後 7 天內可申請退換，需保持包裝完整。`
    const r1 = runRound(s, REVISED)
    s = r1.state
    expect(r1.decision.kind).toBe('pending') // 文字變了，先等一輪確認

    // 隔天數字又動了一點，但文字是同一份新版本 → 確認變動
    const r2 = runRound(s, REVISED.replace('771人支持', '790人支持'))
    expect(r2.decision.kind).toBe('changed')
  })
})

describe('decideSourceChange — 一般商品頁（數字平常不動）', () => {
  const PAGE = '嬰兒揹帶 售價 NT$3,280 庫存充足 免運費'
  const PRICE_CHANGED = '嬰兒揹帶 售價 NT$3,680 庫存充足 免運費'

  it('改價會被當成真變動提醒（不會被數字正規化吃掉）', () => {
    let s = emptyState()
    ;({ state: s } = runRound(s, PAGE))

    const r1 = runRound(s, PRICE_CHANGED)
    s = r1.state
    expect(r1.decision.kind).toBe('pending') // 第一次看到新價格：等下一輪確認

    const r2 = runRound(s, PRICE_CHANGED)
    expect(r2.decision.kind).toBe('changed') // 連兩輪都是這個價 → 確認
    expect(r2.decision.numbersVolatile).toBe(false)
  })

  it('內容跳回原樣（假變動）不會被誤報', () => {
    let s = emptyState()
    ;({ state: s } = runRound(s, PAGE))
    ;({ state: s } = runRound(s, PRICE_CHANGED)) // pending
    const r = runRound(s, PAGE) // 又跳回原值
    expect(r.decision.kind).toBe('unchanged')
    expect(r.decision.pendingRounds).toBe(0)
  })
})

describe('decideSourceChange — 每輪連文字都不一樣的網址', () => {
  it('卡滿門檻輪數就標成 stalled，不再無聲無息', () => {
    // 隨機推薦區塊：每次抓到的文章標題都不同（不是數字在動，是文字在動）
    const picks = ['貓砂推薦', '手沖咖啡入門', '降噪耳機選購', '護眼檯燈比較', '登山背包挑選']
    let s = emptyState()
    ;({ state: s } = runRound(s, '你可能也喜歡 空氣清淨機開箱'))

    let last: SourceChangeDecision | null = null
    for (let i = 0; i < DETECT_STALLED_ROUNDS; i++) {
      const r = runRound(s, `你可能也喜歡 ${picks[i]}`)
      s = r.state
      last = r.decision
      expect(r.decision.kind).toBe('pending')
    }
    expect(last?.stalled).toBe(true)
    expect(last?.pendingRounds).toBe(DETECT_STALLED_ROUNDS)
  })
})

describe('decideSourceChange — 舊來源相容', () => {
  it('沒有抹數字基準時退回原本的逐字比對，不會憑空冒出一次假變動', () => {
    // 舊資料：只有 contentHash（欄位是後來才加的），observedHash 沿用 pendingHash
    const legacy: SourceDetectState = { ...emptyState(), contentHash: sha(HOME), appliedContentHash: sha(HOME) }

    const r1 = decideSourceChange(legacy, fp(HOME_TOMORROW))
    expect(r1.kind).toBe('pending') // 沒有上一輪可比 → 先建立基準（與舊行為相同）

    // 補上上一輪觀測後、文字基準仍空 → 照舊逐字比對
    const r2 = decideSourceChange(
      { ...legacy, observedHash: sha(HOME_TOMORROW), pendingRounds: 1 },
      fp(HOME_TOMORROW),
    )
    expect(r2.kind).toBe('changed')
  })

  it('第一次觀測（連 contentHash 都沒有）只存基準', () => {
    expect(decideSourceChange(emptyState(), fp(HOME)).kind).toBe('baseline')
  })

  /**
   * 這是線上正式站真正的處境：MYFEEL 首頁已經在「等下一輪確認」卡了不知道多久，
   * 沒有 textHash、pendingHash 停在昨天的值。修法要能把它救出來，不能只對新來源有效。
   */
  it('早就卡在黑洞裡的舊來源，三輪之內脫困並停止誤判', () => {
    let s: SourceDetectState = {
      ...emptyState(),
      contentHash: sha('很久以前確認過的版本'),
      appliedContentHash: sha('很久以前確認過的版本'),
      observedHash: sha(HOME), // 舊欄位 pendingHash 對映過來的
    }

    const r1 = runRound(s, HOME_TOMORROW)
    s = r1.state
    expect(r1.decision.kind).toBe('pending') // 還沒有抹數字基準 → 退回舊行為，順便開機

    const r2 = runRound(s, HOME_DAY3)
    s = r2.state
    expect(r2.decision.kind).toBe('pending') // 有基準了，開始數「只有數字在動」的輪數

    const r3 = runRound(s, HOME_TOMORROW.replace('742人支持', '801人支持'))
    expect(r3.decision.kind).toBe('numeric-drift') // 第三輪學會 → 從此安靜
    expect(r3.decision.stalled).toBe(false) // 全程沒卡到「偵測失效」那一格
  })
})
