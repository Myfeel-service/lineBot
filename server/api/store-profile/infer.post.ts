import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile, saveStoreProfile } from '~~/server/utils/store-profile'
import { describeInferSources, hasEnoughToInfer, inferProfileFromExisting } from '~~/server/utils/store-profile-infer'
import { isStoreProfileReady, mergeAiGuesses } from '~~/shared/types/store-profile'

/**
 * POST /api/store-profile/infer
 *
 * 老店反推（`C-222`）：從既有的知識庫、標籤、活動猜出這家店的輪廓。
 * 猜出來的一律標 `ai`；⛔ 商家改過的欄位由 `mergeAiGuesses` 跳過，這裡不繞過它。
 *
 * ⚠️ 這支**同步**做（撈資料＋一次 LLM，約 5–10 秒），沒有做成 job：
 * 它只讀名字級的欄位、不抓外部網站，時間可控。⛔ 如果日後把它擴成「連內文一起讀」，
 * 要先改成分步 job，不然又是一支會 504 的端點。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  await assertMaintenanceBudget(workspaceId)

  const db = getDb()
  const wsSnap = await db.collection('workspaces').doc(workspaceId).get()
  const workspaceName = String((wsSnap.data() as { name?: string } | undefined)?.name ?? '').trim()

  const { guesses, sources } = await inferProfileFromExisting(workspaceId, workspaceName, db)

  // ⛔ 資料不夠就誠實回「猜不出來」，不要硬生一份憑空捏造的輪廓
  if (!hasEnoughToInfer(sources)) {
    return {
      ok: false,
      reason: 'not_enough_data',
      note: describeInferSources(sources),
      filled: [] as string[],
      profile: await getStoreProfile(workspaceId, db),
      ready: false,
    }
  }

  const before = await getStoreProfile(workspaceId, db)
  const merged = mergeAiGuesses(before, guesses, Date.now())
  await saveStoreProfile(workspaceId, merged.profile, db)

  return {
    ok: true,
    note: describeInferSources(sources),
    filled: merged.filled,
    skippedOwnerEdited: merged.skippedOwnerEdited,
    profile: merged.profile,
    ready: isStoreProfileReady(merged.profile),
  }
})
