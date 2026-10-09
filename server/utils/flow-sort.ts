/** 將 Firestore createdAt 轉成毫秒（供排序用） */
export function flowCreatedAtMillis(ts: unknown): number {
  if (!ts) return 0
  if (typeof ts === 'object' && ts !== null && 'toMillis' in ts) {
    const toMillis = (ts as { toMillis?: () => number }).toMillis
    if (typeof toMillis === 'function') return toMillis.call(ts)
  }
  if (ts instanceof Date) return ts.getTime()
  return 0
}

/** 越小越靠前；未設定 sortOrder 時沿用 createdAt 新→舊 */
export function resolveFlowSortOrder(flow: Record<string, unknown>): number {
  const raw = flow.sortOrder
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const ms = flowCreatedAtMillis(flow.createdAt)
  return ms > 0 ? -ms : 0
}

export function sortRegularFlows<T extends Record<string, unknown>>(flows: T[]): T[] {
  return [...flows].sort((a, b) => resolveFlowSortOrder(a) - resolveFlowSortOrder(b))
}

export function nextFlowSortOrder(regularFlows: Record<string, unknown>[]): number {
  if (!regularFlows.length) return 0
  const min = Math.min(...regularFlows.map(resolveFlowSortOrder))
  return min - 1
}

/**
 * 新模組要排在 `anchorId` 正上方（複製模組用）：新模組的 sortOrder，以及其他模組要改成多少。
 *
 * 做法跟拖曳排序（`/api/flow/reorder`）一樣把整串重編成 0、1、2…，
 * 但只回「值真的變了」的那幾個，複製一次不必把全部模組重寫一遍。
 * ⛔ 不用「取上下兩個的中間值」：舊資料沒有 sortOrder、或兩個模組排序值一樣時，
 *    中間值就等於它自己，新模組會跑到更上面、不在它正上方。
 * ⚠️ 排序值一樣時照側欄的順序（`list.get.ts` 是 createdAt 新→舊再排 sortOrder），
 *    否則算出來的「正上方」跟人眼睛看到的不是同一格。
 *
 * 找不到 anchor（系統模組、剛被刪掉）回 null，由呼叫端照舊排最上面。
 */
export function planFlowInsertAbove(
  regularFlows: Array<Record<string, unknown> & { id: string }>,
  anchorId: string,
): { sortOrder: number, updates: Array<{ id: string, sortOrder: number }> } | null {
  const sorted = [...regularFlows]
    .sort((a, b) => flowCreatedAtMillis(b.createdAt) - flowCreatedAtMillis(a.createdAt))
    .sort((a, b) => resolveFlowSortOrder(a) - resolveFlowSortOrder(b))
  const at = sorted.findIndex(f => f.id === anchorId)
  if (at < 0) return null
  const updates: Array<{ id: string, sortOrder: number }> = []
  sorted.forEach((f, i) => {
    const next = i < at ? i : i + 1
    if (f.sortOrder !== next) updates.push({ id: f.id, sortOrder: next })
  })
  return { sortOrder: at, updates }
}
