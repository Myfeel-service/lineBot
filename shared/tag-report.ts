/**
 * 客群分析報告（`D-28`＋`D-63`，兩列是同一件事）——純函式層。
 *
 * ── 這層在管什麼 ─────────────────────────────────────────────────
 * 數字怎麼算在 `shared/tag-insights.ts`（`C-147` 已完成）。這一支管的是**報告本身**：
 * 什麼時候可以重新產生、白話總結怎麼問、以及**總結可不可以用**。
 *
 * ── 四條鐵律（`D-28` 08-24 拍板，這裡逐條落地）─────────────────────
 * ① **產生－存檔－沿用**：按需鈕＋1 小時冷卻＋存檔，⛔ **不是每次開頁重算**。
 *    一份報告約三四千次 Firestore 讀取，掛在開頁上就是 08-11 讀取費暴衝重演。
 * ② **AI 只讀數字寫人話、不算數字**。程式算好餵表格給它，它只負責翻成老闆聽得懂的話。
 *    這條**不是靠 prompt 拜託，是靠 `rejectTagSummary` 擋**：輸出裡出現任何一個
 *    我們沒餵給它的數字，整段退掉不出摘要。（同「成本頁分母算錯會被抓」那條鐵律。）
 * ③ **薄資料整段不出現**。標籤沒幾顆、貼標沒幾筆的帳號，生出來的是廢話。
 * ④ **事件紀錄與意圖要分開講**。97% 是問卷名冊卻總結成「客人很關心 X」是騙人的。
 */

import type { TagCategory } from './types/tag-broadcast'

/** 兩次產生之間至少隔多久。⛔ 這是成本閘門，不是 UX 潤飾，不要為了「即時」拿掉。 */
export const TAG_REPORT_COOLDOWN_MS = 60 * 60 * 1000

/**
 * 白話總結的長度上限（字）。超過就退掉——沒有人會讀一整頁的 AI 感想。
 *
 * ⚠️ 2026-09-23 實測調過一次：原本訂 400，模型八輪裡有五輪落在 399–542。
 *   ⭐ 但 400 這個數字本來就是隨手訂的，而這段是**報告卡上的一段話**、不是塞進
 *   LINE 訊息的一句（那種才真的有硬上限）。四點 × 每點 70 字＝280，留到 500 是合理的餘裕。
 */
export const TAG_SUMMARY_MAX = 500
/**
 * prompt 裡跟模型要的字數——**訂在「每一點」，不是「總共」**。
 *
 * ⚠️ 這是 2026-09-23 實測換過的寫法：跟它要「總共 280 字」時，五輪全部超過
 *   （399/415/435/482/542）——全篇字數它根本不管。改成限制每一點、同時把點數從
 *   「三到五點」收到「三到四點」，才是模型跟得動的約束。
 */
export const TAG_SUMMARY_BULLET_TARGET = 70

/**
 * 資料薄到不值得生摘要的門檻（鐵律③）。
 * 兩個條件**都**不滿足才算薄：貼標筆數太少、而且客人自己表現的標籤排不出三名。
 */
export const TAG_SUMMARY_MIN_TAGGINGS = 30
export const TAG_SUMMARY_MIN_RANKED = 3

// ═══════════════════════════════════════════════════════════════════
//  報告內容的形狀（＝端點算出來、存進 Firestore、畫面讀的那一份）
// ═══════════════════════════════════════════════════════════════════

export interface TagRef {
  tagId: string
  name: string
  category: TagCategory | null
  color: string | null
}

