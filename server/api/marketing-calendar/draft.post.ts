import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
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
