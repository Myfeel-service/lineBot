/**
 * 網址來源「內容有沒有變」的判斷核心（純函式，方便單獨測試）。
 *
 * 為什麼要有這一支——2026-08-11 從正式 MYFEEL 的 `https://www.myfeel-tw.com/` 挖出來的洞：
 * 原本的規則是「連兩輪抓到**一模一樣**的新內容才算真的變」，用來擋輪播／隨機推薦的假變動。
 * 但那個首頁上有集資金額、支持人數、倒數天數，**每天都在動**——於是每一輪抓到的都是全新的
 * 內容，永遠湊不出「連兩輪一樣」，`outdatedAt` 永遠不會被標上。畫面只顯示「最後同步 N 小時前」
 * 看起來一切正常，官網真的改版也不會有人知道，是最糟的那種假綠燈。
 *
 * 修法不是「放寬差異比例」——量過了，行不通：那個首頁只有數字在動時整體差異 18.4%，
 * 真的改版（多一段退換貨政策）反而只有 5.6%。**噪音比訊號還大三倍**，門檻設在哪裡都會錯。
 *
 * 改成兩道指紋：
 *   - `hash`     ：逐字指紋（原本就有的 contentHash）
 *   - `textHash` ：**把數字抹掉之後**的指紋 → 只有數字在動時，這道指紋完全不變
 * 再加一件事：先看這個網址的數字**平常會不會自己動**。
 *   - 天天在動（集資金額、支持人數、倒數）→ 認定是噪音，只在文字內容改變時才提醒。
 *   - 平常不動（一般商品頁）→ 數字一改就提醒，價格調整不會漏掉。
 * 學這件事只要兩輪；學不會（連文字都每輪不同）的網址會被標成 stalled，由 UI 明講
 * 「自動偵測對這個網址無效」，而不是繼續沉默。
 */

/** 連續幾輪「文字沒變、只有數字在動」就認定這個網址的數字本來就會自己跑 */
export const NUMERIC_DRIFT_LEARN_ROUNDS = 2

/** 連續幾輪停在「等下一輪確認」就認定自動偵測對這個網址無效，改由 UI 明講 */
export const DETECT_STALLED_ROUNDS = 3

/**
 * 把「會自己跑的數字」正規化掉：連續的數字（含千分位逗號、小數點、百分號）一律換成 `#`。
 *
 * 全形數字也吃（部分網站的價格用全形排版）。刻意**不**只針對金額或人數——
 * 想靠語意挑出「哪些數字是計數器」必然掛一漏萬，抹掉全部再靠「這頁的數字平常動不動」
 * 來決定要不要理它，規則簡單而且解釋得通。
 *
 * 代價講在明處：網址裡的編號（`/projects/SNGRF-2601`）也會被抹掉，所以「只有品號尾數改變」
 * 這種變動在已判定為數字會跑的網址上偵測不到。判定為數字不會跑的網址則照樣抓得到。
 */
export function normalizeVolatileNumbers(text: string): string {
  return String(text ?? '').replace(/[0-9０-９][0-9０-９,，.．]*[%％]?/g, '#')
}

/** 這一輪判斷要用到的、來源文件上既有的狀態 */
export interface SourceDetectState {
  /** 上一次「確認過／已處理」的逐字指紋 */
  contentHash: string
  /** 上一次「確認過／已處理」的抹數字指紋。舊來源沒有這一欄（''）＝沒有基準 */
  textHash: string
  /** 目前這批知識卡是從哪一版內容切出來的 */
  appliedContentHash: string
  /** 上一輪抓到的逐字指紋（舊來源相容：沿用 pendingHash） */
  observedHash: string
  /** 上一輪抓到的抹數字指紋 */
  observedTextHash: string
  /** 已連續幾輪「文字沒變、只有數字在動」 */
  numericDriftRounds: number
  /** 已連續幾輪停在「等下一輪確認」 */
  pendingRounds: number
}

export type SourceChangeKind =
  /** 第一次觀測，只存基準，不算變動 */
  | 'baseline'
  /** 跟上次確認過的版本逐字相同 */
  | 'unchanged'
  /** 改過又改回卡片那一版＝沒有東西要店家決定 */
  | 'back-to-applied'
  /** 只有「本來就會自己跑」的數字在動 */
  | 'numeric-drift'
  /** 跟上次不同，等下一輪確認 */
  | 'pending'
  /** 確認變動 */
  | 'changed'

export interface SourceChangeDecision {
  kind: SourceChangeKind
  numericDriftRounds: number
  pendingRounds: number
  /** 已學會：這個網址的數字本來就會自己跑，純數字變動不再提醒 */
  numbersVolatile: boolean
  /** 卡在「等下一輪確認」太多輪＝自動偵測對這個網址無效，要在 UI 明講 */
  stalled: boolean
}

function pending(prev: SourceDetectState, numericDriftRounds: number): SourceChangeDecision {
  const pendingRounds = prev.pendingRounds + 1
  return {
    kind: 'pending',
    numericDriftRounds,
    pendingRounds,
    numbersVolatile: false,
    stalled: pendingRounds >= DETECT_STALLED_ROUNDS,
  }
}

/** 有明確結論的那幾種：計數器歸零，stalled 解除 */
function settled(kind: SourceChangeKind): SourceChangeDecision {
  return { kind, numericDriftRounds: 0, pendingRounds: 0, numbersVolatile: false, stalled: false }
}

/**
 * 這一輪抓到的內容該怎麼處理。純函式：不碰 Firestore，呼叫端負責把結論寫回去。
 */
export function decideSourceChange(
  prev: SourceDetectState,
  next: { hash: string; textHash: string },
): SourceChangeDecision {
  // 首次觀測（匯入時前端沒帶 hash）：只存基準，內容並沒有「變」。
  // 沒有這一段的話每個新網址第一次排程必被誤報，狼來了幾次就沒人理警示了。
  if (!prev.contentHash) return settled('baseline')

  if (prev.contentHash === next.hash) return settled('unchanged')

  // 改過又改回卡片對應的那一版 → 沒有任何東西要店家決定
  if (prev.appliedContentHash && prev.appliedContentHash === next.hash) return settled('back-to-applied')

  // 還沒有「上一輪」可以比 → 先建立基準再說（＝原本 pendingHash 為空時的行為）
  if (!prev.observedHash) return pending(prev, prev.numericDriftRounds)

  const hasTextBase = Boolean(prev.textHash)

  if (hasTextBase && prev.textHash === next.textHash) {
    // 文字一個字都沒改，動的只有數字
    if (prev.observedHash === next.hash) {
      // 連兩輪拿到同一組新數字＝數字停下來了，這是有人改過（例如調價），不是計數器
      return settled('changed')
    }
    const rounds = prev.numericDriftRounds + 1
    if (rounds >= NUMERIC_DRIFT_LEARN_ROUNDS) {
      return { kind: 'numeric-drift', numericDriftRounds: rounds, pendingRounds: 0, numbersVolatile: true, stalled: false }
    }
    return pending(prev, rounds)
  }

  // 文字變了（或舊來源還沒有抹數字基準 → 退回原本的逐字比對，行為不變）：
  // 一樣要連兩輪拿到同一份新內容才算數，擋輪播／隨機區塊。
  const sameAsLastRound = hasTextBase
    ? prev.observedTextHash === next.textHash
    : prev.observedHash === next.hash
  if (sameAsLastRound) return settled('changed')

  // 文字自己在變 → 數字漂移的計數沒有意義，歸零重算
  return pending(prev, 0)
}
