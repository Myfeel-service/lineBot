/**
 * AI 發現新標籤（老闆 08-25 拍板動工）——補上整條貼標鏈最上游的缺口。
 *
 * 現有的 `ai-tag-suggest` 是「你建好的標籤，AI 判要不要貼在某人身上」；
 * 這裡是「AI 讀最近的對話，發現『很多客人都在聊 X、但你還沒有 X 這顆標籤』，
 * 提議你建一顆」。沒有這一段，AI 只能確認老闆已經知道的事，發現不了他不知道的事
 * （21 顆標籤裡 19 顆是事件紀錄＝沒人幫他從對話長出新分法的證據）。
 *
 * 資料形狀：**一個 workspace 一份文件**（`tagDiscovery/{workspaceId}`），
 * 建議少（上限 6 條 pending）、讀取一次到位、不需要任何新索引。
 * 同 `userTagSuggestions` 一文件一收件匣的既有慣例。
 *
 * 設計紅線（沿用整個系統的鐵律）：
 * - ⛔ **不自動建標籤**：掃描只寫「提案」，人按「建立」才真的新增——標籤是推播分眾
 *   的唯一依據，AI 自己長標籤的下游就是發錯人。
 * - ⛔ **否決要記住**：按過「不要」的主題記進 dismissedNames，之後的掃描 prompt 排除
 *   ＋程式端再擋一次——否則同一個被否決的主題每週回來一次，收件匣遲早沒人看
 *   （知識庫建議踩過的假警報教訓）。
 * - **品類粒度不是型號粒度**：提「在看除濕機」，不提「在看某牌 6L」——後者是在複製
 *   既有 19 顆事件標籤的老問題。這條寫死在 prompt 裡。
 * - ⛔ **模型不生 ID**：提案的 id 由伺服器產；模型只產內容（名稱／條件／code 字串）。
 */

import type { TagCategory } from './types/tag-broadcast'
import { daysBetween, taipeiDate } from './time'

/** 收件匣上限：沒人清就先不加（同 userTagSuggestions 的精神，別變成沒人看的牆） */
export const MAX_PENDING_DISCOVERIES = 6
/**
 * 一個主題至少要幾位**不同客人**聊過才值得提。
 * ⛔ 是「不同客人」不是「場次」：同一個人問五次除濕機是一位很在意的客人，不是一群名單。
 */
export const MIN_DISTINCT_USERS = 4
/** 兩次掃描的最小間隔（毫秒）。約每週一次，跟洞察週報同節奏 */
export const DISCOVERY_INTERVAL_MS = 6.5 * 24 * 60 * 60 * 1000
/** 每次掃描回看的窗口：兩週。再久的對話講的可能已經不是現在的客人在意的事 */
export const DISCOVERY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
/** 否決名單上限（FIFO）：防止文件無限長大；60 個主題名夠擋一年份的重複提議 */
export const MAX_DISMISSED_NAMES = 60
/**
 * 手動「立即掃描一次」的最小間隔（D-30②）。
 * ⛔ 一定要有地板：這顆按鈕按下去會花一次 LLM，連點就是成本槓桿
 *   （同知識庫「重新掃描」的 MANUAL_SCAN_MIN_GAP_MS 精神）。
 */
export const MANUAL_DISCOVERY_MIN_GAP_MS = 30 * 60 * 1000

/** 一次掃描最多提幾個（寧缺勿濫，一週能認真看完的量） */
export const MAX_PROPOSALS_PER_SCAN = 3

/**
 * 決策紀錄保留幾筆（FIFO）。
 *
 * 為什麼要留：先前按過「建立」或「忽略」之後，那條提案就從文件上整個消失
 * ——忽略只留下一個看不見的名字（`dismissedNames`），採用連「這顆標籤是 AI 提的」
 * 都看不出來。老闆 08-28 直接問「是否把之前建議的紀錄保留、也保留當時的決策」，
 * 答案是要：沒有這份紀錄，「按了幾次都沒有新的」就永遠只能靠印象回答。
 *
 * ⛔ 50 筆是刻意的上限：一份文件（1MB）裝得下，而且掃描一週一次、一次最多 3 條，
 *    50 筆約等於一年份。無上限的陣列遲早把整份文件撐爆，連 pending 都讀不出來。
 */
