import { requireCapability } from '~~/server/utils/workspace-auth'
import { getAiSettings, setAiSettings } from '~~/server/utils/ai-settings'
import { getStoreProfile, saveStoreProfile, type StoreProfilePatch } from '~~/server/utils/store-profile'
import { writeAuditLog } from '~~/server/utils/audit-log'
import {
  isStoreProfileReady,
  normalizeSiteUrl,
  setStoreProfileField,
  STORE_PROFILE_FIELDS,
  type StoreProfileDoc,
  type StoreProfileFieldId,
} from '~~/shared/types/store-profile'

/**
 * POST /api/store-profile
 *
 * 存店家輪廓。Body：
 *   - `fields`：{ 欄位 id: 值 }，只送要改的那幾格（空字串＝清空這一格）
 *   - `siteUrl`：官網／商品頁網址
 *   - `source`：這批值是誰給的，預設 `owner`
 *
 * ⚠️ 從這支進來的東西**預設就是商家給的**（精靈問來的、或他在卡片上改的），
 *    所以一律標 `owner`、帶 `ownerEdited`——之後 AI 重讀網站不會蓋掉它。
 *    AI 猜的走 `mergeAiGuesses`，不從這支進來。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'ai.settings.write')
  const body = await readBody(event).catch(() => ({})) as {
    fields?: StoreProfilePatch
    siteUrl?: string
    source?: 'owner' | 'conversation'
  }

  const source = body.source === 'conversation' ? 'conversation' : 'owner'
  const now = Date.now()

  let profile: StoreProfileDoc = await getStoreProfile(workspaceId)
  // 稽核要用的「改之前」：⛔ 一定要在下面那個迴圈**改到它之前**先抄下來
  const beforeFields = { ...(profile.fields ?? {}) }
  const beforeSiteUrl = profile.siteUrl

  const patch = (body.fields ?? {}) as Record<string, unknown>
  const validIds = new Set<string>(STORE_PROFILE_FIELDS.map(f => f.id))
  const unknownKeys: string[] = []
  for (const [key, raw] of Object.entries(patch)) {
    // ⛔ 不認得的欄位不可以靜默吞掉：前端改名沒跟上時，存檔會「看起來成功、其實沒存」。
    if (!validIds.has(key)) {
      unknownKeys.push(key)
      continue
    }
    profile = setStoreProfileField(profile, key as StoreProfileFieldId, String(raw ?? ''), source, now)
  }
  if (unknownKeys.length) {
    throw createError({
      statusCode: 400,
      statusMessage: `不認得這些欄位：${unknownKeys.join('、')}`,
    })
  }

  if (typeof body.siteUrl === 'string') profile.siteUrl = normalizeSiteUrl(body.siteUrl)

  await saveStoreProfile(workspaceId, profile)

  // 商店網址「只填空、不覆蓋」：`aiSettings.shopUrl` 是 AI 回答客人時附的購買連結，
  // 九成情況就是同一個網址。原本是空的就幫他填一次，省一趟設定；
  // ⛔ 已經有值就不動——那是他自己挑過的連結，而且雙向同步＝兩本帳互相蓋。
  let filledShopUrl = false
  if (profile.siteUrl) {
    try {
      const ai = await getAiSettings(workspaceId)
      if (!String(ai.shopUrl || '').trim()) {
        // ⛔ 只送 shopUrl 這一格：setAiSettings 是深合併，整包送回去等於把
        //    這期間別處改過的設定用舊值蓋掉（subscription map 整包覆蓋那種事故的同型）
        await setAiSettings(workspaceId, { shopUrl: profile.siteUrl })
        filledShopUrl = true
      }
    }
    catch {
      // 這是加分項，失敗不該讓輪廓存不起來（輪廓本身上面已經存好了）
    }
  }

  /*
   * 稽核（`C-254`）：這一份的內容**直接被組進 AI 的 systemPrompt**，
   * 改了它等於換了 AI 的人設——它比大部分「設定」都更該留下紀錄。
   * ⛔ 只記真的有變的那幾格，欄位名用畫面上的中文（`industry` 對店家沒有意義）。
   */
  const changedBefore: Record<string, unknown> = {}
  const changedAfter: Record<string, unknown> = {}
  const labelOf = (id: string) => STORE_PROFILE_FIELDS.find(f => f.id === id)?.label ?? id
  for (const key of Object.keys(patch)) {
    const b = String(beforeFields[key as StoreProfileFieldId]?.value ?? '')
    const a = String(profile.fields?.[key as StoreProfileFieldId]?.value ?? '')
    if (b === a) continue
    changedBefore[labelOf(key)] = b
    changedAfter[labelOf(key)] = a
  }
  if (profile.siteUrl !== beforeSiteUrl) {
    changedBefore.url = beforeSiteUrl
    changedAfter.url = profile.siteUrl
  }
  if (Object.keys(changedAfter).length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'storeProfile.put',
      before: changedBefore,
      after: changedAfter,
      ...(filledShopUrl ? { note: '同時把商店網址填進了 AI 設定（原本是空的）' } : {}),
    })
  }

  return { ok: true, profile, ready: isStoreProfileReady(profile), filledShopUrl }
})
