/**
 * 每日客服摘要那則 LINE 訊息的**文案與排版**（2026-09-17，`D-81` 老闆拍板後改版）。
 *
 * 為什麼抽成一支純函式：這裡要守的全是「讀的人看到什麼」的規則（數字加不加得起來、
 * 標點、段落順序、幾件事），而原本它長在 `dailyBacklogDigest` 中間，要驗一句話對不對
 * 得先假造一整個 Firestore。抽出來之後，文案規則可以逐條測。
 *
 * ── 拍板內容（2026-09-17）────────────────────────────────────
 * ① **先講昨天、再講今天**：原本整則 100% 是待辦，沒有一個「昨天怎麼樣」的數字，
 *    而商家一早最想知道的就是那個。
 * ② **每天都發**（選項 B）：順利的日子發一行短版。原本沒事就不發，
 *    結果「昨天很順」跟「通知壞掉了」長得一模一樣。
 * ③ **分三段，但仍然是一則純文字**：⛔不做圖文卡片（Flex）——純文字在手機鎖定畫面的
 *    通知預覽會直接顯示內容，Flex 只顯示一行 altText。
 *
 * ── 排版規則（改文案前先讀）─────────────────────────────────
 * - **加得起來的才能並排**：昨天那句的三個數字（AI 自己搞定／你出手／沒人回）是
 *   互斥三類，相加一定等於總場數。⛔ 不可以把「轉真人」這種**子集**塞進同一句——
 *   讀的人會去相加、對不起來，然後懷疑數字有 bug（後台那張卡踩過這個坑）。
 * - **數字放句首**：「4 個主題…」不要寫成「有主題 4 個…」，手機上是用掃的。
 * - **一則裡只有一套標點**：全形。（本文半形、週報全形，同一顆泡泡看得出兩個人寫的）
 * - **三項以上用「、」串、最後一項用「與」**：見 `joinZh`。原本是 `.join('與')`，
 *   兩項時剛好對、三項就變成「A 與 B 與 C」。
 * - **操作步驟不寫進 LINE**：這則只回答「是什麼、幾件、去哪」，怎麼按是進了後台的事。
 * - **查不到要講**：任何一類查失敗都不可以當成 0（那是「沒有」的另一種意思），
 *   統一收在一句括號裡講出來。
 */
import { HUMAN_STALE_HOURS } from '~~/shared/types/conversation-stats'

/** 昨天的成績。數字口徑與統計頁／後台那張卡同源（日結 `foldSessionIntoDay`） */
export interface DigestYesterday {
  /** 客人對話總場數（已排除客人沒開口的場） */
  total: number
  /** AI／機器人首接**而且沒有轉真人**的場數 */
  selfServed: number
  /** 真人出手的場數＝真人首接 ＋ 機器人先接後來轉真人 */
  humanServed: number
  /** 一整天都沒有人回的場數 */
  unhandled: number
  /** 沒人回的客人名字（最多 3 位，點名用） */
  unhandledNames: string[]
  /** 新朋友人數；`null`＝查不到（不可以當成 0） */
  newFriends: number | null
}

/** 發送當下「客人正在等」的即時狀況（不是昨天的統計） */
export interface DigestWaiting {
  /** 在「等待真人」的客人數 */
  count: number
  /** 其中「轉真人那一刻已經下班」的人數；服務時間沒啟用時恆 0 */
  offHoursCount: number
  /** 點名樣本（最多 3 位，服務時間內的排前面） */
  samples: { name: string; waitedMinutes: number }[]
  /** 撈到上限＝實際可能更多，說法要退成「至少」 */
  truncated: boolean
  /** 停在「真人處理中」超過 `HUMAN_STALE_HOURS` 小時的對話數 */
  staleHumanCount: number
}

