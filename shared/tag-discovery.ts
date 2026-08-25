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
/** 一次掃描最多提幾個（寧缺勿濫，一週能認真看完的量） */
export const MAX_PROPOSALS_PER_SCAN = 3

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

export interface TagDiscoveryDoc {
  workspaceId: string
  pending: TagDiscoveryProposal[]
  /** 否決過的主題名（原樣保留給 prompt 排除用；比對時用 normalizeTagName） */
  dismissedNames: string[]
  /** 上次掃描完成時間（不管有沒有提出東西都更新，掃描間隔靠它） */
  lastScanMs: number
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
  now?: number
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

  return { tone: 'idle', text: 'AI 每週會從對話裡找「還沒有標籤」的新主題。這次掃描沒有發現足夠明確的新主題。' }
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
  const max = ctx.maxProposals ?? MAX_PROPOSALS_PER_SCAN
  const minUsers = ctx.minDistinctUsers ?? MIN_DISTINCT_USERS
  const taken = new Set(ctx.takenNames.map(normalizeTagName).filter(Boolean))
  const out: Array<Omit<TagDiscoveryProposal, 'id' | 'proposedAtMs' | 'sampleNames'>> = []

  for (const topic of Array.isArray(raw) ? raw : []) {
    if (out.length >= max) break

    const name = String(topic?.name ?? '').trim().slice(0, DISCOVERY_NAME_MAX)
    const criteria = String(topic?.criteria ?? '').trim().slice(0, DISCOVERY_CRITERIA_MAX)
    if (!name || !criteria) continue

    const key = normalizeTagName(name)
    if (!key || taken.has(key)) continue

    // 場次索引 → 客人主鍵，去重（同一位客人多場只算一位）
    const sessions = Array.isArray(topic?.sessions) ? topic.sessions : []
    const userDocIds = [...new Set(
      sessions
        .map(s => ctx.sessionUserIds[Number(s)])
        .filter((u): u is string => typeof u === 'string' && !!u),
    )]
    if (userDocIds.length < minUsers) continue

    const category = VALID_CATEGORIES.includes(topic?.category as TagCategory)
      ? topic!.category as TagCategory
      : 'custom'

    out.push({
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

  return out
}