export const MAX_DISCOVERY_HISTORY = 50

/** 決策紀錄一筆最多存幾位客人的名字（同 pending 的證據快照） */
export const HISTORY_SAMPLE_NAMES = 3

export const DISCOVERY_NAME_MAX = 20
export const DISCOVERY_CRITERIA_MAX = 200 // ＝標籤編輯器 aiCriteria 的 maxlength，同一個數字
export const DISCOVERY_LINE_MAX = 80

export interface TagDiscoveryProposal {
  /** 伺服器產的 uuid（⛔ 不是模型生的） */
  id: string
  name: string
  /** 建議的英文代號（模型產字串、程式驗格式；採用時再驗唯一性） */
  code: string
  category: TagCategory
  /** AI 判斷條件（採用後直接當 aiCriteria），「什麼算＋什麼不算」寫法 */
  criteria: string
  /** 這顆標籤拿來做什麼（採用後當 description） */
  usage: string
  /** 為什麼建議（給老闆看的白話一句） */
  reason: string
  /** 聊過這個主題的客人（users 主鍵）。採用時直接幫這批人貼上 */
  userDocIds: string[]
  /**
   * 前幾位客人的名字（掃描當下的快照，最多 3 個）。
   *
   * 為什麼要存不要現查：「23 位客人聊過」是這條建議唯一的證據強度，但按下去之前
   * 看不到是**誰**就沒有信任可言；而標籤還不存在、沒有名單頁可以連過去（好友頁是
   * 靠 ?tagIds= 篩的）。存快照＝一週一次幾筆讀取，現查＝每次開標籤頁都多打好幾次。
   * 代價是客人改名後這裡還是舊名字——可接受（它只是「大概是這些人」的提示）。
   */
  sampleNames: string[]
  proposedAtMs: number
}

/** 一條提案最後被怎麼處理掉的 */
export type TagDiscoveryDecisionAction = 'adopt' | 'dismiss'

/**
 * 一筆決策紀錄：這條建議長什麼樣、誰在什麼時候決定了什麼。
 *
 * ⛔ **不存 `userDocIds`**（pending 存、這裡不存）：一條提案可以掛到兩百多位客人，
 * 50 筆 × 200 個 id 就是幾百 KB，會把整份文件推向 1MB 上限，連 pending 都讀不出來。
 * 紀錄要回答的是「當時提了什麼、我決定了什麼」，人數與幾個名字就足夠；
 * 真要看名單，採用的那條可以從 `tagId` 連到好友頁（那才是名單的家）。
 */
export interface TagDiscoveryDecision {
  /** 沿用提案 id，方便和伺服器日誌對得起來 */
  id: string
  name: string
  category: TagCategory
  criteria: string
  usage: string
  reason: string
  /** 提案當時有幾位不同客人聊過（證據強度的快照） */
  userCount: number
  sampleNames: string[]
  proposedAtMs: number
  decidedAtMs: number
  action: TagDiscoveryDecisionAction
  /** 誰按的：uid 一定有，email 是當下的快照（沒有就不顯示，⛔不要拿 uid 充當人名） */
  decidedBy: string
  decidedByEmail?: string
  /** adopt 才有：建出來的標籤 id（畫面靠它連到好友頁的名單） */
  tagId?: string
  /** adopt 才有：實際幫幾位客人貼上（⛔ 可能少於 userCount，貼標是逐位進行、單人失敗不整批放棄） */
  taggedCount?: number
  /**
   * dismiss 才有：後來按了「取消忽略」的時間。
   * ⛔ 不把整筆刪掉：刪掉等於這個決定沒發生過，而它其實發生過也被推翻過——
   * 兩件事都是紀錄的一部分。
   */
  undoneAtMs?: number
}

