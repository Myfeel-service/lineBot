/**
 * 對話內容搜尋：訊息要怎麼切成「可搜尋的片段」。
 *
 * ## 為什麼不是直接用 Firestore 查文字
 *
 * Firestore 沒有全文檢索。`where('text', '>=', kw)` 只比得到**開頭**，但客服要找的
 * 永遠是句子中間那幾個字（「上次那個問退貨的客人是誰」）。唯一能做到「精準、而且
 * 讀取量跟結果數成正比」的辦法，是寫入時就把每則訊息切成固定長度的片段存成陣列，
 * 查詢時用 `array-contains` 打其中一個片段，再在記憶體裡驗整段關鍵字。
 *
 * 對照組（被否決的做法）：用 collectionGroup 掃最近 N 則訊息、在記憶體裡比字串。
 * 那個一秒就能寫完，但每次搜尋都要付 N 次讀取，而 N 就是涵蓋範圍——想找得到三個月前
 * 那句話就得掃幾十萬則。忙的帳號打一次搜尋只涵蓋最近幾天，而且畫面上看不出來少了什麼
 * （這種「沉默的沒有」這個專案付過太多次帳）。
 *
 * ## 為什麼是「兩個字一組」而不是分詞
 *
 * 中文沒有空白，任何分詞器都會在商品名上切錯（「威技」「上好ㄟ」「MiniMe」），
 * 切錯就是那個詞永遠搜不到——而那些正是客服最常搜的字。兩個字一組（bigram）不需要
 * 懂語意，天生支援「詞的中間」命中；英數同樣適用（order → or/rd/de/er），
 * 所以中英夾雜的訊息用同一套規則就吃完了，不必維護兩條路。
 *
 * 代價：一個字的關鍵字查不到（沒有兩字片段可打）。這是刻意的——單字的命中率高到
 * 沒有意義（搜「的」等於全部），呼叫端會明講「要兩個字以上」，不是靜靜回空清單。
 *
 * ## 三種「文字」不要混
 *
 * · 原文        ：存在 Firestore 的 `text`，顯示給人看的那一份。
 * · 折疊（fold）：大小寫、全形半形壓平，**長度與原文逐字對應**——摘要要在原文上
 *                 抓位置，所以不能用會改變長度的正規化。
 * · 正規化      ：折疊後再把空白壓成一格，片段與比對都用這一份（換行、連續空白
 *                 不該影響「有沒有講過這句話」）。
 */

/** 少於這個字數不做內容搜尋（單字命中率等於全部，呼叫端要明講而不是回空） */
export const MESSAGE_SEARCH_MIN_CHARS = 2

/**
 * 一則訊息只索引前面這麼多字。
 *
 * 幾乎所有訊息都遠短於此（客人問句多半 10～40 字，AI 回答一兩百字）。設上限是為了
 * 擋掉極端值：貼一整份合約進來的那一則會長出上千個片段，每個片段都是一筆索引項，
 * 儲存費與寫入延遲都跟著長。超過的尾巴搜不到——這件事寫在 `searchTextCut` 欄位上，
 * 不要只留在這段註解裡（回填腳本與 API 都看得到那個欄位）。
 */
export const MESSAGE_SEARCH_TEXT_LIMIT = 1200

/** 一則訊息最多存幾個片段（配合上面的字數上限，正常訊息碰不到） */
export const MESSAGE_SEARCH_TOKEN_LIMIT = 900

/** 片段長度＝兩個字。改這個數字等於整份索引要重建，不要隨手動 */
export const MESSAGE_SEARCH_TOKEN_SIZE = 2

/**
 * 全形 ASCII → 半形。客人用全形數字打訂單編號（１２３）、客服用半形搜（123）
 * 是天天發生的事，兩邊對不上就是「明明有講過卻搜不到」。
 * 逐字對應（一個字換一個字），所以折疊後的位置仍然指得回原文。
 */
function foldChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0
  // ！(U+FF01) ～ ～(U+FF5E) 對應 !(0x21) ～ ~(0x7E)；全形空白（U+3000）併入一般空白
  const base = code >= 0xFF01 && code <= 0xFF5E
    ? String.fromCodePoint(code - 0xFEE0)
    : code === 0x3000 ? ' ' : ch
  // ⚠️ 寬度換完還要再壓大小寫：全形「Ａ」先變 'A' 才輪到小寫，順序反了的話
  // 全形英文會停在大寫、和使用者打的半形小寫永遠對不上（2026-09-11 測試抓到）
  const lower = base.toLowerCase()
  // ⚠️ 只有「換完還是一個字」才換：'İ'.toLowerCase() 會變成兩個字元，
  // 一換長度就跑掉，摘要抓到的位置會整段偏移
  return [...lower].length === 1 ? lower : base
}

/**
 * 折疊：大小寫、全形半形壓平，**長度逐字對應原文**。
 * 只有摘要（要在原文上抓位置）需要這一層，比對與片段請用 normalizeMessageSearchText。
 */
export function foldMessageSearchChars(raw: unknown): string[] {
  return [...String(raw ?? '')].map(foldChar)
}

/**
 * 正規化：折疊 + 把所有空白（含換行）壓成一格 + 去頭尾。
 * 片段、比對、關鍵字三者都走這一支，才不會出現「存的時候壓了、查的時候沒壓」。
 */
export function normalizeMessageSearchText(raw: unknown): string {
  return foldMessageSearchChars(raw).join('').replace(/\s+/g, ' ').trim()
}

/**
 * 這則訊息的可搜尋片段。
 *
 * 多段文字（訊息本文 + 圖片的 AI 描述）用空白接起來再切：空白不參與組字，
 * 所以不會長出「跨越兩段」的假片段（那種片段會讓搜尋命中一句根本沒人講過的話）。
 */
export function messageSearchTokens(parts: (string | null | undefined)[]): {
  tokens: string[]
  /** 文字或片段撞到上限＝**後面那段搜不到**。呼叫端要把它存下來，不要只是默默截掉 */
  cut: boolean
} {
  const normalized = normalizeMessageSearchText(parts.filter(Boolean).join(' '))
  const chars = [...normalized]
  const textCut = chars.length > MESSAGE_SEARCH_TEXT_LIMIT
  const scan = textCut ? chars.slice(0, MESSAGE_SEARCH_TEXT_LIMIT) : chars

  const tokens = new Set<string>()
  let tokenCut = false
  for (let i = 0; i + MESSAGE_SEARCH_TOKEN_SIZE <= scan.length; i++) {
    const piece = scan.slice(i, i + MESSAGE_SEARCH_TOKEN_SIZE)
    // 含空白的組合不是「連續的兩個字」，存了只會讓跨詞的假命中變多
    if (piece.some(c => c === ' ')) continue
    tokens.add(piece.join(''))
    if (tokens.size >= MESSAGE_SEARCH_TOKEN_LIMIT) {
      tokenCut = i + MESSAGE_SEARCH_TOKEN_SIZE < scan.length
      break
    }
  }
  return { tokens: [...tokens], cut: textCut || tokenCut }
}

/**
 * 太常見、當查詢片段會掃到一大堆無關訊息的字。
 *
 * 只用來**選片段**（同一個關鍵字有好幾個片段可選時挑最少見的那個），不影響命中結果：
 * 最後仍然是用整段關鍵字在記憶體裡驗。所以這張表不完整、不精確都沒關係，
 * 它只決定「這次搜尋要付幾次讀取」。
 */
const COMMON_CHARS = new Set([
  ...'的一是不了我你他她它有在人這那個們要會說嗎好吧呢嘛喔哦啊呀了著過來去到得地把被讓請問想可以能沒有什麼怎樣為何時候',
  ...'aeiouhnrstl ',
  ...'0123456789',
])

/**
 * 從關鍵字裡挑一個片段去打 `array-contains`。
 *
 * 為什麼只能挑一個：Firestore 一次查詢**最多一個 array-contains**，沒有 AND 多個片段
 * 這種寫法。所以策略是「挑最少見的那一個 → 讀回來的候選最少 → 再用整段關鍵字過濾」。
 *
 * 挑法：片段裡常見字越少越優先，同分取最前面那個（要可預期，測試才鎖得住）。
 * 挑錯不會讓結果變錯，只會讓這次搜尋多掃幾筆（而掃描有上限、會回報截斷）。
 */
