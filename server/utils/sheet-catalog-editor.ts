import type { H3Event } from 'h3'
import type { Firestore } from 'firebase-admin/firestore'
import { getDb, getStorage } from './firebase'
import { requireCapability } from './workspace-auth'
import { writeAuditLog } from './audit-log'
import { KNOWLEDGE_SOURCES_COLLECTION, listChunksBySource } from './ai-knowledge-sources'
import { loadSheetProductRegistry, revertSheetProductImage, setSheetProductOwnImage, updateSheetProductRegistry } from './sheet-products'
import { clearSheetCatalogCache } from './sheet-catalog'
import { invalidateSheetIssuesCache } from './sheet-issues'
import { liveRenameCandidates, planSheetCatalog, SHEET_CATALOG_MAX_CARDS, type SheetCatalogPlacement, type SheetCatalogView, type SheetCatalogViewProduct } from '~~/shared/sheet-catalog'
import { confirmSheetProductRename, productImage, retireSheetProduct } from '~~/shared/sheet-products'
import { sheetRowKey } from '~~/shared/sheet-field'

/**
 * 機器人模組「商品目錄（照試算表排）」編輯畫面要的資料與動作（`C-436`）。畫面看到的形狀在 `shared/sheet-catalog.ts`。
 * 借既有路由：讀＝`GET /api/flow/list?part=sheet-products&sourceId=`、換圖＝`POST /api/flow/create?part=sheet-product-image`
 * （⛔ 不開新路由：Nitro 路由型別已經貼著 TypeScript 深度上限，見 list.get.ts）。
 */

const toMs = (v: any): number | null => (typeof v?.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : null))

export async function readSheetCatalogView(db: Firestore, workspaceId: string, sourceId: string): Promise<SheetCatalogView> {
  const srcSnap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).get()
  if (!srcSnap.exists || srcSnap.get('workspaceId') !== workspaceId || srcSnap.get('type') !== 'gsheet') {
    throw createError({ statusCode: 404, statusMessage: '找不到這份試算表' })
  }
  const interval = Number(srcSnap.get('refreshIntervalMinutes') ?? 0) || 0
  const base = {
    sourceId,
    sourceName: String(srcSnap.get('name') ?? srcSnap.get('title') ?? '試算表'),
    sheetUrl: String(srcSnap.get('url') ?? ''),
    lastFetchedAt: toMs(srcSnap.get('lastFetchedAt')),
    // 關掉自動同步的表（`gsheetAutoApply === false`）排程不會動它，跟沒設間隔一樣要自己按
    autoSyncMinutes: interval > 0 && srcSnap.get('gsheetAutoApply') !== false ? interval : null,
    max: SHEET_CATALOG_MAX_CARDS,
  }
  const reg = await loadSheetProductRegistry(db, workspaceId, sourceId)
  if (!reg) return { ...base, ready: false, catalogColumn: false, pageHeader: null, products: [], changes: [], locked: [] }

  // `C-453`①：知識庫被手動改過的那幾條＝試算表改了不跟（商品資訊卡讀的也是知識卡）。一份表一次讀完它的卡（最多 150 張）
  const lockedKeys = new Set((await listChunksBySource(db, workspaceId, sourceId))
    .filter(c => c.manuallyEditedAtMs > 0 && !c.isOverview)
    .map(c => sheetRowKey(c.title)))
  // `C-453`⑦：同一個商品頁＝複製上一列忘了改網址（還在表上的才算）
  const byUrl = new Map<string, string[]>()
  for (const p of Object.values(reg.products)) {
    if (p.missingSince !== null || !p.urlKey) continue
    byUrl.set(p.urlKey, [...(byUrl.get(p.urlKey) ?? []), p.title])
  }

  const plan = planSheetCatalog(reg)
  const placeOf = new Map<string, SheetCatalogPlacement>()
  for (const p of plan.cards) placeOf.set(p.id, 'card')
  for (const p of plan.overflow) placeOf.set(p.id, 'overflow')
  for (const p of plan.noImage) placeOf.set(p.id, 'noImage')

  const tagIds = [...new Set(Object.values(reg.products).map(p => p.tagId).filter((t): t is string => !!t))].slice(0, 60)
  const tagNames = new Map<string, string>()
  await Promise.all(tagIds.map(async (id) => {
    const t = await db.collection('tags').doc(id).get()
    if (t.exists && t.get('workspaceId') === workspaceId) tagNames.set(id, String(t.get('name') ?? ''))
  }))

  const products = Object.values(reg.products)
    .map((p): SheetCatalogViewProduct => ({
      id: p.id,
      title: p.title,
      order: p.order,
      placement: p.missingSince !== null ? 'missing' : (placeOf.get(p.id) ?? 'off'),
      image: productImage(p),
      hasCover: !!p.cover?.url,
      hasPageUrl: !!p.pageUrl,
      coverError: p.coverError ? { reason: p.coverError.reason, attempts: p.coverError.attempts } : null,
      tag: p.tagId && tagNames.has(p.tagId) ? { id: p.tagId, name: tagNames.get(p.tagId)! } : null,
      ...(p.missingSince !== null && liveRenameCandidates(reg, p).length
        ? { renameCandidates: liveRenameCandidates(reg, p).map(c => ({ id: c.id, title: c.title })) }
        : {}),
      ...(p.missingSince === null && p.urlKey && (byUrl.get(p.urlKey)?.length ?? 0) > 1
        ? { sameUrlAs: byUrl.get(p.urlKey)!.filter(t => t !== p.title) }
        : {}),
    }))
    .sort((a, b) => Number(a.placement === 'missing') - Number(b.placement === 'missing') || a.order - b.order)

  return {
    ...base,
    ready: true,
    catalogColumn: reg.catalogColumn,
    pageHeader: reg.pageHeader,
    products,
    changes: reg.changes.slice(0, 8),
    locked: Object.values(reg.products)
      .filter(p => p.missingSince === null && (lockedKeys.has(p.nameKey) || lockedKeys.has(sheetRowKey(p.title))))
      .sort((a, b) => a.order - b.order)
      .map(p => p.title),
  }
}