/** 一條提案沒能留下來的原因（畫面要講得出「AI 其實有提，但…」） */
export type DiscoveryDropReason = 'duplicate' | 'too_few_users' | 'incomplete' | 'over_limit'

/**
 * 上一次掃描到底發生了什麼（`C-68` 同一種病的第三次治療）。
 *
 * ⛔ **為什麼非存不可**：08-26 查「線上為什麼提 0 個」時，掃描 health 乾淨、`lastScanMs`
 * 也寫了＝正常跑完，模型也有回東西，全部被守門員刷掉——但**一個字都沒留在資料裡**
 * （只有伺服器 log 的一行 warn，畫面上查不到）。使用者看到的就只有「沒有新建議」，
 * 跟「壞掉了」長得一模一樣。老闆 08-28 的「按了幾次都沒有新的」問的就是這個。
 */
export interface DiscoveryScanOutcome {
  atMs: number
  kind: 'proposed' | 'no_topics' | 'all_filtered' | 'too_few_sessions'
  /** 這次讀進來幾段對話（客人真的講過話的那些） */
  sessionCount: number
  /** 這些對話來自幾位不同客人 */
  userCount: number
  /** 模型提了幾個主題 */
  rawCount: number
  /** 守門後留下幾個（＝真的進收件匣的數量） */
  keptCount: number
  /** 被刷掉的主題與原因（上限見 MAX_OUTCOME_DROPPED） */
  dropped: Array<{ name: string; reason: DiscoveryDropReason }>
}

/** 掃描結果裡最多記幾條「被刷掉的主題」（文件要小；講三五個就夠說明白了） */
export const MAX_OUTCOME_DROPPED = 6

export interface TagDiscoveryDoc {
  workspaceId: string
  pending: TagDiscoveryProposal[]
  /** 否決過的主題名（原樣保留給 prompt 排除用；比對時用 normalizeTagName） */
  dismissedNames: string[]
  /** 上次掃描完成時間（不管有沒有提出東西都更新，掃描間隔靠它） */
  lastScanMs: number
  /** 上次掃描的結果明細（沒提出東西時，這是唯一講得出「為什麼」的地方） */
  lastScan?: DiscoveryScanOutcome
  /** 決策紀錄（新的在後面，FIFO 砍舊的） */
  history?: TagDiscoveryDecision[]
  /**
   * 使用者按了「立即掃描一次」的時間（D-30②）。
   * 比 lastScanMs 新＝下一輪排程要跳過「還沒到一週」的閘門，真的掃一次。
   * ⛔ 只做標記、不同步跑：掃描要讀兩百多場對話＋一次 LLM，塞進 HTTP 請求會撞閘道逾時
   *   （同知識庫 requestGapScan 的做法）。
   */
  rescanRequestedMs?: number
  updatedAt?: unknown
  createdAt?: unknown
}

/** 提案分類 → 標籤顏色（沿用範本的用色習慣；模型不選顏色） */
export const DISCOVERY_CATEGORY_COLORS: Record<TagCategory, string> = {
  interest: '#0EA5E9',
  behavior: '#F97316',
  member_status: '#EF4444',
  activity: '#10B981',
  custom: '#6B7280',
}

const VALID_CATEGORIES: TagCategory[] = ['member_status', 'interest', 'behavior', 'activity', 'custom']

/**
 * 主題名的比對鍵：去空白（含全形）、去常見標點、轉小寫。
 * 「在看 除濕機」「在看除濕機。」要算同一個，否則否決名單擋不住換個寫法的重提。
 */
export function normalizeTagName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[。，、．,.!?！？「」『』()（）:：;；-]/g, '')
}

/**
 * 從候選名字裡挑前 N 個「真的有名字」的。
 *
 * ⛔ 不能只取前 3 位就算了：LINE 用戶沒設暱稱是常態（`displayName` 存空字串），
 * 前三位剛好都空白的話整條建議會退回「23 位客人聊過」——這條建議唯一的證據就這樣消失，
 * 而且畫面上跟「這功能沒做」長得一模一樣。呼叫端要多抓幾位進來讓這裡挑。
 */
