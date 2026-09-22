import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
import { generateBroadcastCopy } from '~~/server/utils/broadcast-copy-gen'
import { isStoreProfileReady } from '~~/shared/types/store-profile'
import { TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'
import { BROADCAST_DRAFT_VARIANTS, type BroadcastDraftHandoff } from '~~/shared/broadcast-draft-handoff'

/**
 * POST /api/marketing-calendar/draft   Body: { festivalId }
 *
 * 幫一檔節慶擬推播文案三版＋挑好受眾標籤（`D-85` / `C-225`）。
 *
 * ⛔ **只產文字，不建立任何東西**：不開推播、不排程、不送出。
 *    回去之後由推播頁開一張**還沒存檔**的草稿（`C-221` 同一條紅線：
 *    對客人說話的東西，最後一顆按鈕永遠是人）。
 * ⛔ **沒有輪廓就不要擬**：沒有商品資訊寫出來的是空話，不如叫他先花三分鐘。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  await assertMaintenanceBudget(workspaceId)

  const body = await readBody(event).catch(() => ({})) as { festivalId?: string }
  const festivalId = String(body?.festivalId ?? '').trim()
  const festival = TAIWAN_FESTIVALS.find(f => f.id === festivalId)
  if (!festival) {
    throw createError({ statusCode: 400, statusMessage: '找不到這個檔期' })
  }

  const db = getDb()
  const profile = await getStoreProfile(workspaceId, db)
  if (!isStoreProfileReady(profile)) {
    // ⛔ 誠實擋下來，不要生一堆空話
    throw createError({
      statusCode: 409,
      statusMessage: 'MiniMe 還不認識你的店，擬出來的文案會是空話。先花 3 分鐘讓它認識，再回來擬這一檔。',
    })
  }

  const { variants, dropped } = await generateBroadcastCopy(workspaceId, profile, festival)
  if (!variants.length) {
    // ⛔ 丟了什麼要說得出來（`dropped` 帶著原因）
    throw createError({
      statusCode: 502,
      statusMessage: `這次擬不出可以用的文案${dropped.length ? `（${dropped.length} 版沒過檢查：${dropped[0]!.reason}）` : ''}，再按一次試試。`,
    })
  }

  // ── 受眾：挑名字跟這一檔對得上、而且真的有人的標籤 ──────────────
  let suggestedTagIds: string[] = []
  try {
    const snap = await db.collection('tags')
      .where('workspaceId', '==', workspaceId)
      .where('status', '==', 'active')
      .limit(60)
      .get()
    const rows = snap.docs.map(d => ({ id: d.id, name: String((d.data() as { name?: string }).name ?? '') }))
    const matched = rows.filter(t =>
      t.name.includes(festival.name)
      || (/春節|中秋|除夕|聖誕|情人|母親節|父親節/.test(festival.name) && /送禮|禮盒|贈禮/.test(t.name))
      || (/雙 ?11|購物節/.test(festival.name) && /回購|囤貨|揪團|優惠/.test(t.name)))
    if (matched.length) {
      const counts: Record<string, number> = await memberCountsForTagIds(db, workspaceId, matched.map(t => t.id))
        .catch(() => ({} as Record<string, number>))
      // ⛔ 人數 0 的不要選：挑了等於發給沒有人
      suggestedTagIds = matched.filter(t => (counts[t.id] ?? 0) > 0).map(t => t.id).slice(0, 3)
    }
  }
  catch { /* 挑不到就讓他自己挑，不是失敗 */ }

  const payload: BroadcastDraftHandoff = {
    festivalId: festival.id,
    festivalName: festival.name,
    suggestedName: `${festival.name}檔期`,
    variants: variants.slice(0, BROADCAST_DRAFT_VARIANTS),
    suggestedTagIds,
    basis: `照你的輪廓（${[profile.fields?.industry?.value, profile.fields?.products?.value].filter(Boolean).join('、')}）寫的`,
    ts: Date.now(),
  }
  return { ...payload, dropped }
})
