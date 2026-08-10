import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { HANDOFF_REASON_LABELS } from '~~/shared/types/ai-knowledge'
import type { AiConversationMeta } from '~~/shared/types/ai-knowledge'

interface HandoffRow {
  userId: string
  displayName: string
  lastQuery: string
  lastConfidence: number
  handoffReason: AiConversationMeta['lastHandoffReason']
  sources: Array<{ chunkId: string; title: string }>
  updatedAtMs: number
  /** 已被標記處理（resolvedAt >= updatedAt） */
  resolved: boolean
}

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/**
 * GET /api/ai/usage/handoffs?limit=20&reason=low_confidence,no_grounding&before=<ms>
 *
 * 列出最近被 AI 轉真人的對話（包含使用者原問與當時命中的卡）。
 * 監控頁的「補知識」入口；點進去可以看完整對話、或在知識庫補一張對應卡。
 *
 * - reason 接受逗號分隔多值：前端的篩選是「答不出來／刻意設計要人接」這類分組，
 *   一組會一次帶好幾個原因（in 查詢與 == 用同一顆複合索引，免部署新索引）。
 * - before（ms）是「載入更多」的游標；回應帶 hasMore 與 nextBefore，
 *   清單見底時前端才有依據說「真的沒了」而不是「只載了 20 筆」。
 */
export default defineEventHandler(async (event): Promise<{ rows: HandoffRow[]; hasMore: boolean; nextBefore: number }> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const query = getQuery(event)
  const limit = Math.min(50, Math.max(1, Number(query.limit ?? 20)))
  // 白名單由共用標籤表導出(手抄第二份會漂移:新 reason 加了前端卻漏這裡,
  // 篩選會靜默變成回全量);'manual' 是內部人工指定,不開放篩選。
  const VALID_REASONS = new Set(Object.keys(HANDOFF_REASON_LABELS).filter(k => k !== 'manual'))
  const reasons = String(query.reason ?? '').split(',').map(s => s.trim()).filter(r => VALID_REASONS.has(r))
  const before = Number(query.before ?? 0)

  const includeResolved = String(query.includeResolved ?? '') === '1'

  const db = getDb()
  let q: FirebaseFirestore.Query = db.collection('conversations')
    .where('workspaceId', '==', workspaceId)
    .where('aiMeta.lastDecision', '==', 'handoff')

  // 若指定 handoff 原因，改用 lastHandoffReason 查詢（對應 indexes.json 的 composite index）。
  // 注意:lastDecision 條件此時無法進查詢(會需要三欄複合索引),改在記憶體過濾——
  // 否則「還在等客人確認、實際沒轉接」的 handoff_confirm 會混進清單。
  const reasonFiltered = reasons.length > 0
  if (reasonFiltered) {
    q = db.collection('conversations')
      .where('workspaceId', '==', workspaceId)
      .where('aiMeta.lastHandoffReason', reasons.length === 1 ? '==' : 'in', reasons.length === 1 ? reasons[0] : reasons)
  }
  // 載入更多：只回比游標更舊的。不等式落在 orderBy 同一欄，沿用既有索引
  if (before > 0) q = q.where('aiMeta.updatedAt', '<', new Date(before))

  // resolved 與 lastDecision 過濾都在記憶體做,會吃掉查詢名額:只要任一種記憶體過濾
  // 會發生（未含已處理、或帶 reason 篩選）就多抓幾倍再 filter + slice,
  // 避免「前 N 筆都被濾掉」讓頁面短少、更舊的真實案例被遮住。
  // 沒有記憶體過濾時多抓 1 筆當 hasMore 探針。
  const hasMemoryFilter = !includeResolved || reasonFiltered
  const fetchLimit = hasMemoryFilter ? Math.min(100, limit * 3) : limit + 1
  const snap = await q.orderBy('aiMeta.updatedAt', 'desc').limit(fetchLimit).get()

  // Hydrate chunk titles（一次撈完，避免每列再打）
  const allChunkIds = new Set<string>()
  snap.docs.forEach((d) => {
    const meta = (d.data() as { aiMeta?: AiConversationMeta }).aiMeta
    meta?.lastSourceChunkIds?.forEach(id => allChunkIds.add(id))
  })
  const titleByChunkId: Record<string, string> = {}
  if (allChunkIds.size) {
    // getAll 一次批次讀,取代逐筆 doc().get()(最多 100 對話 × 數個 chunkId 的往返)。
    // 批次失敗是全有全無——不能直接回空陣列,否則一次抖動會讓每列都顯示「(卡片已刪除)」;
    // 退回逐筆讀當 fallback,只損失個別文件
    const refs = Array.from(allChunkIds).map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id))
    const chunkDocs = await db.getAll(...refs)
      .catch(() => Promise.all(refs.map(r => r.get().catch(() => null))))
    chunkDocs.forEach((d) => {
      if (d?.exists) {
        const cd = d.data() as { workspaceId?: string; title?: string }
        if (cd?.workspaceId === workspaceId) titleByChunkId[d.id] = String(cd.title ?? '')
      }
    })
  }

  const rows = snap.docs
    // reason 查詢時 lastDecision 沒進 where:排除 handoff_confirm(等確認中)等非真正轉接的狀態
    .filter(d => !reasonFiltered || ((d.data() as { aiMeta?: AiConversationMeta }).aiMeta?.lastDecision === 'handoff'))
    .map((d) => {
    const data = d.data() as { aiMeta?: AiConversationMeta; userId?: string; displayName?: string }
    const meta = data.aiMeta!
    const updatedAtMs = tsToMs(meta.updatedAt)
    const resolvedAtMs = tsToMs(meta.handoffResolvedAt)
    return {
      userId: String(data.userId ?? d.id),
      displayName: String(data.displayName ?? ''),
      lastQuery: String(meta.lastQuery ?? ''),
      lastConfidence: Number(meta.lastConfidence ?? 0),
      handoffReason: meta.lastHandoffReason ?? null,
      sources: (meta.lastSourceChunkIds ?? []).map(id => ({
        chunkId: id,
        title: titleByChunkId[id] ?? '(卡片已刪除)',
      })),
      updatedAtMs,
      resolved: resolvedAtMs > 0 && resolvedAtMs >= updatedAtMs,
    }
  })

  // 預設只回未處理的案例；includeResolved=1 連已處理的一起回
  const filtered = includeResolved ? rows : rows.filter(r => !r.resolved)
  const sliced = filtered.slice(0, limit)

  // 還有更舊的嗎：本頁被截掉的尾巴還有剩、或已抓滿抓取上限（外面大概率還有——
  // 誤判成 true 的代價只是多按一次「載入更多」拿到空頁，比騙人「沒了」便宜）
  const hasMore = filtered.length > limit || snap.size >= fetchLimit
  // 下一頁游標：截掉尾巴時要接在「最後一筆回傳列」之後（否則被截掉的列會被跳過）；
  // 沒截掉就接在「最後一筆掃過的 doc」之後（略過整段被記憶體過濾掉的，不重掃）
  const lastDoc = snap.docs[snap.docs.length - 1]
  const nextBefore = filtered.length > limit
    ? (sliced[sliced.length - 1]?.updatedAtMs ?? 0)
    : (lastDoc ? tsToMs((lastDoc.data() as { aiMeta?: AiConversationMeta }).aiMeta?.updatedAt) : 0)

  return { rows: sliced, hasMore, nextBefore }
})
