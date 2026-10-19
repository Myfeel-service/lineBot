import { requireCapability } from '~~/server/utils/workspace-auth'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
import { INACTIVE_TAG_CODE } from '~~/server/utils/inactive-tag'
import { generateBroadcastCopy } from '~~/server/utils/broadcast-copy-gen'
import {
  audienceNoticeText,
  matchAudienceTags,
  productKeywords,
  type AudienceTagLike,
} from '~~/shared/festival-audience'
import { getMarketingEvents } from '~~/server/utils/marketing-events'
import { isOwnEventId, ownEventFestival } from '~~/shared/marketing-events'
import { isStoreProfileReady } from '~~/shared/types/store-profile'
import { TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'
import { BROADCAST_DRAFT_VARIANTS, type BroadcastDraftHandoff } from '~~/shared/broadcast-draft-handoff'
import { workspaceBroadcastTier } from '~~/server/utils/broadcast-plan-gate'
import { broadcastEntryLockText, broadcastLockText, tierAllowsAudience } from '~~/shared/billing/plans'

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
  const { workspaceId } = await requireCapability(event, 'broadcast.write')
  await assertMaintenanceBudget(workspaceId)

  const body = await readBody(event).catch(() => ({})) as { festivalId?: string }
  const festivalId = String(body?.festivalId ?? '').trim()
  const db = getDb()
  // `D-122`②：店家自己的檔期也可以擬（id 是 `own-` 開頭，從這個帳號自己的那份找；⛔ 找不到別家的）
  const own = isOwnEventId(festivalId)
    ? (await getMarketingEvents(db, workspaceId)).find(e => e.id === festivalId)
    : undefined
  const festival = own ? ownEventFestival(own) : TAIWAN_FESTIVALS.find(f => f.id === festivalId)
  if (!festival) {
    throw createError({ statusCode: 400, statusMessage: '找不到這個檔期' })
  }

  /**
   * `C-352`①：方案發不了推播（免費）就不擬——擬了也送不出去，還白花一次 AI。
   * 首頁卡片在入口就鎖住同一句；這裡是讀不到方案時畫面沒鎖、或直接打 API 的那條路。
   * 讀不到方案（null）照 fail-open 放行，同推播頁與送出端。
   */
  const tier = await workspaceBroadcastTier(workspaceId, db)
  const planLock = broadcastEntryLockText(tier, 'all')
  if (planLock) throw createError({ statusCode: 403, statusMessage: planLock })

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
        festivalName: festival.name,
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
    festivalId: festival.id,
    festivalName: festival.name,
    suggestedName: `${festival.name}檔期`,
    variants: variants.slice(0, BROADCAST_DRAFT_VARIANTS),
    suggestedTagIds,
    audienceNotice,
    basis: `照你的輪廓（${[profile.fields?.industry?.value, profile.fields?.products?.value].filter(Boolean).join('、')}）寫的`,
    ts: Date.now(),
  }
  return { ...payload, dropped }
})
