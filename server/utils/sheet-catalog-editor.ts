import type { H3Event } from 'h3'
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { requireCapability } from './workspace-auth'
import { writeAuditLog } from './audit-log'
import { KNOWLEDGE_SOURCES_COLLECTION } from './ai-knowledge-sources'
import { loadSheetProductRegistry, revertSheetProductImage, setSheetProductOwnImage } from './sheet-products'
import { planSheetCatalog, SHEET_CATALOG_MAX_CARDS } from '~~/shared/sheet-catalog'
import { productImage, type SheetProductChange, type SheetProductImageFailReason } from '~~/shared/sheet-products'

/**
 * 機器人模組「商品目錄（照試算表排）」編輯畫面要的資料與動作（`C-436`）。
 * 借既有路由：讀＝`GET /api/flow/list?part=sheet-products&sourceId=`、換圖＝`POST /api/flow/create?part=sheet-product-image`
 * （⛔ 不開新路由：Nitro 路由型別已經貼著 TypeScript 深度上限，見 list.get.ts）。
 */

/** 這個商品在目錄上的哪裡（畫面分組用） */
export type SheetCatalogPlacement = 'card' | 'overflow' | 'noImage' | 'off' | 'missing'

export interface SheetCatalogViewProduct {
  id: string
  title: string
  order: number
  placement: SheetCatalogPlacement
  image: { url: string, source: 'own' | 'web' } | null
  /** 有自己換的圖時，封面圖也在（「改回商品頁封面圖」用） */
  hasCover: boolean
  coverError: { reason: SheetProductImageFailReason, attempts: number } | null
  tag: { id: string, name: string } | null
}

export interface SheetCatalogView {
  /** false＝這份試算表還沒同步出商品清單（上線前的表要等下一次同步、或按「立即更新」） */
  ready: boolean
  sourceId: string
  sourceName: string
  /** 「打開試算表 ↗」 */
  sheetUrl: string
  lastFetchedAt: number | null
  /** 表上有沒有「放進LINE目錄」這欄（沒有＝要先加，畫面講缺哪一欄） */
  catalogColumn: boolean
  pageHeader: string | null
  max: number
  products: SheetCatalogViewProduct[]
  /** 「試算表最近的變動」新的在前 */
  changes: SheetProductChange[]
}

const toMs = (v: any): number | null => (typeof v?.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : null))

export async function readSheetCatalogView(db: Firestore, workspaceId: string, sourceId: string): Promise<SheetCatalogView> {
  const srcSnap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).get()
  if (!srcSnap.exists || srcSnap.get('workspaceId') !== workspaceId || srcSnap.get('type') !== 'gsheet') {
    throw createError({ statusCode: 404, statusMessage: '找不到這份試算表' })
  }
  const base = {
    sourceId,
    sourceName: String(srcSnap.get('name') ?? srcSnap.get('title') ?? '試算表'),
    sheetUrl: String(srcSnap.get('url') ?? ''),
    lastFetchedAt: toMs(srcSnap.get('lastFetchedAt')),
    max: SHEET_CATALOG_MAX_CARDS,
  }
  const reg = await loadSheetProductRegistry(db, workspaceId, sourceId)
  if (!reg) return { ...base, ready: false, catalogColumn: false, pageHeader: null, products: [], changes: [] }

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
      coverError: p.coverError ? { reason: p.coverError.reason, attempts: p.coverError.attempts } : null,
      tag: p.tagId && tagNames.has(p.tagId) ? { id: p.tagId, name: tagNames.get(p.tagId)! } : null,
    }))
    .sort((a, b) => Number(a.placement === 'missing') - Number(b.placement === 'missing') || a.order - b.order)

  return {
    ...base,
    ready: true,
    catalogColumn: reg.catalogColumn,
    pageHeader: reg.pageHeader,
    products,
    changes: reg.changes.slice(0, 8),
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
  if (!revert && !isOwnUploadUrl(url, workspaceId)) {
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

/** 這個帳號在後台上傳的圖（`/api/upload` 存的 `uploads/{wid}/…` 公開網址） */
export function isOwnUploadUrl(url: string, workspaceId: string): boolean {
  const m = String(url ?? '').match(/^https:\/\/storage\.googleapis\.com\/[^/]+\/uploads\/([^/]+)\/[^?#]+$/)
  return !!m && m[1] === workspaceId
}