export interface TagInsightsPayload {
  /** ⛔ 畫面一定要讀這一段：哪幾塊算不出來、哪幾塊只算了一部分 */
  integrity: {
    failed: string[]
    userTagsTruncated: boolean
    suggestionLogsTruncated: boolean
    pendingTruncated: boolean
    scannedUserTags: number
    /** 底帳的起算日；畫面上的採用率一定要標它 */
    suggestionLedgerSince: string
  }
  /** 卡 1：還沒審的建議（幾**位客人**，不是幾條建議） */
  pendingReview: { users: number, byTag: Array<TagRef & { users: number }> }
  /**
   * 卡 2：客人自己表現出來的。
   *
   * `isIntent`＝這顆是不是意圖型（有開 AI 判斷）。**非帶不可**：
   * ⚠️ 2026-09-23 實測，模型看到「問卷_珈樂堤_小滑手：1691 位」就寫成
   *   「客戶對這個的**興趣**最高」——那是填過問卷的名冊，不是想買。
   *   prompt 寫了「不可以說成有興趣」它照樣寫，所以要靠這個旗標在關卡上結構性地擋。
   */
  customerExpressed: Array<TagRef & { users: number, isIntent: boolean }>
  /** 卡 2 附：兩兩交集（<5 位的不列，鐵律之一） */
  intersections: Array<{ a: TagRef, b: TagRef, users: number }>
  /** 卡 3 主角：事件紀錄 vs 意圖 */
  eventVsIntent: { intent: { tags: number, taggings: number }, event: { tags: number, taggings: number } }
  /** 卡 3 附：來源分布（自動化程度的診斷） */
  sourceMix: { counts: Record<string, number>, total: number, customerExpressed: number, ourOwn: number }
  /** 卡 4：覆蓋率（分母是「有互動的客人」，⛔ 不是「好友」） */
  coverage: { taggedUsers: number, untaggedUsers: number | null, totalUsers: number | null, pct: number | null }
  /** 卡 5：健康檢查 */
  health: { zeroMember: Array<{ tagId: string, name: string }>, aiOnButNeverProduced: Array<{ tagId: string, name: string }> }
  /** 卡 6：AI 貼標的成績 */
  suggestions: {
    suggested: number
    autoApplied: number
    applied: number
    dismissed: number
    superseded: number
    decided: number
    agreed: number
    acceptanceRate: number | null
  }
  /**
   * 排行裡那幾顆標籤的「這顆在講什麼」——給總結用的，不畫在卡上。
   * `description`＝寫給團隊看的說明、`aiCriteria`＝AI 的判斷條件。
   *
   * ⚠️ `TagDoc.description` 上面寫著「AI 不讀這欄」，指的是**不可以拿它當貼標判斷條件**
   *    （那是 `aiCriteria` 的工作，2026-08-24 分兩欄就是為了這件事）。這裡是另一回事：
   *    報告要理解「這顆標籤的商業意義」，說明欄正是唯一寫得下那件事的地方
   *    （`D-28` 08-24 也是這樣拍的）。⛔ 不要把這兩個用途混在一起談。
   */
  tagNotes: Array<{ tagId: string, name: string, description: string, aiCriteria: string }>
}

/** 摘要為什麼沒有。⛔ 空字串一律要配一個理由，不可以讓它靜靜消失。 */
export type TagSummarySkip = 'too_thin' | 'llm_failed' | 'rejected'

export interface TagReportDoc {
  generatedAtMs: number
  /** 誰按的產生；顯示用，查不到就空字串 */
  generatedBy: string
  payload: TagInsightsPayload
  /** 白話總結；空字串＝沒有，理由看 `summarySkip` */
  summary: string
  summarySkip: TagSummarySkip | null
}

// ═══════════════════════════════════════════════════════════════════
//  冷卻（鐵律①）
// ═══════════════════════════════════════════════════════════════════

/** 還要等多久才能再產生一份（毫秒）。0＝現在就可以。 */
export function cooldownRemainingMs(lastGeneratedAtMs: number | null | undefined, nowMs: number): number {
  const last = Number(lastGeneratedAtMs ?? 0)
  if (!last || !Number.isFinite(last)) return 0
  // 未來時間（機器時鐘歪掉／資料髒）當成可以重算，⛔ 不要把人鎖死在一個算不完的冷卻裡
  if (last > nowMs) return 0
  return Math.max(0, TAG_REPORT_COOLDOWN_MS - (nowMs - last))
}

