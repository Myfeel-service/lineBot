import { requireCapability } from '~~/server/utils/workspace-auth'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
import { INACTIVE_TAG_CODE } from '~~/server/utils/inactive-tag'
import { generateBroadcastCopy, generateProposalCopy } from '~~/server/utils/broadcast-copy-gen'
import {
  audienceNoticeText,
  matchAudienceTags,
  productKeywords,
  type AudienceTagLike,
} from '~~/shared/festival-audience'
import { getMarketingEvents } from '~~/server/utils/marketing-events'
import { isOwnEventId, ownEventFestival } from '~~/shared/marketing-events'
import { isStoreProfileReady } from '~~/shared/types/store-profile'
import { TAIWAN_FESTIVALS, type TaiwanFestival } from '~~/shared/taiwan-festivals'
import { BROADCAST_DRAFT_VARIANTS, type BroadcastDraftHandoff } from '~~/shared/broadcast-draft-handoff'
import { workspaceBroadcastTier } from '~~/server/utils/broadcast-plan-gate'
import { broadcastEntryLockText, broadcastLockText, tierAllowsAudience } from '~~/shared/billing/plans'
import { fmt } from '~~/shared/friend-report'
import type { TagDoc } from '~~/shared/types/tag-broadcast'

/**
 * POST /api/marketing-calendar/draft   Body: { festivalId } 或 { tagId, festivalId? }
 *
 * 幫一檔節慶擬推播文案三版＋挑好受眾標籤（`D-85` / `C-225`）。
 * `D-155` 起多一種：好友統計的**行銷提案**——帶 `tagId` 就是「發給這顆標籤的人」，
 * 受眾就是那一顆（不再配對），檔期選填（提案搭的那一檔）。
 * ⚠️ 刻意併在這一支、不另開路由：擬推播文案只該有一個地方（驗法、方案鎖、輪廓檢查都在這裡），
 *    而且多開一支 API 路由會讓不相干的 `$fetch` 型別太深（記憶 `reference_nuxt_typecheck_traps`）。
 *
 * ⛔ **只產文字，不建立任何東西**：不開推播、不排程、不送出。
 *    回去之後由推播頁開一張**還沒存檔**的草稿（`C-221` 同一條紅線：
 *    對客人說話的東西，最後一顆按鈕永遠是人）。
 * ⛔ **沒有輪廓就不要擬**：沒有商品資訊寫出來的是空話，不如叫他先花三分鐘。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'broadcast.write')
  await assertMaintenanceBudget(workspaceId)

  const body = await readBody(event).catch(() => ({})) as { festivalId?: string, tagId?: string }
  const festivalId = String(body?.festivalId ?? '').trim()
  const tagId = String(body?.tagId ?? '').trim()
  const db = getDb()

  // `D-122`②：店家自己的檔期也可以擬（id 是 `own-` 開頭，從這個帳號自己的那份找；⛔ 找不到別家的）
  let festival: TaiwanFestival | undefined
  if (festivalId) {
    const own = isOwnEventId(festivalId)
      ? (await getMarketingEvents(db, workspaceId)).find(e => e.id === festivalId)
      : undefined
    festival = own ? ownEventFestival(own) : TAIWAN_FESTIVALS.find(f => f.id === festivalId)
  }
  // 提案的檔期只是加分：那一檔剛被刪掉也照樣擬（只是不提檔期）；節慶模式沒有檔期就沒東西可擬
  if (!tagId && !festival) {
    throw createError({ statusCode: 400, statusMessage: '找不到這個檔期' })
  }

  /**
   * `C-352`①：方案發不了推播（免費）就不擬——擬了也送不出去，還白花一次 AI。
   * 提案一定是「依標籤」發，所以要看能不能分眾（輕量／入門只能發全部好友）。
   * 讀不到方案（null）照 fail-open 放行，同推播頁與送出端。
   */
  const tier = await workspaceBroadcastTier(workspaceId, db)
  const planLock = broadcastEntryLockText(tier, tagId ? 'tags' : 'all')
  if (planLock) throw createError({ statusCode: 403, statusMessage: planLock })

  const profile = await getStoreProfile(workspaceId, db)
  if (!isStoreProfileReady(profile)) {
    // ⛔ 誠實擋下來，不要生一堆空話
    throw createError({
      statusCode: 409,
      statusMessage: tagId
        ? 'MiniMe 還不認識你的店，擬出來的文案會是空話。先花 3 分鐘讓它認識，再回來擬這一則。'
        : 'MiniMe 還不認識你的店，擬出來的文案會是空話。先花 3 分鐘讓它認識，再回來擬這一檔。',
    })
  }

  if (tagId) return await proposalDraft(db, workspaceId, profile, tagId, festival ?? null)

  const { variants, dropped } = await generateBroadcastCopy(workspaceId, profile, festival!)
  if (!variants.length) {
    // ⛔ 丟了什麼要說得出來（`dropped` 帶著原因）
    throw createError({
      statusCode: 502,
      statusMessage: `這次擬不出可以用的文案${dropped.length ? `（${dropped.length} 版沒過檢查：${dropped[0]!.reason}）` : ''}，再按一次試試。`,
    })
  }

  /**
   * ── 受眾：這一檔要推的商品 × 誰想要那個商品（`C-235` 換掉的規則）──
   *
   * ⚠️ 原本是拿「送禮／禮盒／回購」這些字去比對標籤名。2026-09-23 拿 MYFEEL 正式資料
   *   跑過：39 顆啟用中的標籤、**九個節日有八個一顆都挑不到**（店家的標籤是商品名與意圖，
   *   不是場合字）。規則與理由都搬進 `shared/festival-audience.ts`，那裡有 20 條測試
   *   釘著，⛔ 不要在這支端點裡再長出第二套判斷。
   */
  let suggestedTagIds: string[] = []
  let audienceNotice = ''
  /**
   * `C-352`①：方案只能發全部好友（輕量／入門）就**不挑標籤**——挑了，推播頁那一格是鎖住的，
   * 他得自己改回全部好友才送得出去。文案照擬（這顆按鈕要的就是文案），受眾那句直接講推播頁那一句。
   * ⛔ 不是「偷偷改成全部好友」：標籤是 MiniMe 的建議、不是他挑的；而且帶過去時那一句會講出來。
   */
  if (tier && !tierAllowsAudience(tier, 'tags')) {
    audienceNotice = broadcastLockText(tier) ?? ''
  }
  else {
    try {
      const snap = await db.collection('tags')
        .where('workspaceId', '==', workspaceId)
        .where('status', '==', 'active')
        .limit(60)
        .get()
      const rows: AudienceTagLike[] = snap.docs.map((d) => {
        const v = d.data() as { name?: string, aiMode?: string, code?: string }
        return { id: d.id, name: String(v.name ?? ''), aiMode: v.aiMode }
      })
      // ⛔ 用 code 反查不要寫死 id：那顆是每個工作區各自建的
      const excludeTagIds = snap.docs
        .filter(d => (d.data() as { code?: string }).code === INACTIVE_TAG_CODE)
        .map(d => d.id)

      const counts: Record<string, number> = rows.length
        ? await memberCountsForTagIds(db, workspaceId, rows.map(t => t.id)).catch(() => ({} as Record<string, number>))
        : {}

      const matched = matchAudienceTags(rows, counts, {
        festivalName: festival!.name,
        products: productKeywords(String(profile.fields?.products?.value ?? '')),
        excludeTagIds,
      })
      suggestedTagIds = matched.suggestions.map(s => s.tagId)
      audienceNotice = audienceNoticeText(matched)
    }
    catch (e) {
      // ⛔ 挑不到不是失敗（文案還是有用），但**不可以安靜**：讓他知道這一步沒跑成
      console.warn('[marketing-draft] 受眾配對失敗：', workspaceId, e)
      audienceNotice = '這次挑不出受眾（讀標籤時出錯），發送對象要你自己挑。'
    }
  }

  const payload: BroadcastDraftHandoff = {
    festivalId: festival!.id,
    festivalName: festival!.name,
    suggestedName: `${festival!.name}檔期`,
    variants: variants.slice(0, BROADCAST_DRAFT_VARIANTS),
    suggestedTagIds,
    audienceNotice,
    basis: `照你的輪廓（${[profile.fields?.industry?.value, profile.fields?.products?.value].filter(Boolean).join('、')}）寫的`,
    ts: Date.now(),
  }
  return { ...payload, dropped }
})