/** 「今天可以處理」那一段的原料（知識庫、標籤、黃級異常） */
export interface DigestTodo {
  outdatedSources: number
  failedSources: number
  expiredCards: number
  suggestions: number
  tagSuggestUsers: number
  /** 黃級異常件數（只點名最重要那一件，不把異常面板搬進 LINE） */
  warnings: number
  topWarningLabel: string
}

export interface DigestInput {
  /** 「9/17（三）」 */
  dateLabel: string
  /** `null`＝昨天的數字這次查不到（⛔不可以靜靜當成 0 場） */
  yesterday: DigestYesterday | null
  waiting: DigestWaiting
  todo: DigestTodo
  /** 節慶提醒內文（`''`＝今天沒有） */
  festivalText: string
  /** 週一的「本週顧客觀察」段落（自帶標題行；空陣列＝沒有） */
  weeklyLines: string[]
  /** 這次查不到的類別（白話名稱，例如「知識庫的部分」） */
  unknownNotes: string[]
}

/** 中文頓號串接：一項照原樣、兩項用「與」、三項以上「A、B 與 C」 */
export function joinZh(items: string[]): string {
  const list = items.filter(Boolean)
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join('、')}與${list[list.length - 1]}`
}

/** 等待時間的白話說法：未滿一小時講分鐘，否則講小時（至少 1） */
export function waitPhrase(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `等 ${Math.max(1, m)} 分鐘`
  return `等 ${Math.max(1, Math.round(m / 60))} 小時`
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 「2026-09-17」→「9/17（三）」。
 * 日期字串不含時區 → 當 UTC 午夜解析，`getUTCDay` 就是那個日曆日的星期幾
 * （與 `isTaipeiMonday` 同一個做法，不要換成本機時區）。
 */
export function taipeiDateLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return dateKey
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY[d.getUTCDay()]}）`
}

/**
 * 昨天那句的主幹（不含句號，句號由呼叫端補——短版要接「，沒有人在等」）。
 *
 * ⚠️ 三個數字互斥、相加等於總場數，這是這句話唯一的規矩。
 */
function yesterdayCore(y: DigestYesterday | null): string {
  if (!y) return '昨天的數字這次查不到'
  if (!y.total) return '昨天沒有客人對話'
  // 全部自己搞定＝這則訊息最值得講的好消息，給它一句專屬說法
  if (y.selfServed === y.total) return `昨天 ${y.total} 場對話，AI 全部自己搞定`

  const parts: string[] = []
  if (y.selfServed) parts.push(`AI 自己搞定 ${y.selfServed} 場`)
  if (y.humanServed) parts.push(`你出手 ${y.humanServed} 場`)
  if (y.unhandled) parts.push(`${y.unhandled} 場一整天沒人回`)
  if (!parts.length) return `昨天 ${y.total} 場對話`
  return `昨天 ${y.total} 場對話，${parts.join('、')}`
}

/**
 * 組出整則訊息。回 `null`＝這次連「昨天怎麼樣」都查不到、也沒有任何事可講，
 * 整則不發（讓下一輪重來，別把今天的名額浪費在一則空話上）。
 */
