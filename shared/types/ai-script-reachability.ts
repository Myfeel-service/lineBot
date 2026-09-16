/**
 * 腳本「觸發得到嗎」的靜態分析。
 *
 * 為什麼需要這支:腳本在 webhook 編排裡排在安全層後面——
 *   安全層(敏感情境) → 進行中的流程 → 啟動流程 → AI
 * 所以一條腳本可能設定完全正常、後台看起來好好的,實際上永遠輪不到:
 * 觸發詞被敏感情境詞攔走,或被另一條關鍵字更寬的腳本蓋住。
 * 這種事客人不會回報(他們得到的是「別的回覆」不是「沒回覆」),只能靠靜態比對揪出來。
 *
 * 註:2026-08-09 起「自動回覆規則」已下架,原本的 autoReplyRule 原因隨之移除——
 * 順位收成單一條之後,那種蓋台在結構上不可能再發生。
 *
 * 判定一律取「保守的強條件」——**每一個**觸發詞都被蓋掉才算,漏報好過誤報:
 * 異常中心報一次假的,使用者就會學會忽略它。
 *
 */
import type { ScriptDoc } from './ai-script'

/** 分析用的最小腳本形狀(id + 文件本體) */
export type ScriptForReachability = Pick<ScriptDoc, 'name' | 'nodes' | 'rootNodeId' | 'enabled' | 'priority'> & { id: string }

export type ScriptBlockReason =
  /** 關鍵字和語意範例都空白:確定性通道打不中,意圖路由也沒線索可判 */
  | 'noTrigger'
  /** 每個觸發詞都含敏感情境詞,安全層排在腳本之前,一律先轉真人 */
  | 'sensitiveTopic'
  /** 每個觸發詞都被另一條(優先度不低於它的)腳本的觸發詞包住 */
  | 'otherScript'

export interface ScriptReachabilityIssue {
  scriptId: string
  scriptName: string
  reason: ScriptBlockReason
  /** 一句話講清楚被誰擋住,直接顯示給使用者 */
  detail: string
}

/**
 * 把原始文件（Firestore doc、list API 回來的列）收成分析用的形狀。
 * 異常中心（server/utils/script-health.ts）與編輯器共用同一份，「enabled 未設視為啟用」只有一把尺。
 */
export function toReachabilityScripts(rows: Array<Record<string, unknown>>): ScriptForReachability[] {
  return rows
    .filter(s => s?.enabled)
    .map(s => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? ''),
      nodes: (s.nodes ?? []) as ScriptForReachability['nodes'],
      rootNodeId: String(s.rootNodeId ?? ''),
      enabled: true,
      priority: Number(s.priority ?? 0),
    }))
}

/**
 * 同上，但**保留停用的那些**（`enabled` 照實帶）。
 *
 * 上下架預覽非用它不可：要問的正是「把這條**停用中**的打開會怎樣」，
 * 而上面那支在入口就把停用的濾掉了——拿它來算，目標流程根本不在清單裡。
 */
export function toReachabilityScriptsWithDisabled(rows: Array<Record<string, unknown>>): ScriptForReachability[] {
  return rows.map(s => ({
    id: String(s.id ?? ''),
    name: String(s.name ?? ''),
    nodes: (s.nodes ?? []) as ScriptForReachability['nodes'],
    rootNodeId: String(s.rootNodeId ?? ''),
    enabled: s.enabled === true,
    priority: Number(s.priority ?? 0),
  }))
}

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase()
}

/** 取一條腳本的觸發節點（不是 trigger 或找不到就回 null） */
function triggerOf(script: ScriptForReachability) {
  const root = script.nodes?.find(n => n.id === script.rootNodeId)
  return root?.type === 'trigger' ? root : null
}

/**
 * 上下架一條流程之前，先算出「按下去之後誰會變得輪不到、誰會活過來」。
 *
 * 為什麼要有：上下架至今**沒有任何確認**——開關一撥、存檔就對外生效，而它的影響不在
 * 這條流程身上，在**別條**身上（新開的這條可能把另一條的觸發詞整個包住）。
 * 這種蓋台客人不會回報：他們收到的是「別的回覆」不是「沒回覆」。
 *
 * 做法是拿同一支分析器跑「改之前」與「改之後」兩次再比對——⛔不另寫一套判定，
 * 否則預覽講的跟異常中心報的會是兩回事（這個後台最貴的坑一向是兩套口徑）。
 *
 * 給小幫手的確認卡與流程編輯器共用，兩邊講的影響一字不差。
 */
