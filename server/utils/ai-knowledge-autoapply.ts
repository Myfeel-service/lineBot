/**
 * 網頁來源「小改自動套用」(P2-7 後半;前半=pendingHash 防輪播已上):
 * 變動偵測確認真變後,先試著自動套用——**只有最安全的一種形態**允許自動:
 * 重切出來的卡與舊卡「標題精確配對」的內容修改,且不涉手編卡、無新增無刪除、
 * 變動比例 ≤30%、內容長度沒暴跌。其餘一律退回既有的「標記+通知人工審」。
 *
 * 為什麼這麼保守:自動改知識卡沒有人把關,錯了客人直接吃到。網頁改版/暫掛/切壞
 * 的形態都是「結構變化」(新增刪除大改),被條件擋掉;能自動過的只剩「同一張卡
 * 文字更新」(價格、日期、措辭)——這正是店家最不想手動按的那種瑣事。
 *
 * 手編卡雙保險:分級判定遇到手編卡直接整源退人工(不只跳過那張),
 * 且 computeDiff 第二輪本來就不讓手編卡參與內容配對。
 */
import type { Firestore } from 'firebase-admin/firestore'
import type { KnowledgeSourceDoc } from '~~/shared/types/ai-knowledge'
import { chunkTextWithLlm } from './ai-knowledge-chunker'
import { computeDiff, type DiffResult } from './ai-knowledge-resync'
import { normalizeChunkInput, updateKnowledgeChunk, validateChunkInput } from './ai-knowledge-chunks'
import { listChunksBySource } from './ai-knowledge-sources'
import { recordAiUsage } from './ai-usage'

/** 變動比例上限:修改張數 / 舊卡總數 超過即退人工(整頁改版的訊號) */
export const MAX_AUTO_MODIFIED_RATIO = 0.3
/**
 * 卡片數少於此值的來源不套用比例規則——單卡來源改 1 張就是 100%,比例門檻讓自動套用
 * 對「運費說明」「FAQ 單頁」這類最常見的小來源數學上永不可能成立(卻仍付了一次重切卡的錢)。
 * 小來源改用絕對張數:一次只改 1 張才自動。
 */
const RATIO_RULE_MIN_CARDS = 4
/** 新內容總長低於舊內容的這個比例 = 疑似抓取不完整(動態頁掛掉/被擋),退人工 */
export const MIN_NEW_CONTENT_RATIO = 0.5

export interface ApplyCard {
  chunkId: string
  title: string
  content: string
  tags: string[]
  questions?: string[]
}

export interface MinorChangeVerdict {
  kind: 'auto' | 'noop' | 'manual'
  /** kind='manual' 時的原因(進通知文案,店家看得懂為什麼要自己來) */
  reason: string
  /** kind='auto' 時要套用的修改 */
  toApply: ApplyCard[]
}

/**
 * 分級判定(純函式,可測):這次 diff 是否安全到可以自動套用。
 * 條件全過才 'auto';切卡後其實沒差異回 'noop';其餘 'manual' 附原因。
 *
 * disabledChunkIds:目前狀態為 disabled 的卡(手動停用或有效期限到期被排程停用)。
 * 這類卡**絕不能**自動更新——updateKnowledgeChunk 會把 status 寫回 indexed,等於讓
 * 過期的募資/折扣卡無聲復活對客人講話,且到期日已被搬到 expiredAt,排程不會再停用第二次。
 * (reindex / reindex-all 都明文跳過 disabled,自動套用必須比照。)
 */
export function classifyMinorChange(
  diff: DiffResult,
  opts: { oldTotalChars: number; newTotalChars: number; disabledChunkIds?: Set<string> },
): MinorChangeVerdict {
  const { summary } = diff
  if (summary.added > 0 || summary.removed > 0) {
    return {
      kind: 'manual',
      reason: `結構有變(新增 ${summary.added} 張、移除 ${summary.removed} 張卡)`,
      toApply: [],
    }
  }
  if (opts.oldTotalChars > 0 && opts.newTotalChars < opts.oldTotalChars * MIN_NEW_CONTENT_RATIO) {
    return { kind: 'manual', reason: '新內容長度大幅縮水,疑似抓取不完整', toApply: [] }
  }

  const modified = diff.entries.filter(e => e.kind === 'modified')
  if (!modified.length) return { kind: 'noop', reason: '', toApply: [] }

  if (modified.some(e => e.oldChunk?.manuallyEdited)) {
    return { kind: 'manual', reason: '變動涉及你手動編輯過的卡', toApply: [] }
  }
  if (opts.disabledChunkIds?.size && modified.some(e => opts.disabledChunkIds!.has(e.oldChunk!.id))) {
    return { kind: 'manual', reason: '變動涉及已停用或已過期的卡', toApply: [] }
  }
  // 第二輪內容配對(LLM 微調過標題)不算「精確配對」:標題變了代表切卡結構在漂,留人工
  if (modified.some(e => e.oldChunk?.title !== e.newChunk?.title)) {
    return { kind: 'manual', reason: '卡片標題有變動(非原卡直接更新)', toApply: [] }
  }
  const oldCards = summary.modified + summary.unchanged
  if (oldCards >= RATIO_RULE_MIN_CARDS) {
    if (summary.modified / oldCards > MAX_AUTO_MODIFIED_RATIO) {
      return {
        kind: 'manual',
        reason: `變動比例過高(${summary.modified}/${oldCards} 張卡有改)`,
        toApply: [],
      }
    }
  }
  else if (summary.modified > 1) {
    // 小來源(<4 張卡)改用絕對張數:一次改多張多半是頁面改版,不是文字微調
    return { kind: 'manual', reason: `這個來源只有 ${oldCards} 張卡,卻有 ${summary.modified} 張同時變動`, toApply: [] }
  }

  // 寫入前跑與其他建卡路徑相同的正規化+驗證:自動路徑沒有人把關,不能讓超長/空白的
  // 切卡結果直接寫進知識庫(bulk-create 與 resync-apply 都會在這裡擋下並回 400)。
  const toApply: ApplyCard[] = []
  for (const e of modified) {
    const normalized = normalizeChunkInput({
      title: e.newChunk!.title,
      content: e.newChunk!.content,
      tags: e.newChunk!.tags,
      questions: e.newChunk!.questions ?? [],
    })
    const err = validateChunkInput(normalized)
    if (err) {
      return { kind: 'manual', reason: `重切出的卡片不合規(${err})`, toApply: [] }
    }
    toApply.push({
      chunkId: e.oldChunk!.id,
      title: normalized.title,
      content: normalized.content,
      tags: normalized.tags,
      questions: normalized.questions?.length ? normalized.questions : undefined,
    })
  }

  return { kind: 'auto', reason: '', toApply }
}