export function canRegenerate(lastGeneratedAtMs: number | null | undefined, nowMs: number): boolean {
  return cooldownRemainingMs(lastGeneratedAtMs, nowMs) === 0
}

/** 冷卻中要講的話。⛔ 只寫「請稍後再試」等於沒講，要說得出還要多久。 */
export function cooldownText(remainingMs: number): string {
  if (remainingMs <= 0) return ''
  const mins = Math.ceil(remainingMs / 60_000)
  return `這份報告是 ${TAG_REPORT_COOLDOWN_MS / 60_000} 分鐘內才算過的，${mins} 分鐘後可以重新產生。`
}

// ═══════════════════════════════════════════════════════════════════
//  薄資料（鐵律③）
// ═══════════════════════════════════════════════════════════════════

/**
 * 資料薄到不值得生摘要嗎？
 *
 * ⛔ 薄的時候**整段不出現**，不要硬生一句「目前資料還不多，建議多累積」——
 *   那種話每個月講一次，第二次就沒有人會再看這頁。
 */
export function isTooThinForSummary(p: TagInsightsPayload): boolean {
  const taggings = (p.eventVsIntent?.intent?.taggings ?? 0) + (p.eventVsIntent?.event?.taggings ?? 0)
  const ranked = p.customerExpressed?.length ?? 0
  return taggings < TAG_SUMMARY_MIN_TAGGINGS || ranked < TAG_SUMMARY_MIN_RANKED
}

/** 沒有摘要時畫面要說的話（三種理由講三句不同的話） */
export function summarySkipText(skip: TagSummarySkip | null): string {
  switch (skip) {
    case 'too_thin':
      return `貼標資料還太少（要滿 ${TAG_SUMMARY_MIN_TAGGINGS} 筆、而且客人自己表現的標籤有 ${TAG_SUMMARY_MIN_RANKED} 顆以上），先不寫總結——硬寫出來的是廢話。下面的數字本身是準的。`
    case 'llm_failed':
      return '這次沒能產生白話總結（AI 服務沒回應）。下面的數字都是算好的，不受影響。'
    case 'rejected':
      return '這次的白話總結沒通過檢查（裡面出現了我們沒給它的數字），已經整段退掉。下面的數字都是程式算的，是準的。'
    default:
      return ''
  }
}

// ═══════════════════════════════════════════════════════════════════
//  白話總結：prompt（鐵律②④）
// ═══════════════════════════════════════════════════════════════════

function pctText(n: number, total: number): string {
  if (!total) return '0%'
  return `${Math.round((n / total) * 1000) / 10}%`
}

/**
 * 餵給模型的事實表。**刻意只放算好的數字**——模型手上不該有任何需要它自己運算的東西。
 *
 * 匯出是為了讓 `rejectTagSummary` 用同一份文字建白名單：
 * ⭐ **「允許出現的數字」＝「我們餵過去的數字」**，兩邊同源才不會有漏網的偽造值。
 */