/**
 * 好友統計的行銷提案（`D-155`）：發給這顆標籤的人，可能搭一檔。
 * ⛔ 受眾就是提案的那一顆，**不再配對別的標籤**——提案講的是「這 55 位」，帶過去變成別群人就是兩件事。
 */
async function proposalDraft(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  profile: NonNullable<Awaited<ReturnType<typeof getStoreProfile>>>,
  tagId: string,
  festival: TaiwanFestival | null,
) {
  const snap = await db.collection('tags').doc(tagId).get()
  const tag = snap.exists ? snap.data() as Partial<TagDoc> : null
  // ⛔ 別家的標籤、停用的標籤一律當找不到（不說「那是別家的」）
  if (!tag || tag.workspaceId !== workspaceId || tag.status === 'inactive') {
    throw createError({ statusCode: 404, statusMessage: '那顆標籤現在找不到了（可能剛被停用或刪掉），重新產生一次報告看看。' })
  }
  const tagName = String(tag.name ?? '')
  const tagMeaning = [tag.description, tag.aiCriteria].map(s => String(s ?? '').trim()).filter(Boolean).join('；')

  const { variants, dropped } = await generateProposalCopy(workspaceId, profile, { tagName, tagMeaning, festival })
  if (!variants.length) {
    throw createError({
      statusCode: 502,
      statusMessage: `這次擬不出可以用的文案${dropped.length ? `（${dropped.length} 版沒過檢查：${dropped[0]!.reason}）` : ''}，再按一次試試。`,
    })
  }

  // 人數只是講給他聽的（推播頁送出時會照當下的標籤重算）；讀不到就不講數字，⛔ 不寫 0
  const count = await memberCountsForTagIds(db, workspaceId, [tagId]).then(c => c[tagId] ?? null).catch(() => null)
  const payload: BroadcastDraftHandoff = {
    festivalId: festival?.id ?? '',
    festivalName: festival?.name ?? tagName,
    suggestedName: festival ? `${tagName}・${festival.name}` : tagName,
    variants: variants.slice(0, BROADCAST_DRAFT_VARIANTS),
    suggestedTagIds: [tagId],
    audienceNotice: count === null ? `發送對象選好「${tagName}」。` : `發送對象選好「${tagName}」（目前 ${fmt(count)} 位）。`,
    basis: `照你的輪廓與「${tagName}」這群人寫的`,
    proposalTagId: tagId,
    ts: Date.now(),
  }
  return { ...payload, dropped }
}