export function pickSampleNames(names: Array<string | null | undefined>, max = 3): string[] {
  const out: string[] = []
  for (const raw of names) {
    const name = String(raw ?? '').trim()
    if (!name || out.includes(name)) continue
    out.push(name)
    if (out.length >= max) break
  }
  return out
}

/**
 * 「AI 發現新標籤」現在到底是什麼狀態（純函式，可測）——標籤頁那行小字的內容來源。
 *
 * ⛔ **這支存在的理由**：先前那行是把 `lastScanMs` 原樣印出來，結果它偵測不到
 * 它自己註解裡點名的那種壞法——掃描每輪都炸掉時 `lastScanMs` 永遠是 0，畫面會印
 * 「第一次掃描還沒跑」，讀起來像「再等一下」，正是 `C-68` 的沉默死亡再演一次。
 * 所以這裡吃三個輸入：開關、上次成功掃描、掃描器有沒有在連續失敗。
 */
export type DiscoveryStateTone = 'idle' | 'warning' | 'danger'

export interface DiscoveryStateInput {
  enabled: boolean
  lastScanMs: number
  /** 掃描器連續失敗中（由 shared/scanner-health.ts 判定） */
  stalled: boolean
  /** 這次進頁面之後，使用者自己處理掉了建議（採用或忽略） */
  handledThisVisit: boolean
  /** 上次掃描的結果明細；沒有（舊資料）就退回泛用句子，⛔不要硬掰一個原因 */
  lastScan?: DiscoveryScanOutcome | null
  now?: number
}

const DROP_REASON_TEXT: Record<DiscoveryDropReason, string> = {
  duplicate: '你已經有相同或很接近的標籤（含你先前按過「不要」的主題）',
  too_few_users: `聊過的客人不到 ${MIN_DISTINCT_USERS} 位`,
  incomplete: '內容不完整',
  over_limit: `一次最多提 ${MAX_PROPOSALS_PER_SCAN} 個，這幾個排在後面`,
}

/**
 * 「這次掃描為什麼沒有新的」——一句話講完（純函式，可測）。
 *
 * ⛔ 這支的重點是**分得出三種「沒有」**：樣本太少、AI 看完覺得沒主題、AI 有提但被擋掉。
 * 三種的下一步完全不同（等對話累積／這是正常的／去看看是不是擋錯了），
 * 全部講成「沒有發現新主題」等於什麼都沒講。
 *
 * 回 null＝沒有可講的明細（舊資料沒存 lastScan），呼叫端退回原本的泛用句。
 */
export function discoveryScanOutcomeText(outcome: DiscoveryScanOutcome | null | undefined): string | null {
  if (!outcome || typeof outcome.kind !== 'string') return null

  if (outcome.kind === 'too_few_sessions') {
    return `這次讀了最近兩週的 ${outcome.sessionCount} 段對話，可用的樣本太少`
      + `（同一個主題至少要 ${MIN_DISTINCT_USERS} 位不同客人聊過才會提）。`
  }

  if (outcome.kind === 'no_topics') {
    return `這次讀了 ${outcome.sessionCount} 段對話（${outcome.userCount} 位客人），`
      + 'AI 沒有找到夠多人聊、而且你還沒有標籤的主題。'
  }

  if (outcome.kind === 'all_filtered') {
    // 同原因的併成一組講，否則三個主題就是三句話，沒人讀得完
    const groups = new Map<DiscoveryDropReason, string[]>()
    for (const d of outcome.dropped ?? []) {
      const list = groups.get(d.reason) ?? []
      list.push(d.name)
      groups.set(d.reason, list)
    }
    const parts = [...groups.entries()].map(([reason, names]) =>
      `「${names.join('、')}」${DROP_REASON_TEXT[reason] ?? '被排除'}`)
    const detail = parts.length ? `——${parts.join('；')}。` : '。'
    return `這次 AI 有提出 ${outcome.rawCount} 個主題，但都沒有留下${detail}`
  }

  // proposed：正常情況下畫面會顯示收件匣而不是這行；人把建議清完了才會走到這裡
  return `上次掃描提出了 ${outcome.keptCount} 個建議。`
}