export function buildTagSummaryFacts(p: TagInsightsPayload): string {
  const lines: string[] = []
  const ev = p.eventVsIntent

  lines.push('【這家店的標籤在回答什麼】')
  lines.push(`- 意圖型標籤（有開 AI 判斷，回答「這個人想要什麼」）：${ev.intent.tags} 顆，貼出 ${ev.intent.taggings} 筆`)
  lines.push(`- 事件型標籤（沒開 AI 判斷，回答「這個人做過什麼」，例如填了哪份問卷）：${ev.event.tags} 顆，貼出 ${ev.event.taggings} 筆`)

  lines.push('')
  lines.push('【客人身上最多的標籤（排行）】')
  if (p.customerExpressed.length) {
    for (const t of p.customerExpressed) {
      const note = p.tagNotes.find(n => n.tagId === t.tagId)
      const desc = [note?.description, note?.aiCriteria].filter(Boolean).join('；')
      // ⭐ 逐列標出來是哪一種：只在表頭講一次，模型讀到第五列就忘了
      const kind = t.isIntent ? '意圖' : '事件紀錄，⛔ 不等於他想要'
      lines.push(`- 「${t.name}」：${t.users} 位（${kind}）${desc ? `（這顆標籤是：${desc}）` : ''}`)
    }
  }
  else lines.push('- （沒有）')

  lines.push('')
  lines.push('【同時有兩顆標籤的人】')
  if (p.intersections.length) {
    // ⚠️ 交集這幾列也要標事件／意圖：2026-09-23 實測有一輪就是在這一段把兩顆問卷標籤的
    //   交集寫成「對製冰咖啡飲水機有高度興趣」——排行那段標了、這段沒標，它就從這裡溜出去。
    const kindOf = (id: string) => (p.customerExpressed.find(t => t.tagId === id)?.isIntent ? '意圖' : '事件紀錄')
    for (const x of p.intersections) {
      const ka = kindOf(x.a.tagId)
      const kb = kindOf(x.b.tagId)
      const warn = ka === '事件紀錄' && kb === '事件紀錄'
        ? '，⛔ 兩顆都是「做過什麼」，交集也只代表兩件事都做過，不代表他想要'
        : ''
      lines.push(`- 同時有「${x.a.name}」和「${x.b.name}」：${x.users} 位（${ka}＋${kb}${warn}）`)
    }
  }
  else lines.push('- （沒有達到 5 位的組合）')

  lines.push('')
  lines.push('【覆蓋率】')
  if (p.coverage.pct !== null && p.coverage.totalUsers !== null) {
    lines.push(`- 有互動的客人共 ${p.coverage.totalUsers} 位，其中 ${p.coverage.taggedUsers} 位身上至少有一顆標籤（${p.coverage.pct}%）`)
    if (p.coverage.untaggedUsers !== null) lines.push(`- ${p.coverage.untaggedUsers} 位一顆標籤都沒有——任何按標籤發的推播都會漏掉他們`)
  }
  else lines.push('- （這次算不出來，不要在總結裡提覆蓋率）')

  lines.push('')
  lines.push('【標籤健康】')
  // ⚠️ 標籤名字一律用「」框起來：MYFEEL 有一顆標籤就叫「60 天沒互動」，
  //   不框的話模型把它讀成敘述，寫出「這顆標籤已經 60 天沒互動」這種不存在的事。
  const names = (list: Array<{ name: string }>) => list.map(t => `「${t.name}」`).join('、')
  lines.push(`- 建了沒用到的標籤：${p.health.zeroMember.length} 顆${p.health.zeroMember.length ? `（${names(p.health.zeroMember)}）` : ''}`)
  lines.push(`- 開著 AI 判斷但從來沒判出過人的標籤：${p.health.aiOnButNeverProduced.length} 顆${p.health.aiOnButNeverProduced.length ? `（${names(p.health.aiOnButNeverProduced)}）` : ''}`)

  lines.push('')
  lines.push('【還沒審的 AI 建議】')
  lines.push(`- ${p.pendingReview.users} 位客人的標籤建議還沒有人決定`)

  lines.push('')
  lines.push(`【AI 貼標的成績（${p.integrity.suggestionLedgerSince} 起才有紀錄）】`)
  const s = p.suggestions
  lines.push(`- AI 提過 ${s.suggested} 次建議；人做過決定的有 ${s.decided} 次，其中同意 ${s.agreed} 次`)
  lines.push(s.acceptanceRate === null
    ? '- 同意率：還沒有人做過任何決定，算不出來'
    : `- 同意率 ${s.acceptanceRate}%`)
  lines.push(`- 另有 ${s.autoApplied} 次是設成「AI 判到直接貼」、沒有經過人（⛔ 這些沒有人投票，不算在同意率裡）`)

  // 來源分布拿來當「自動化程度」的診斷，不是主角
  if (p.sourceMix.total > 0) {
    lines.push('')
    lines.push('【貼標是誰貼的】')
    lines.push(`- 總共 ${p.sourceMix.total} 筆：AI 判的 ${p.sourceMix.counts.ai ?? 0} 筆（${pctText(p.sourceMix.counts.ai ?? 0, p.sourceMix.total)}）、規則觸發 ${p.sourceMix.counts.rule ?? 0} 筆、系統事件 ${p.sourceMix.counts.system ?? 0} 筆、我們自己貼的 ${(p.sourceMix.counts.manual ?? 0) + (p.sourceMix.counts.import ?? 0)} 筆`)
  }

  return lines.join('\n')
}

