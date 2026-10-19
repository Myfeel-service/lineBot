import { FieldValue, type Timestamp } from 'firebase-admin/firestore'
import { requireSuperAdmin, trustedEmail } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { parseFixedCostItem, parseFixedCostItems, type FixedCostItem } from '~~/shared/fixed-costs'

/**
 * GET／PUT /api/admin/super/fixed-costs — 成本總覽的「非 AWS 的固定支出」手填清單（`D-47`③）。僅 super admin。
 *
 * 存在 `platformSettings/fixedCosts`：平台層設定、不屬於任何租戶（也不會出現在任何租戶的畫面）。
 * PUT 整份覆寫（清單最多 20 筆，沒有併發改同一筆的需求）；任何一筆不合格整份退回，⛔ 不默默丟掉那一筆。
 * GET 讀到壞掉的那筆（手動改過資料庫之類）會略過但**回報略過幾筆**（`dropped`），畫面要講出來。
 *
 * ⚠️ GET／PUT 併在同一支檔案（用 getMethod 分）：這個專案多開 API 路由會讓不相干的 `$fetch` 型別爆
 *    TS2589（記憶 reference_nuxt_typecheck_traps），一支檔案就不會多一條路由型別。
 */
const PLATFORM_SETTINGS_COLLECTION = 'platformSettings'
const FIXED_COSTS_DOC_ID = 'fixedCosts'

interface FixedCostsDoc {
  items?: unknown[]
  updatedAt?: Timestamp
  updatedBy?: string
}

export default defineEventHandler(async (event) => {
  const { uid, token } = await requireSuperAdmin(event)
  const db = getDb()
  const ref = db.collection(PLATFORM_SETTINGS_COLLECTION).doc(FIXED_COSTS_DOC_ID)
  const method = getMethod(event)

  if (method === 'GET') {
    const snap = await ref.get()
    const data = (snap.exists ? snap.data() : {}) as FixedCostsDoc
    const raw = Array.isArray(data.items) ? data.items : []
    const items: FixedCostItem[] = []
    for (const r of raw) {
      const p = parseFixedCostItem(r)
      if (p.ok) items.push(p.item)
    }
    return {
      items,
      dropped: raw.length - items.length,
      updatedAt: data.updatedAt?.toMillis?.() ?? null,
      updatedBy: data.updatedBy ?? null,
    }
  }

  if (method === 'PUT') {
    const body = await readBody(event)
    const parsed = parseFixedCostItems(body?.items)
    if (!parsed.ok) throw createError({ statusCode: 400, statusMessage: parsed.error })

    const before = await ref.get()
    const beforeItems = (before.exists ? (before.data() as FixedCostsDoc).items : null) ?? []
    const updatedBy = trustedEmail(token) ?? uid
    await ref.set({ items: parsed.items, updatedAt: FieldValue.serverTimestamp(), updatedBy })

    await writeAuditLog({
      workspaceId: '',
      scope: 'platform',
      uid,
      actor: 'human',
      action: 'super.fixedCosts',
      targetId: FIXED_COSTS_DOC_ID,
      before: { items: beforeItems },
      after: { items: parsed.items },
      note: `成本總覽的手填固定支出改成 ${parsed.items.length} 筆`,
    }, db)

    return { items: parsed.items, dropped: 0, updatedAt: Date.now(), updatedBy }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