/** 超過幾倍間隔沒成功掃描就算「太久沒動」（掃描約每 6.5 天一次，兩倍＝約兩週） */
export const DISCOVERY_STALE_FACTOR = 2

export function discoveryState(input: DiscoveryStateInput): { tone: DiscoveryStateTone; text: string } {
  const now = input.now ?? Date.now()

  if (!input.enabled) {
    return {
      tone: 'idle',
      text: 'AI 每週會從對話裡找「還沒有標籤」的新主題——目前「AI 讀對話」是關的，到「AI 設定 → 顧客標籤」打開才會開始找。',
    }
  }

  // ⛔ 壞掉最優先：壞掉時 lastScanMs 可能是 0（從沒成功過）也可能很舊，
  //    兩種都不能顯示成「還沒跑」或「沒發現主題」那種無害的話
  if (input.stalled) {
    return {
      tone: 'danger',
      text: 'AI 找新標籤的背景掃描一直失敗，已經有一段時間沒有真的跑過了。這是系統這邊的狀況，不用你操作——請聯絡我們處理。',
    }
  }

  if (!input.lastScanMs) {
    return { tone: 'idle', text: 'AI 每週會從對話裡找「還沒有標籤」的新主題，第一次掃描還沒跑（排程每 10 分鐘檢查一次）。' }
  }

  // 成功過、但久到不合理（例如排程整個停了，連失敗都沒記到）
  if (now - input.lastScanMs > DISCOVERY_INTERVAL_MS * DISCOVERY_STALE_FACTOR) {
    return {
      tone: 'warning',
      text: '距離上次成功掃描已經超過兩週，比預期的一週一次久很多。背景排程可能沒在跑——這是系統這邊的狀況，不用你操作。',
    }
  }

  // ⛔ 剛被使用者清空的清單，不可以講成「掃描沒發現主題」——它有發現，是你剛處理完
  if (input.handledThisVisit) {
    return { tone: 'idle', text: '這批建議都處理完了。AI 每週會再從新的對話裡找新主題。' }
  }

  /**
   * ⛔ 有明細就講明細：泛用的「沒有發現足夠明確的新主題」在三種情境下都會印同一句
   * （樣本太少／AI 覺得沒主題／AI 有提但被擋掉），而這三種的下一步完全不同。
   * 舊資料沒存 lastScan 才退回那句泛用的——不是所有人都會馬上有明細。
   */
  const scanText = discoveryScanOutcomeText(input.lastScan)
  return {
    tone: 'idle',
    text: scanText
      ? `AI 每週會從對話裡找「還沒有標籤」的新主題。${scanText}`
      : 'AI 每週會從對話裡找「還沒有標籤」的新主題。這次掃描沒有發現足夠明確的新主題。',
  }
}

/**
 * 「上次什麼時候掃的、下次什麼時候會掃」——細條上那行事實（純函式，可測）。
 *
 * ⛔ **為什麼要有這行**：`discoveryState()` 那句話只講「AI 每週會…」，講不出**哪一天**。
 * 老闆的實際問題是「按了立即掃描之後呢？自動的又落在什麼時候？」——畫面上一個時間都沒有，
 * 於是這個功能看起來像沒在動（實測 2026-08-26：上次掃描 14:40、下次 9/2，但畫面一字未提）。
 *
 * 機制講清楚才寫得對：排程**每 10 分鐘檢查一次**，但閘門是「距離上次成功掃描滿
 * `DISCOVERY_INTERVAL_MS`（約 6.5 天）」才真的跑；按「立即掃描一次」是寫一個請求標記，
 * 讓下一輪跳過那道閘門。所以「下次自動掃描」＝上次掃描 ＋ 6.5 天。
 *
 * 回 null＝**這個情境沒有誠實的時間可講**（功能關著、或從沒成功掃過），
 * 主句本來就會說明，這裡不要硬擠一個數字出來。
 */
