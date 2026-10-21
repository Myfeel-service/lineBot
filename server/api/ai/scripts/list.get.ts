import { getDb } from '~~/server/utils/firebase'
import { queryCollectionPage } from '~~/server/utils/paginated-collection-list'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { SCRIPTS_COLLECTION, loadScriptRunSummary } from '~~/server/utils/ai-scripts'
import { stripTriggerEmbeddings } from '~~/server/utils/ai-script-validation'
import type { ScriptNode } from '~~/shared/types/ai-script'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'ai.read')
  const query = getQuery(event)
  const db = getDb()
  // `?runsOf=<id>`：那一條的成效（走完幾位、停在哪一題、為什麼，`D-138`）。
  // ⛔ 掛在清單這支、不另開路由：多開 API 路由會讓不相干的 `$fetch` 型別推導爆掉（TS2589）
  const runsOf = String(query.runsOf ?? '').trim()
  if (runsOf) return loadScriptRunSummary(db, workspaceId, runsOf)
  return queryCollectionPage(
    db,
    ref => ref
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc'),
    SCRIPTS_COLLECTION,
    query,
    (id, data) => {
      const d = data as { nodes?: ScriptNode[] }
      // 不把肥大的 exampleEmbeddings 回給編輯器
      return { id, ...data, ...(Array.isArray(d.nodes) ? { nodes: stripTriggerEmbeddings(d.nodes) } : {}) }
    },
  )
})
