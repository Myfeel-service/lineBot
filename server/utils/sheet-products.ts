import { randomBytes } from 'node:crypto'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { sheetCardField } from '~~/shared/sheet-field'
import {
  findProductPageHeader,
  firstHttpUrl,
  isSheetCatalogHeader,
  parseSheetCheckbox,
  reconcileSheetProducts,
  type SheetProductChange,
  type SheetProductInput,
  type SheetProductRegistry,
} from '~~/shared/sheet-products'
import type { SheetCard } from './google-sheets'

/**
 * 每份 Google 試算表一份「商品清單」（`C-434`）：doc id＝知識庫來源 id。規則在 `shared/sheet-products.ts`。
 * 只有伺服器讀寫（firestore.rules 預設全擋）。
 */
export const SHEET_PRODUCTS_COLLECTION = 'sheetProductRegistries'

/** 商品短代號：點目錄卡片時跟著 postback 走（上限 300 字），10 碼夠用也夠短 */
export function newSheetProductId(): string {
  return randomBytes(5).toString('hex')
}

/** 同步讀到的卡片 → 比對用的列（商品頁取「商品頁面」那格裡第一個網址；勾選取「放進LINE目錄」） */
export function sheetProductInputFromCards(
  cards: readonly SheetCard[],
  fieldHeaders: readonly string[],
  controlHeaders: readonly string[],
): SheetProductInput {
  const pageHeader = findProductPageHeader(fieldHeaders)
  const catalogHeader = controlHeaders.find(h => isSheetCatalogHeader(h)) ?? null
  return {
    rows: cards.map(c => ({
      title: c.title,
      pageUrl: pageHeader ? firstHttpUrl(sheetCardField(c.content, fieldHeaders, pageHeader)) : null,
      inCatalog: catalogHeader ? parseSheetCheckbox(c.controls?.[catalogHeader]) : false,
    })),
    catalogColumn: catalogHeader !== null,
    pageHeader,
  }
}

function toRegistry(data: Record<string, unknown> | undefined): SheetProductRegistry | null {
  if (!data || typeof data.products !== 'object' || data.products === null) return null
  return {
    products: data.products as SheetProductRegistry['products'],
    changes: Array.isArray(data.changes) ? (data.changes as SheetProductChange[]) : [],
    catalogColumn: data.catalogColumn === true,
    pageHeader: typeof data.pageHeader === 'string' ? data.pageHeader : null,
  }
}

/** 讀一份商品清單；沒有（還沒同步過）或不是這個帳號的＝null */
export async function loadSheetProductRegistry(db: Firestore, workspaceId: string, sourceId: string): Promise<SheetProductRegistry | null> {
  const snap = await db.collection(SHEET_PRODUCTS_COLLECTION).doc(sourceId).get()
  if (!snap.exists || snap.get('workspaceId') !== workspaceId) return null
  return toRegistry(snap.data())
}

/**
 * 同步完之後跟上一份比、有變才寫（`C-434`）。表上什麼都沒變的一小時：讀一次、不寫。
 * ⛔ 失敗不擋同步（知識卡已經更新好了，商品清單下一輪再補）——吞錯但留 log。
 * 回傳這一輪的變動（給呼叫端記紀錄、測試用）；失敗＝null。
 */
export async function syncSheetProducts(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  sheet: { cards: readonly SheetCard[], fieldHeaders: readonly string[], controlHeaders: readonly string[] },
): Promise<SheetProductChange[] | null> {
  try {
    const ref = db.collection(SHEET_PRODUCTS_COLLECTION).doc(sourceId)
    const snap = await ref.get()
    if (snap.exists && snap.get('workspaceId') !== workspaceId) return null
    const prev = snap.exists ? toRegistry(snap.data()) : null
    const input = sheetProductInputFromCards(sheet.cards, sheet.fieldHeaders ?? [], sheet.controlHeaders ?? [])
    const { registry, changed, newChanges } = reconcileSheetProducts(prev, input, Date.now(), newSheetProductId)
    if (!changed) return []
    await ref.set({ workspaceId, sourceId, ...registry, updatedAt: FieldValue.serverTimestamp() })
    return newChanges
  }
  catch (e) {
    console.warn('[sheet-products] 商品清單沒更新到（下一輪同步再補）：', workspaceId, sourceId, e)
    return null
  }
}