export interface DiscoveryTimingInput {
  enabled: boolean
  lastScanMs: number
  /** 比 lastScanMs 新＝有人按了「立即掃描一次」，還沒被排程撿走 */
  rescanRequestedMs?: number
  now?: number
}

/** 台北時區的 HH:mm（跨時區跑測試才不會飄） */
function taipeiHhmm(ms: number): string {
  const t = new Date(ms + 8 * 60 * 60 * 1000)
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`
}

/** 'YYYY-MM-DD' → 'M/D'（畫面上不需要年份，今年的事佔九成九） */
function shortDate(ymd: string): string {
  const [, m, d] = ymd.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function discoveryTiming(input: DiscoveryTimingInput): string | null {
  const now = input.now ?? Date.now()
  if (!input.enabled) return null

  // 排隊中最優先：按了按鈕之後最想知道的是「所以到底會不會跑、什麼時候」
  if ((input.rescanRequestedMs ?? 0) > input.lastScanMs) {
    return '已排進佇列，約 10 分鐘內會掃一次；掃完重新整理這一頁就看得到。'
  }

  if (!input.lastScanMs) return null

  const today = taipeiDate(new Date(now))
  const lastDay = taipeiDate(new Date(input.lastScanMs))
  const daysAgo = daysBetween(lastDay, today)
  const lastLabel = daysAgo === 0
    ? `今天 ${taipeiHhmm(input.lastScanMs)}`
    : daysAgo === 1
      ? `昨天 ${taipeiHhmm(input.lastScanMs)}`
      : `${shortDate(lastDay)} ${taipeiHhmm(input.lastScanMs)}`

  const nextMs = input.lastScanMs + DISCOVERY_INTERVAL_MS
  // 已經過了該掃的時間、排程還沒撿走（每 10 分鐘一輪，所以最多等一下下）
  if (now >= nextMs) return `上次掃描：${lastLabel}．下次自動掃描：隨時會跑。`

  const nextDay = taipeiDate(new Date(nextMs))
  const daysLeft = daysBetween(today, nextDay)
  const inLabel = daysLeft <= 0 ? '今天稍晚' : daysLeft === 1 ? '明天' : `約 ${daysLeft} 天後`
  return `上次掃描：${lastLabel}．下次自動掃描：${shortDate(nextDay)}（${inLabel}）。`
}

/** 標籤 code 的清洗：合法就原樣、不合法回空字串（呼叫端自己給退路，這裡不編數字） */
export function sanitizeTagCode(raw: string): string {
  const code = String(raw ?? '').trim().toLowerCase()
  return /^[a-z][a-z0-9_]{1,39}$/.test(code) ? code : ''
}

/** 模型回來的原始提案（欄位全部當不可信） */
export interface RawDiscoveryTopic {
  name?: unknown
  code?: unknown
  category?: unknown
  criteria?: unknown
  usage?: unknown
  reason?: unknown
  sessions?: unknown
}

export interface SanitizeContext {
  /** 場次編號 → 該場客人的 users 主鍵（prompt 裡的 S0、S1… 對回來） */
  sessionUserIds: string[]
  /** 已存在的標籤名＋pending 提案名＋否決過的名（原樣即可，內部會 normalize） */
  takenNames: string[]
  maxProposals?: number
  minDistinctUsers?: number
}

/**
 * 模型輸出 → 可入庫的提案（不含 id/proposedAtMs，那兩個是呼叫端的事）。
 *
 * 這裡是唯一的守門員，規則全在同一處：
 * - 名稱必填、≤20 字；criteria 必填、≤200 字（超長截斷不丟棄——內容通常前面最重要）
 * - category 白名單外一律當 custom（模型偶爾發明新分類，別讓它污染下拉選單）
 * - sessions 索引 → 對回 userDocIds 並去重；**不同客人數 < 門檻的整條丟掉**
 * - 名稱撞到既有／pending／否決過的（normalize 後比對）→ 丟掉；提案彼此同名也只留第一條
 */
export function sanitizeDiscoveryProposals(
  raw: RawDiscoveryTopic[],
  ctx: SanitizeContext,
): Array<Omit<TagDiscoveryProposal, 'id' | 'proposedAtMs' | 'sampleNames'>> {
  return sanitizeDiscoveryProposalsDetailed(raw, ctx).kept
}

export interface SanitizeResult {
  kept: Array<Omit<TagDiscoveryProposal, 'id' | 'proposedAtMs' | 'sampleNames'>>
  /** 被刷掉的：名字＋原因。⛔ 沒名字的（連 name 都空）不進來——講不出是哪一條，寫了也沒用 */
  dropped: Array<{ name: string; reason: DiscoveryDropReason }>
}

/**
 * 同上，但**連「誰被刷掉、為什麼」一起回**。
 *
 * ⛔ 為什麼要有這支：08-26 線上「提 0 個」查不出原因，就是因為守門員把東西默默丟掉、
 * 一個字都沒留（`C-68` 同一種病發生在守門員身上）。`kept` 與上面那支保證逐字相同，
 * 差別只在多回一份「被丟掉的清單」——判斷邏輯只有這一份，不會有兩套口徑。
 */
export function sanitizeDiscoveryProposalsDetailed(
  raw: RawDiscoveryTopic[],
  ctx: SanitizeContext,
): SanitizeResult {
  const max = ctx.maxProposals ?? MAX_PROPOSALS_PER_SCAN
  const minUsers = ctx.minDistinctUsers ?? MIN_DISTINCT_USERS
  const taken = new Set(ctx.takenNames.map(normalizeTagName).filter(Boolean))
  const kept: SanitizeResult['kept'] = []
  const dropped: SanitizeResult['dropped'] = []

  /** 記一筆被刷掉的（沒名字的略過：畫面上「『』因為…被排除」是空話） */
  const drop = (name: string, reason: DiscoveryDropReason) => {
    if (name && dropped.length < MAX_OUTCOME_DROPPED) dropped.push({ name, reason })
  }

  for (const topic of Array.isArray(raw) ? raw : []) {
    const name = String(topic?.name ?? '').trim().slice(0, DISCOVERY_NAME_MAX)
    const criteria = String(topic?.criteria ?? '').trim().slice(0, DISCOVERY_CRITERIA_MAX)
    if (!name || !criteria) {
      drop(name, 'incomplete')
      continue
    }

    const key = normalizeTagName(name)
    if (!key || taken.has(key)) {
      drop(name, 'duplicate')
      continue
    }

    // 場次索引 → 客人主鍵，去重（同一位客人多場只算一位）
    const sessions = Array.isArray(topic?.sessions) ? topic.sessions : []
    const userDocIds = [...new Set(
      sessions
        .map(s => ctx.sessionUserIds[Number(s)])
        .filter((u): u is string => typeof u === 'string' && !!u),
    )]
    if (userDocIds.length < minUsers) {
      drop(name, 'too_few_users')
      continue
    }

    /**
     * ⛔ 上限的檢查放在**所有內容檢查之後**：這樣「排在後面所以沒進來」的那幾條，
     * 名字與原因都講得出來。先前是 `break`，後面的連看都沒看過，
     * 於是「AI 其實提了 5 個」這件事在畫面上等於沒發生。
     * `kept` 的結果與先前逐字相同（上限一樣不放行）。
     */
    if (kept.length >= max) {
      drop(name, 'over_limit')
      continue
    }

    const category = VALID_CATEGORIES.includes(topic?.category as TagCategory)
      ? topic!.category as TagCategory
      : 'custom'

    kept.push({
      name,
      code: sanitizeTagCode(String(topic?.code ?? '')),
      category,
      criteria,
      usage: String(topic?.usage ?? '').trim().slice(0, DISCOVERY_LINE_MAX),
      reason: String(topic?.reason ?? '').trim().slice(0, DISCOVERY_LINE_MAX),
      userDocIds,
    })
    taken.add(key) // 提案彼此也要去重
  }

  return { kept, dropped }
}
