import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { confirmAlias, dismissAliasPair, removeAlias } from '~~/server/utils/ai-product-alias'
import { invalidateWorkspaceProductNames } from '~~/server/utils/ai-knowledge-chunks'
import { writeAuditLog } from '~~/server/utils/audit-log'

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
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
  const body = await readBody(event)
  const action = String(body?.action ?? '').trim()
  const db = getDb()

  /**
   * 稽核（`C-254`）：把兩個名字判成同一台商品，會改變 AI 拿哪些卡回答哪一台——
   * 判錯就是「問 A 型號卻拿 B 型號的答案」，那是這個專案修過好幾輪的張冠李戴。
   */
  const audit = (note: string, after: Record<string, unknown>) => writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.productAliases',
    after,
    note,
  }, db)

  if (action === 'confirm') {
    const canonical = String(body?.canonical ?? '').trim()
    const alias = String(body?.alias ?? '').trim()
    if (!canonical || !alias) {
      throw createError({ statusCode: 400, statusMessage: '需要 canonical 與 alias' })
    }
    const changed = await confirmAlias(db, workspaceId, canonical, alias)
    // 正式名會 arrayUnion 進同一份文件的 names;那份清單另有 60 秒快取,
    // 不一併失效的話,接下來一分鐘內建立的卡片認不到剛加進去的正式名。
    if (changed) invalidateWorkspaceProductNames(workspaceId)
    // changed=false:兩者早就指向同一個正式名。回 ok 但標記沒異動,
    // 前端才能說「這組本來就已經合併了」,而不是畫面沒變讓人以為按鈕壞了。
    // ⛔ 沒有真的改到東西就不記（記了會讓紀錄長出一堆什麼都沒發生的列）
    if (changed) await audit(`把「${alias}」併進「${canonical}」，當成同一台`, { productName: canonical, type: '合併' })
    return { ok: true, changed }
  }

  if (action === 'dismiss') {
    const a = String(body?.a ?? '').trim()
    const b = String(body?.b ?? '').trim()
    if (!a || !b) throw createError({ statusCode: 400, statusMessage: '需要 a 與 b' })
    await dismissAliasPair(db, workspaceId, a, b)
    await audit(`確認「${a}」與「${b}」不是同一台，之後不再詢問`, { productName: `${a} / ${b}`, type: '不是同一台' })
    return { ok: true }
  }

  if (action === 'remove') {
    const alias = String(body?.alias ?? '').trim()
    if (!alias) throw createError({ statusCode: 400, statusMessage: '需要 alias' })
    await removeAlias(db, workspaceId, alias)
    await audit(`解除了「${alias}」先前的合併`, { productName: alias, type: '解除合併' })
    return { ok: true }
  }

  throw createError({ statusCode: 400, statusMessage: 'action 必須是 confirm / dismiss / remove' })
})