export function pickMessageSearchToken(keyword: string): string {
  const chars = [...normalizeMessageSearchText(keyword)]
  let best = ''
  let bestScore = Number.POSITIVE_INFINITY
  for (let i = 0; i + MESSAGE_SEARCH_TOKEN_SIZE <= chars.length; i++) {
    const piece = chars.slice(i, i + MESSAGE_SEARCH_TOKEN_SIZE)
    if (piece.some(c => c === ' ')) continue
    const score = piece.reduce((sum, c) => sum + (COMMON_CHARS.has(c) ? 1 : 0), 0)
    if (score < bestScore) {
      bestScore = score
      best = piece.join('')
      if (score === 0) break
    }
  }
  return best
}

/**
 * 這則訊息（本文／圖片描述）裡有沒有整段關鍵字。
 * 片段查詢只負責把候選縮小，這一支才是「到底算不算命中」的唯一判準。
 */
export function messageSearchMatches(keyword: string, parts: (string | null | undefined)[]): boolean {
  const needle = normalizeMessageSearchText(keyword)
  if (!needle) return false
  return parts.some(p => normalizeMessageSearchText(p).includes(needle))
}

export type MessageSearchSnippet = {
  /** 命中前面那一小段（可能是空的） */
  before: string
  /** 命中的字本身（原文，大小寫／全形照原樣顯示） */
  match: string
  /** 命中後面那一段 */
  after: string
  /** 前面還有被切掉的字（畫面上要補「…」） */
  cutHead: boolean
  /** 後面還有被切掉的字 */
  cutTail: boolean
}

/**
 * 搜尋結果那一行要顯示的摘要：**以命中的字為中心**取一段原文。
 *
 * ⛔ 不可以退回「訊息前 N 個字」：客人的訊息前面常常是「你好 想請問一下」，
 *    那樣每一列長得一模一樣，看不出來自己為什麼搜到這一列——而「為什麼命中」
 *    正是這個清單唯一要回答的問題。
 *
 * 抓位置用折疊過、**與原文逐字對應**的那一份（見檔頭三種文字的說明）；
 * 關鍵字跨越換行等對不上的情況就退回開頭那一段，不要為此不顯示摘要。
 */
export function messageSearchSnippet(
  raw: unknown,
  keyword: string,
  opts?: { before?: number, after?: number },
): MessageSearchSnippet {
  const beforeLen = opts?.before ?? 12
  const afterLen = opts?.after ?? 52
  const original = [...String(raw ?? '')]
  const folded = foldMessageSearchChars(raw).join('')
  const needle = foldMessageSearchChars(keyword).join('').trim()

  const at = needle ? folded.indexOf(needle) : -1
  if (at < 0) {
    // 對不上（多半是關鍵字跨了換行／連續空白）：給開頭一段，至少看得到這則在講什麼
    const head = original.slice(0, beforeLen + afterLen)
    return {
      before: head.join(''),
      match: '',
      after: '',
      cutHead: false,
      cutTail: original.length > head.length,
    }
  }

  /**
   * folded 是逐字對應的，但 `indexOf` 回的是 UTF-16 位置，而 original 是**字元陣列**
   * （emoji 佔兩個 UTF-16 單位）。用前綴的字元數換算，才不會在有 emoji 的訊息上偏移。
   */
  const startIdx = [...folded.slice(0, at)].length
  const matchLen = [...needle].length
  const from = Math.max(0, startIdx - beforeLen)
  const to = Math.min(original.length, startIdx + matchLen + afterLen)
  return {
    before: original.slice(from, startIdx).join(''),
    match: original.slice(startIdx, startIdx + matchLen).join(''),
    after: original.slice(startIdx + matchLen, to).join(''),
    cutHead: from > 0,
    cutTail: to < original.length,
  }
}