export interface AutoApplyResult {
  /** true = 已自動套用(updated/failed 有值) */
  applied: boolean
  /** true = 重切後其實沒有內容差異(排版級變動),不必通知也不必標 outdated */
  noop: boolean
  updated: number
  failed: number
  /** applied=false 且 noop=false 時:退人工的原因(進通知文案) */
  reason: string
}

/**
 * 對「已確認變動」的 URL 來源試跑自動套用。任何內部錯誤都 fail-open:
 * 回 manual 讓呼叫端走既有的「標記+通知人工審」,絕不讓排程因此中斷。
 */
export async function tryAutoApplyMinorChange(
  db: Firestore,
  sourceId: string,
  source: KnowledgeSourceDoc,
  newText: string,
): Promise<AutoApplyResult> {
  const manual = (reason: string): AutoApplyResult =>
    ({ applied: false, noop: false, updated: 0, failed: 0, reason })

  // 型錄來源(generateOverview)先擋在 LLM 之前:子卡變動要連總覽卡一起重生,
  // 自動路徑不做總覽卡重生(那是 resync-apply 的事),交人工。也省一次切卡費用。
  if (source.generateOverview) return manual('這是型錄/列表來源,總覽卡需要一併重生')

  try {
    const { chunks: newChunks, inputTokens, outputTokens } = await chunkTextWithLlm(newText, {
      hint: source.name,
    })
    await recordAiUsage(source.workspaceId, {
      inputTokens,
      outputTokens,
      importInputTokens: inputTokens,
      importOutputTokens: outputTokens,
    }).catch(() => {})
    if (!newChunks.length) return manual('重切後沒有產出卡片')

    // 一次讀齊(含 status):總覽卡不參與 diff(由 resync-apply 依最終子卡重生),
    // disabled 卡仍要參與比對——它們留在 diff 裡才能被下面的護欄擋下,
    // 從 oldChunks 抽掉反而會讓同名新卡變成「新增」而繞過判定。
    const allChunks = await listChunksBySource(db, source.workspaceId, sourceId)
    const oldChunks = allChunks.filter(c => !c.isOverview).map(c => ({
      id: c.id,
      title: c.title,
      content: c.content,
      tags: c.tags,
      manuallyEditedAtMs: c.manuallyEditedAtMs,
    }))
    if (!oldChunks.length) return manual('來源目前沒有卡片可比對')
    const disabledChunkIds = new Set(allChunks.filter(c => c.status === 'disabled').map(c => c.id))
    const diff = computeDiff(oldChunks, newChunks)

    const verdict = classifyMinorChange(diff, {
      oldTotalChars: oldChunks.reduce((s, c) => s + c.content.length, 0),
      newTotalChars: newChunks.reduce((s, c) => s + c.content.length, 0),
      disabledChunkIds,
    })
    if (verdict.kind === 'noop') return { applied: false, noop: true, updated: 0, failed: 0, reason: '' }
    if (verdict.kind === 'manual') return manual(verdict.reason)

    let updated = 0
    let failed = 0
    for (const card of verdict.toApply) {
      try {
        const r = await updateKnowledgeChunk(db, {
          chunkId: card.chunkId,
          title: card.title,
          content: card.content,
          tags: card.tags,
          questions: card.questions, // undefined = 保留既有問法
          sourceId,
          contentChanged: true,
          // 不帶 manualEdit:自動套用不能把卡標成「手動編輯」,否則之後 re-sync 永遠 keep_old
        })
        if (r.status === 'failed') failed++
        else updated++
      }
      catch (e) {
        failed++
        console.warn(`[auto-apply] ${sourceId} 卡片 ${card.chunkId} 套用失敗:`, e)
      }
    }
    return { applied: true, noop: false, updated, failed, reason: '' }
  }
  catch (e: any) {
    console.warn(`[auto-apply] ${sourceId} 自動套用失敗,退回人工審:`, e)
    return manual('自動比對過程出錯')
  }
}
