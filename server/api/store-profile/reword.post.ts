import { requireCapability } from '~~/server/utils/workspace-auth'
import { assertMaintenanceBudget, recordAiUsage } from '~~/server/utils/ai-usage'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { hitAgentRateLimit } from '~~/server/utils/agent-rate-limit'
import { rewordStoreDraft, type RewordKey } from '~~/server/utils/store-draft-reword'
import { REWORDABLE_DRAFTS, canBuildDrafts } from '~~/shared/store-profile-drafts'

/**
 * POST /api/store-profile/reword   Body: { key: 'welcome' | 'tone', current?: string }
 *
 * 開帳草稿的「換個說法」（`D-89` ②）：按一次打一次模型、回一版新的文字。
 * ⛔ **只回文字，不寫任何東西**：他還是要在草稿卡上按「採用」（08-14 紅線：最後一顆按鈕留給人）。
 * ⚠️ 用量記在「維運」那一側（跟讀網站同一桶），⛔ 不扣他每月的 AI 回覆額度——那一桶只算回客人的。
 */
const MAX_CURRENT = 4000
/** 同一個人一分鐘最多按幾次（手滑連按型浪費；真正的上限是維運額度那道） */
const REWORD_PER_MINUTE = 8

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'ai.settings.write')
  await assertMaintenanceBudget(workspaceId)

  const body = await readBody(event).catch(() => ({})) as { key?: unknown, current?: unknown }
  const key = String(body?.key ?? '') as RewordKey
  if (!REWORDABLE_DRAFTS.includes(key)) {
    throw createError({ statusCode: 400, statusMessage: '這一樣不能換說法' })
  }
  const rl = hitAgentRateLimit(`reword:${workspaceId}:${uid}`, { max: REWORD_PER_MINUTE })
  if (rl.limited) {
    throw createError({ statusCode: 429, statusMessage: `按太快了，${Math.ceil(rl.retryAfterMs / 1000)} 秒後再換一次` })
  }

  const db = getDb()
  const profile = await getStoreProfile(workspaceId, db)
  if (!canBuildDrafts(profile)) {
    throw createError({ statusCode: 409, statusMessage: 'MiniMe 還不認識你的店，換出來的會是空話。' })
  }
  const wsSnap = await db.collection('workspaces').doc(workspaceId).get()
  const shopName = String((wsSnap.data() as { name?: string } | undefined)?.name ?? '').trim()

  const out = await rewordStoreDraft(workspaceId, key, {
    shopName,
    profile,
    current: String(body?.current ?? '').slice(0, MAX_CURRENT),
  })
  // 維運那一側（⛔ 不寫 billable：這不是回客人的一則）
  if (out.inputTokens || out.outputTokens) {
    await recordAiUsage(workspaceId, {
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      importInputTokens: out.inputTokens,
      importOutputTokens: out.outputTokens,
    }, db).catch(e => console.warn('[store-profile/reword] 記用量失敗：', workspaceId, e))
  }
  if (!out.body) {
    // ⛔ 丟了什麼要說得出來；框裡的字沒動
    console.warn(`[store-profile/reword] ${workspaceId} ${key} 換不出可用的一版：`, out.dropped.map(d => d.reason).join('、'))
    throw createError({
      statusCode: 502,
      statusMessage: `這次換不出可以用的說法${out.dropped[0] ? `（${out.dropped.length} 版沒過檢查，例如：${out.dropped[0].reason}）` : ''}，框裡的字沒動，再按一次試試。`,
    })
  }
  return { body: out.body, dropped: out.dropped }
})