export function buildTagSummaryPrompt(p: TagInsightsPayload, storeLine = ''): string {
  return [
    '你是一位資深行銷顧問，正在幫一家店看他們的「客群標籤」報告。',
    storeLine ? `這家店：${storeLine}` : '',
    '',
    '以下是**程式算好的數字**，全部正確：',
    '',
    buildTagSummaryFacts(p),
    '',
    '請寫一段老闆看得懂的白話總結。規則：',
    // ⭐ 鐵律②：這句只是禮貌性提醒，真正擋人的是 rejectTagSummary
    '1. ⛔ **不准自己算任何數字**。要引用就照抄上面的數字，不要相加、不要換算成「幾成」「幾倍」「一半」，也不要推估上面沒有的數字。',
    // ⭐ 鐵律④：MYFEEL 97% 是問卷名冊，總結成「客人很關心 X」就是騙人
    // ⭐ 鐵律④：這句也只是提醒，真正擋人的是 rejectTagSummary 的「事件型標籤 × 興趣詞」那段
    '2. **標成「事件紀錄」的標籤只代表「這個人做過這件事」**（填過那份問卷、報名過那檔活動），⛔ 絕對不可以說成「客人對 X 有興趣／想要／喜歡」。只有標成「意圖」的才能講興趣。',
    // ⚠️ 限制訂在「每一點」而不是「總共」：實測跟它要總字數五輪全部超過
    `3. **只寫三到四點**，每點一句話、**${TAG_SUMMARY_BULLET_TARGET} 字以內**，用「- 」開頭。先講看到什麼，再講建議做什麼。`,
    '4. 每一點都要講得出根據（哪顆標籤、幾位），⛔ 沒有數字撐的話不要寫。',
    '5. 建議要是這個後台做得到的事（發推播給某群人、去審待決定的建議、把沒判出人的標籤條件改清楚、把沒用到的標籤封存）。',
    '6. 用繁體中文，不要行銷術語，不要客套開場白，不要在每一點裡塞第二個建議。',
    '7. 只回那幾點本身，不要標題、不要結語。',
  ].filter(Boolean).join('\n')
}

// ═══════════════════════════════════════════════════════════════════
//  白話總結：把關（鐵律②的實際執行者）
// ═══════════════════════════════════════════════════════════════════

/** 抓出一段文字裡所有的數字（含小數）。 */
function numbersIn(text: string): number[] {
  const out: number[] = []
  for (const m of String(text ?? '').matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0])
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/**
 * 允許出現在總結裡的數字＝**我們餵給它的那些**。
 *
 * ⭐ 直接從事實表抽，不另外維護一份清單：兩邊同源才不會有漏網的偽造值。
 *   （標籤名字裡的數字，例如「威技 16L 除濕機」「BOYA mini2」，因為在事實表裡，天然被放行。）
 */
export function allowedSummaryNumbers(p: TagInsightsPayload): Set<number> {
  return new Set(numbersIn(buildTagSummaryFacts(p)))
}