export function buildDigestLines(input: DigestInput): string[] | null {
  const { yesterday: y, waiting, todo } = input

  // ── 今天可以處理 ────────────────────────────────────────
  const todoLines: string[] = []
  if (todo.outdatedSources) todoLines.push(`${todo.outdatedSources} 個知識來源內容變了，等你確認要不要更新`)
  if (todo.failedSources) todoLines.push(`${todo.failedSources} 個知識來源同步失敗，AI 還在用舊內容`)
  if (todo.expiredCards) todoLines.push(`${todo.expiredCards} 張知識卡已到期下架`)
  if (todo.suggestions) todoLines.push(`${todo.suggestions} 個常被問、AI 卻答不好的主題，草稿已擬好`)
  if (todo.tagSuggestUsers) todoLines.push(`${todo.tagSuggestUsers} 位客人的標籤建議等你決定`)
  if (todo.warnings) {
    todoLines.push(`另有 ${todo.warnings} 件建議處理的事，最重要的是「${todo.topWarningLabel}」`)
  }

  const hasWaiting = waiting.count > 0 || waiting.staleHumanCount > 0
  const nothingToDo = !hasWaiting && !todoLines.length
  // 全部查不到、昨天也查不到 → 沒有一句話是真的，不發
  if (!y && nothingToDo && !input.festivalText && !input.weeklyLines.length) return null

  // 指路：只列真的有事的那幾頁（原本三項以上會串成「A 與 B 與 C」）
  const places: string[] = []
  if (hasWaiting) places.push('「對話」')
  if (todo.outdatedSources || todo.failedSources || todo.expiredCards || todo.suggestions) places.push('「AI 知識庫」')
  if (todo.tagSuggestUsers) places.push('「好友」')
  if (todo.warnings) places.push('右下角的小幫手')

  const friendsLine = y && y.newFriends !== null && y.newFriends > 0 ? `新朋友 +${y.newFriends} 位。` : ''
  const unknownLine = input.unknownNotes.length
    ? `（${joinZh(input.unknownNotes)}這次查不到，明天會再看一次。）`
    : ''

  const lines: string[] = []

  // ── 順利的一天：一行講完（拍板選項 B）──────────────────
  if (nothingToDo) {
    const tail = y ? '，沒有人在等。' : '，目前沒有人在等。'
    lines.push(`☀️ ${input.dateLabel} ${yesterdayCore(y)}${tail}${friendsLine}`)
    if (unknownLine) lines.push(unknownLine)
  }
  else {
    // ── 段一：昨天 ────────────────────────────────────────
    lines.push(`☀️ ${input.dateLabel}早安`, '')
    lines.push(`${yesterdayCore(y)}。`)
    if (y?.unhandledNames.length) {
      const more = y.unhandled > y.unhandledNames.length ? `等 ${y.unhandled} 位` : ''
      lines.push(`沒人回的是${joinZh(y.unhandledNames)}${more}。`)
    }
    if (friendsLine) lines.push(friendsLine)

    // ── 段二：現在有人在等（唯一「客人正在受影響」的一段）──
    if (hasWaiting) {
      lines.push('')
      if (waiting.count) {
        // 全部都是下班時段進來的 → 拿掉紅點：這行天天紅字就等於狼來了
        const allOffHours = waiting.offHoursCount >= waiting.count
        const howMany = waiting.truncated ? `至少 ${waiting.count}` : `${waiting.count}`
        lines.push(allOffHours
          ? `現在有 ${howMany} 位客人在等真人，都是下班時段進來的。`
          : `🔴 現在有 ${howMany} 位客人在等真人`)
        if (waiting.samples.length) {
          lines.push(waiting.samples.map(s => `${s.name}（${waitPhrase(s.waitedMinutes)}）`).join('、'))
        }
        if (!allOffHours && waiting.offHoursCount > 0) {
          lines.push(`其中 ${waiting.offHoursCount} 位是下班時段進來的。`)
        }
      }
      if (waiting.staleHumanCount) {
        lines.push(`另有 ${waiting.staleHumanCount} 條對話停在「真人處理中」超過 ${HUMAN_STALE_HOURS} 小時。`)
      }
    }

    // ── 段三：今天可以處理 ────────────────────────────────
    if (todoLines.length) {
      lines.push('', `📌 今天可以處理（${todoLines.length} 項）`, ...todoLines)
    }
    if (places.length) lines.push(`→ 後台${joinZh(places)}`)
    if (unknownLine) lines.push(unknownLine)
  }

  // ── 段四：節慶（跟上面是兩件事，空行隔開）────────────────
  if (input.festivalText) lines.push('', `🎉 ${input.festivalText}`)
  // ── 段五：週報（第一行自帶標題）────────────────────────
  if (input.weeklyLines.length) lines.push('', ...input.weeklyLines)

  return lines
}
