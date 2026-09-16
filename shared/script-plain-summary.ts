/**
 * 把一條客服流程講成人看得懂的幾句話（`D-58`②，2026-09-16 老闆拍板「用講的建流程」）。
 *
 * 為什麼需要：小幫手代你建一條流程時，確認卡上必須讓你看得出**客人會被問什麼、會收到什麼**。
 * 今天唯一看得懂這件事的地方是流程編輯器那張圖——而確認卡裡放不下一張圖，
 * 沒有這份白話就等於叫人盲簽（`D-34` 那輪明文反對的「一鍵全收」）。
 *
 * ⛔ 這裡只描述、不判斷好壞：能不能用由既有的驗證器把關，兩件事不要混在一起。
 */
import type { ScriptNode } from './types/ai-script'

/** 把長字串截短給清單用（完整內容在編輯器裡看） */
function short(s: unknown, max = 40): string {
  const v = String(s ?? '').trim().replace(/\s+/g, ' ')
  return v.length > max ? `${v.slice(0, max)}…` : v
}

function describeNode(node: ScriptNode): string | null {
  switch (node.type) {
    case 'trigger': {
      const n = node as any
      if (n.triggerEvent === 'follow') return '客人加好友的時候啟動'
      const keywords = (n.keywords ?? []).filter(Boolean)
      if (keywords.length) return `客人打「${keywords.slice(0, 6).map((k: unknown) => short(k, 12)).join('、')}」的時候啟動`
      const examples = (n.examples ?? []).filter(Boolean)
      if (examples.length) return `客人講的話跟「${short(examples[0], 20)}」意思接近時啟動`
      return '（還沒設定什麼時候啟動）'
    }
    case 'collect': {
      const n = node as any
      const skip = n.skipLabel ? `，答不出來可以按「${short(n.skipLabel, 16)}」跳過` : ''
      return `問客人：「${short(n.question, 50)}」並把回答記下來${skip}`
    }
    case 'reply':
      return `回覆客人：「${short((node as any).text, 50)}」`
    case 'quickReply': {
      const n = node as any
      const opts = (n.options ?? []).map((o: any) => short(o.label, 12)).filter(Boolean)
      return `問客人：「${short(n.question, 40)}」，給這幾個按鈕：${opts.join('／') || '（還沒設按鈕）'}`
    }
    case 'branch':
      return `依照客人先前回答的「${short((node as any).field, 20)}」走不同的路`
    case 'tag':
      return `幫這位客人貼上標籤：${((node as any).tagIds ?? []).length ? `${((node as any).tagIds ?? []).length} 個` : '（還沒選標籤）'}`
    case 'saveLead':
      return '把收集到的資料存進名單'
    case 'module':
      return '交給另一個機器人模組接手'
    default:
      return null
  }
}

/**
 * 依「從啟動那一步開始、照著往下走」的順序描述整條流程。
 *
 * ⛔ 走訪要有 visited 守衛：流程允許繞回前面的步驟（重問、回主選單），沒守衛會無限迴圈。
 * ⛔ 走不到的步驟也要列出來並標明——它們是編輯時的殘留，看的人有權知道流程裡還躺著什麼
 *    （這個專案的教訓：被靜靜濾掉的東西，之後都會變成「為什麼會這樣」）。
 */
export function describeScriptSteps(
  nodes: readonly ScriptNode[],
  rootNodeId: string,
): { steps: string[], unreachable: string[] } {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const visited = new Set<string>()
  const steps: string[] = []

  const queue: string[] = [rootNodeId].filter(id => byId.has(id))
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = byId.get(id)
    if (!node) continue

    const line = describeNode(node)
    if (line) steps.push(line)

    const n = node as any
    for (const next of [n.next, n.skipNext, n.defaultNext]) if (next && byId.has(next)) queue.push(next)
    for (const c of n.cases ?? []) if (c?.next && byId.has(c.next)) queue.push(c.next)
    for (const o of n.options ?? []) if (o?.next && byId.has(o.next)) queue.push(o.next)
  }

  const unreachable = nodes
    .filter(n => !visited.has(n.id))
    .map(n => describeNode(n))
    .filter((s): s is string => !!s)

  return { steps, unreachable }
}