/**
 * 這段總結能不能用？回 `null`＝可以；回字串＝不能用的原因。
 *
 * ⛔ **這支是整個功能的誠信底線**：模型只要吐出一個我們沒給它的數字，
 *   整段退掉、畫面改講「總結沒通過檢查」——⛔ 不可以只刪那一句留其他句，
 *   一段話裡有一個假數字，其他句的可信度也一起沒了。
 *
 * 唯一的寬容：**整數四捨五入**（把 76.4% 講成 76%）算引用不算捏造。
 */
export function rejectTagSummary(text: string, p: TagInsightsPayload): string | null {
  const s = String(text ?? '').trim()
  if (!s) return '空的'
  if (s.length > TAG_SUMMARY_MAX) return `太長（${s.length} 字）`

  // ⛔ 中文數字的換算一律不准：「近八成」「翻倍」「一半」都是它自己算的
  const derived = s.match(/[一二三四五六七八九十兩幾]\s*成|翻倍|[一二三四五六七八九十兩]\s*倍|一半|過半|多數人|大多數/)
  if (derived) return `自己換算了比例（${derived[0]}）`

  /**
   * ⛔ **鐵律④：事件紀錄不可以被說成興趣**。
   *
   * ⚠️ 這條是 2026-09-23 真的打 Gemini 三輪之後補的：prompt 裡已經明寫「不可以說成
   *   客人對 X 有興趣」，三輪裡**兩輪照樣寫**「客戶對『問卷_珈樂堤_小滑手』的興趣最高」。
   *   那顆是填過問卷的名冊——把它讀成「想買」正是這份報告最容易騙人的地方，
   *   所以擋人的必須是程式，不是 prompt 的第 2 條。
   *
   * 做法：把句子切開，只要**同一句**裡出現事件型標籤的名字＋興趣詞，整段退掉。
   * 切句是必要的——整段一起看的話，第一句提到標籤、第五句講興趣就會被誤殺。
   */
  const eventNames = p.customerExpressed.filter(t => !t.isIntent).map(t => t.name).filter(Boolean)
  if (eventNames.length) {
    const wantWords = /興趣|想買|想要|偏好|喜歡|需求|意願|在意/
    /**
     * ⚠️ 否定句要先拿掉再驗。「那是填過問卷的名冊，**不代表**他們想買」是我們**希望**
     *   它寫出來的那種句子——照字面比對會把最誠實的一句誤殺，那比不擋還糟。
     */
    const dropNegated = (t: string) =>
      // 否定詞與興趣詞之間容許一小段（「不等於**對它有**興趣」），但⛔ 不跨標點——
      // 跨了就會把前一句的否定拿去赦免後一句的斷言。
      t.replace(/(?:並)?(?:不|沒|未|非|無)(?:代表|等於|表示|見得|一定|必然)?[^，,。；;！!？?\n]{0,8}?(?:興趣|想買|想要|偏好|喜歡|需求|意願|在意)/g, '')
    for (const sentence of s.split(/[。！!？?\n]/)) {
      const claim = dropNegated(sentence)
      if (!wantWords.test(claim)) continue
      const hit = eventNames.find(n => sentence.includes(n))
      if (hit) return `把事件紀錄說成興趣了（「${hit}」那句）`
    }
  }

  const allowed = allowedSummaryNumbers(p)
  const rounded = new Set([...allowed].map(n => Math.round(n)))
  // 條列符號「1. 」「2. 」不是資料，先拿掉再驗
  const body = s.replace(/^\s*\d+[.、)]\s*/gm, '')
  for (const n of numbersIn(body)) {
    if (allowed.has(n)) continue
    if (Number.isInteger(n) && rounded.has(n)) continue // 四捨五入算引用
    return `出現了我們沒給它的數字（${n}）`
  }
  return null
}