export interface ScriptToggleImpact {
  /** 開了之後它自己仍然輪不到（開了等於沒開）——比任何影響都該先講 */
  selfStillBlocked: ScriptReachabilityIssue | null
  /** 這個動作會讓這幾條從「輪得到」變成「輪不到」 */
  newlyBlocked: ScriptReachabilityIssue[]
  /** 這個動作會讓這幾條從「輪不到」變回「輪得到」 */
  newlyFreed: ScriptReachabilityIssue[]
}

export function previewScriptToggleImpact(
  scripts: ScriptForReachability[],
  target: { id: string, enabled: boolean },
  ctx: { sensitiveTopics?: readonly string[] } = {},
): ScriptToggleImpact {
  const before = scripts
  const after = scripts.map(s => (s.id === target.id ? { ...s, enabled: target.enabled } : s))

  const issuesBefore = findUnreachableScripts(before, ctx)
  const issuesAfter = findUnreachableScripts(after, ctx)

  const idsBefore = new Set(issuesBefore.map(i => i.scriptId))
  const idsAfter = new Set(issuesAfter.map(i => i.scriptId))

  return {
    // 只有「開啟」才問得出這個問題：停用的流程本來就輪不到，那不是問題是選擇
    selfStillBlocked: target.enabled ? (issuesAfter.find(i => i.scriptId === target.id) ?? null) : null,
    newlyBlocked: issuesAfter.filter(i => i.scriptId !== target.id && !idsBefore.has(i.scriptId)),
    newlyFreed: issuesBefore.filter(i => i.scriptId !== target.id && !idsAfter.has(i.scriptId)),
  }
}

/**
 * 找出「設定看起來正常、實際上永遠輪不到」的腳本。只看啟用中的腳本
 * （停用是刻意的，不是異常）。同一條腳本只回第一個成立的原因——
 * 使用者要的是「先修哪一個」，不是一次收到四張一樣的卡。
 */
export function findUnreachableScripts(
  scripts: ScriptForReachability[],
  ctx: { sensitiveTopics?: readonly string[] } = {},
): ScriptReachabilityIssue[] {
  const enabled = scripts.filter(s => s.enabled)
  const topics = (ctx.sensitiveTopics ?? []).map(norm).filter(Boolean)
  const issues: ScriptReachabilityIssue[] = []

  for (const script of enabled) {
    const trigger = triggerOf(script)
    // 加好友觸發是事件型：follow 事件直達、不經文字比對，敏感層與別條腳本都蓋不住它，
    // 也天生沒有觸發詞——跳過整組檢查，否則會對每條 follow 腳本誤報「沒有觸發詞」。
    if (trigger?.triggerEvent === 'follow') continue
    const keywords = (trigger?.keywords ?? []).map(norm).filter(Boolean)
    const examples = (trigger?.examples ?? []).map(e => String(e).trim()).filter(Boolean)
    const name = String(script.name || '(未命名流程)')
    const push = (reason: ScriptBlockReason, detail: string) =>
      issues.push({ scriptId: script.id, scriptName: name, reason, detail })

    if (!trigger || (!keywords.length && !examples.length)) {
      push('noTrigger', `「${name}」沒有填任何觸發詞或範例說法，沒有東西能讓它啟動`)
      continue
    }
    // 以下三項都要求「每個觸發詞都被蓋掉」。沒有觸發詞、只靠語意範例的腳本
    // 走的是意圖路由（規則／敏感層擋不掉整條路），不在這裡判。
    if (!keywords.length) continue

    const topicHit = topics.find(t => keywords.every(k => k.includes(t)))
    if (topicHit) {
      push('sensitiveTopic', `「${name}」的觸發詞都含敏感情境詞「${topicHit}」，客人一提到就直接轉真人，不會走這條流程`)
      continue
    }

    // 另一條腳本的觸發詞是這條的子字串，且優先度不低 → 凡打中這條的句子必先打中那條。
    // 同優先度也算：同分時誰排前面沒有保證，等於這條隨時可能被吃掉。
    const rival = enabled.find((other) => {
      if (other.id === script.id) return false
      if ((other.priority ?? 0) < (script.priority ?? 0)) return false
      const otherKeywords = (triggerOf(other)?.keywords ?? []).map(norm).filter(Boolean)
      if (!otherKeywords.length) return false
      return keywords.every(k => otherKeywords.some(ok => k.includes(ok)))
    })
    if (rival) {
      push('otherScript', `「${name}」的觸發詞都被「${String(rival.name || '(未命名流程)')}」的觸發詞包住，會先被那條接走`)
    }
  }

  return issues
}