/**
 * 「換圖」「改回商品頁封面圖」（`C-436`）。圖要先用後台的上傳（`/api/upload`）傳上去，這裡只收那個網址，
 * ⛔ 只收這個帳號自己上傳區的網址（別的網址可能隨時被換掉或是別人的圖）。
 */
export async function handleSheetProductImage(event: H3Event) {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const body = (await readBody(event)) as Record<string, unknown> | null
  const sourceId = String(body?.sourceId ?? '').trim()
  const productId = String(body?.productId ?? '').trim()
  const revert = body?.revert === true
  const url = String(body?.url ?? '').trim()
  if (!sourceId || !productId) throw createError({ statusCode: 400, statusMessage: '缺少試算表或商品' })
  if (!revert && !isOwnUploadUrl(url, workspaceId, getStorage().bucket().name)) {
    throw createError({ statusCode: 400, statusMessage: '圖片要用後台的「上傳圖片」傳上來' })
  }
  const db = getDb()
  const before = await loadSheetProductRegistry(db, workspaceId, sourceId)
  const title = before?.products[productId]?.title ?? ''
  const next = revert
    ? await revertSheetProductImage(db, workspaceId, sourceId, productId)
    : await setSheetProductOwnImage(db, workspaceId, sourceId, productId, url)
  if (!next) {
    throw createError({ statusCode: revert ? 409 : 404, statusMessage: revert ? '這個商品沒有換過圖' : '找不到這個商品' })
  }
  const product = next.products[productId]!
  // `C-438`：換上圖＝「抓不到圖」那顆提醒下一次就該消失
  invalidateSheetIssuesCache(workspaceId)
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'sheetProduct.image',
    targetId: `${sourceId}:${productId}`,
    after: { product: title, image: revert ? '改回商品頁封面圖' : '換成自己上傳的圖' },
    note: title,
  })
  return { image: productImage(product), hasCover: !!product.cover?.url }
}

/**
 * 商品目錄上「試算表上找不到」的商品，店家的兩種決定（`C-438`，規格 §5.2）：
 *  - `rename`＋`newId`：是改名，接到新的那一列（圖、標籤、在不在目錄都跟著舊的走，`confirmSheetProductRename`）
 *  - `retire`：不賣了，拿掉（從商品清單拿掉、不再提醒，`retireSheetProduct`）
 * ⛔ 兩種都只收表上已經找不到的商品；還在表上的要到試算表改（後台不拿掉試算表上的東西）。
 */
export async function handleSheetProductDecision(event: H3Event) {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const body = (await readBody(event)) as Record<string, unknown> | null
  const sourceId = String(body?.sourceId ?? '').trim()
  const productId = String(body?.productId ?? '').trim()
  const action = body?.action
  const newId = String(body?.newId ?? '').trim()
  if (!sourceId || !productId) throw createError({ statusCode: 400, statusMessage: '缺少試算表或商品' })
  if (action !== 'rename' && action !== 'retire') throw createError({ statusCode: 400, statusMessage: '不認得這個動作' })
  if (action === 'rename' && !newId) throw createError({ statusCode: 400, statusMessage: '缺少改名後的商品' })
  const db = getDb()
  let title = ''
  let newTitle = ''
  const next = await updateSheetProductRegistry(db, workspaceId, sourceId, (reg) => {
    const p = reg.products[productId]
    // ⛔ 按下去的這段時間，下一輪同步可能已經把它接回來了（店家剛好把那一列加回去）：那就什麼都不做
    if (!p || p.missingSince === null) return null
    title = p.title
    if (action === 'retire') return retireSheetProduct(reg, productId, Date.now())
    const nw = liveRenameCandidates(reg, p).find(c => c.id === newId)
    if (!nw) return null
    newTitle = nw.title
    return confirmSheetProductRename(reg, productId, newId, Date.now())
  })
  if (!next || !title) {
    throw createError({ statusCode: 409, statusMessage: '這個商品已經回到試算表上了（或已經處理過），重新整理看看' })
  }
  clearSheetCatalogCache()
  invalidateSheetIssuesCache(workspaceId)
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: action === 'rename' ? 'sheetProduct.rename' : 'sheetProduct.retire',
    targetId: `${sourceId}:${productId}`,
    after: action === 'rename' ? { product: newTitle, before: title } : { product: title },
    note: action === 'rename' ? `「${title}」→「${newTitle}」` : title,
  })
  return { ok: true }
}

/**
 * 這個帳號在後台上傳的圖（`/api/upload` 存的 `uploads/{wid}/…` 公開網址）。
 * `C-438` code review：⛔ 儲存空間（bucket）也要是我們自己的——以前只看路徑，別人的空間開一個同樣的路徑就過了，
 *   之後對方隨時換掉那張圖，客人看到的目錄卡、商品卡跟著變。
 */
export function isOwnUploadUrl(url: string, workspaceId: string, bucket: string): boolean {
  const m = String(url ?? '').match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/uploads\/([^/]+)\/[^?#]+$/)
  return !!m && !!bucket && m[1] === bucket && m[2] === workspaceId
}
