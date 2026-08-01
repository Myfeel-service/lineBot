import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { confirmAlias, dismissAliasPair, removeAlias } from '~~/server/utils/ai-product-alias'

/**
 * POST /api/ai/knowledge/product-aliases
 * Body: { action: 'confirm' | 'dismiss' | 'remove', canonical?, alias?, a?, b? }
 *
 * 產品別名對照的三種決定：
 *   confirm — 這兩個是同一台（alias 併到 canonical）
 *   dismiss — 不是同一台（記下來不再詢問）
 *   remove  — 解除先前確認過的對照
 *
 * 確認後不強制重建索引：卡片舊的產品名前綴留著反而有助於用別名搜尋，
 * 答題端會即時用對照表歸一（分組、防混答、context 標示都吃得到）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'sources.write')
  const body = await readBody(event)
  const action = String(body?.action ?? '').trim()
  const db = getDb()

  if (action === 'confirm') {
    const canonical = String(body?.canonical ?? '').trim()
    const alias = String(body?.alias ?? '').trim()
    if (!canonical || !alias) {
      throw createError({ statusCode: 400, statusMessage: '需要 canonical 與 alias' })
    }
    await confirmAlias(db, workspaceId, canonical, alias)
    return { ok: true }
  }

  if (action === 'dismiss') {
    const a = String(body?.a ?? '').trim()
    const b = String(body?.b ?? '').trim()
    if (!a || !b) throw createError({ statusCode: 400, statusMessage: '需要 a 與 b' })
    await dismissAliasPair(db, workspaceId, a, b)
    return { ok: true }
  }

  if (action === 'remove') {
    const alias = String(body?.alias ?? '').trim()
    if (!alias) throw createError({ statusCode: 400, statusMessage: '需要 alias' })
    await removeAlias(db, workspaceId, alias)
    return { ok: true }
  }

  throw createError({ statusCode: 400, statusMessage: 'action 必須是 confirm / dismiss / remove' })
})
