import { randomBytes } from 'node:crypto'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { sheetCardField } from '~~/shared/sheet-field'
import {
  applyCoverResult,
  findProductPageHeader,
  firstHttpUrl,
  isSheetCatalogHeader,
  parseSheetCheckbox,
  productsNeedingCover,
  reconcileSheetProducts,
  registryNeedsCover,
  revertProductImage,
  setOwnProductImage,
  type SheetProductChange,
  type SheetProductImageFailReason,
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
    ...(typeof data.catalogTagPrefix === 'string' ? { catalogTagPrefix: data.catalogTagPrefix } : {}),
    ...(data.mergedInto && typeof data.mergedInto === 'object' ? { mergedInto: data.mergedInto as Record<string, string> } : {}),
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
 * 用 transaction：抓封面圖的排程（`fillSheetProductCovers`）同時在寫同一份，不鎖住會互相蓋掉。
 * ⛔ 失敗不擋同步（知識卡已經更新好了，商品清單下一輪再補）——吞錯但留 log。
 * 回傳這一輪的變動（給呼叫端記紀錄、測試用）；失敗＝null。
 */
export async function syncSheetProducts(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  sheet: { cards: readonly SheetCard[], fieldHeaders: readonly string[], controlHeaders: readonly string[], stats?: { truncatedByCap?: boolean } },
): Promise<SheetProductChange[] | null> {
  try {
    const ref = db.collection(SHEET_PRODUCTS_COLLECTION).doc(sourceId)
    const input = {
      ...sheetProductInputFromCards(sheet.cards, sheet.fieldHeaders ?? [], sheet.controlHeaders ?? []),
      // `C-445`：讀到 150 列上限的那一輪，沒讀到的不當成「少了」
      truncated: sheet.stats?.truncatedByCap === true,
    }
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists && snap.get('workspaceId') !== workspaceId) return null
      const prev = snap.exists ? toRegistry(snap.data()) : null
      const { registry, changed, newChanges } = reconcileSheetProducts(prev, input, Date.now(), newSheetProductId)
      // `C-438` code review：同步之前就存了商品目錄（只記了標籤開頭，見 rememberSheetCatalogTagPrefix）——第一份商品清單要帶著它
      const pending = snap.exists ? snap.get('pendingCatalogTagPrefix') : undefined
      if (!prev && typeof pending === 'string') registry.catalogTagPrefix = pending
      if (!changed) return []
      tx.set(ref, { workspaceId, sourceId, ...registry, needsCover: registryNeedsCover(registry), updatedAt: FieldValue.serverTimestamp() })
      return newChanges
    })
  }
  catch (e) {
    console.warn('[sheet-products] 商品清單沒更新到（下一輪同步再補）：', workspaceId, sourceId, e)
    return null
  }
}

/**
 * 存商品目錄模組時記下「這份試算表有目錄在用」＋標籤名稱開頭（`C-436`；`C-438` code review 補「還沒同步過」那半）。
 * 沒給開頭＝沿用之前記的，都沒有＝空字串（標籤就叫商品名）。
 * ⛔ 商品清單還沒建（剛接試算表、還沒同步）時，以前直接略過＝開頭沒記到，之後第一次同步也不會建標籤、點目錄不貼標籤。
 *    現在先放一份只有開頭的紀錄（`pendingCatalogTagPrefix`，沒有 products＝讀的人一律當「還沒整理出商品清單」），第一次同步帶進去。
 */
export async function rememberSheetCatalogTagPrefix(db: Firestore, workspaceId: string, sourceId: string, tagPrefix: string | undefined): Promise<void> {
  const ref = db.collection(SHEET_PRODUCTS_COLLECTION).doc(sourceId)
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (snap.exists && snap.get('workspaceId') !== workspaceId) return
    const reg = snap.exists ? toRegistry(snap.data()) : null
    if (reg) {
      const prefix = tagPrefix ?? reg.catalogTagPrefix ?? ''
      if (prefix !== reg.catalogTagPrefix) tx.update(ref, { catalogTagPrefix: prefix, updatedAt: FieldValue.serverTimestamp() })
      return
    }
    const pending = snap.exists ? snap.get('pendingCatalogTagPrefix') : undefined
    const prefix = tagPrefix ?? (typeof pending === 'string' ? pending : '')
    if (snap.exists && pending === prefix) return
    tx.set(ref, { workspaceId, sourceId, pendingCatalogTagPrefix: prefix, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  })
}

/**
 * 改一份商品清單（transaction）。fn 回 null＝不用改。不是這個帳號的、不存在的＝null。
 * `needsCover` 每次跟著重算：排程只查 `needsCover==true` 的 doc，平常一筆都不讀。
 */
export async function updateSheetProductRegistry(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  fn: (reg: SheetProductRegistry) => SheetProductRegistry | null,
): Promise<SheetProductRegistry | null> {
  const ref = db.collection(SHEET_PRODUCTS_COLLECTION).doc(sourceId)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get('workspaceId') !== workspaceId) return null
    const reg = toRegistry(snap.data())
    if (!reg) return null
    const next = fn(reg)
    if (!next) return null
    tx.update(ref, {
      products: next.products,
      changes: next.changes,
      needsCover: registryNeedsCover(next),
      // 商品目錄的設定（`C-436`）：有改才寫
      ...(next.catalogTagPrefix !== undefined && next.catalogTagPrefix !== reg.catalogTagPrefix ? { catalogTagPrefix: next.catalogTagPrefix } : {}),
      // 「是改名」併掉的 id 對照（`C-438` code review）：有改才寫
      ...(next.mergedInto && next.mergedInto !== reg.mergedInto ? { mergedInto: next.mergedInto } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    })
    return next
  })
}

/** 店家在商品目錄「換圖」（`C-435`；畫面與 API 在 `C-436`）。url＝後台上傳完的公開網址 */
export function setSheetProductOwnImage(db: Firestore, workspaceId: string, sourceId: string, productId: string, url: string) {
  return updateSheetProductRegistry(db, workspaceId, sourceId, reg => setOwnProductImage(reg, productId, url, Date.now()))
}

/** 店家按「改回商品頁封面圖」（`C-435`；畫面與 API 在 `C-436`） */
export function revertSheetProductImage(db: Firestore, workspaceId: string, sourceId: string, productId: string) {
  return updateSheetProductRegistry(db, workspaceId, sourceId, reg => revertProductImage(reg, productId))
}

/**
 * 排程：替還沒有封面圖的商品抓商品頁的封面圖（`C-435`）。
 * 不放在試算表同步裡：「立即更新」是店家在等的請求，不能讓它等下載圖片；排程每 10 分鐘一輪，
 * 一輪最多 3 個商品、20 秒內（每個最多約 14 秒：商品頁 6 秒＋圖 8 秒），MYFEEL 15 個商品約 50 分鐘補完。
 * 只查 `needsCover==true` 的商品清單——沒事要做的時候是一個空查詢。
 * 抓不到的照原因記下來（找不到封面圖不重試；連不上、壞圖最多 3 次），⛔ 不默默放棄：提醒（`C-438`）讀這裡。
 * ⚠️ 存進 Storage 失敗（我們這邊的問題）不記失敗次數，下一輪照樣重試。
 */
export async function fillSheetProductCovers(
  db: Firestore,
  opts: { maxProducts?: number, budgetMs?: number } = {},
): Promise<{ tried: number, fetched: number, failed: number }> {
  const maxProducts = opts.maxProducts ?? 3
  const budgetMs = opts.budgetMs ?? 20_000
  const started = Date.now()
  const out = { tried: 0, fetched: 0, failed: 0 }
  const snap = await db.collection(SHEET_PRODUCTS_COLLECTION).where('needsCover', '==', true).limit(10).get()
  if (snap.empty) return out
  // 用到才載入：這支檔案也被「送出前換試算表那一格」（每則訊息都走）引用，⛔ 不要讓送訊息的路多載圖片套件
  const { fetchProductCover, storeProductCover } = await import('./product-cover-image')
  for (const doc of snap.docs) {
    const workspaceId = String(doc.get('workspaceId') ?? '')
    const reg = toRegistry(doc.data())
    if (!workspaceId || !reg) continue
    const todo = productsNeedingCover(reg)
    if (!todo.length) {
      // 旗子沒放下（例如那個商品在這段時間被移出表）：放下，下一輪不再讀它
      await doc.ref.update({ needsCover: false }).catch(() => {})
      continue
    }
    for (const p of todo) {
      if (out.tried >= maxProducts || Date.now() - started > budgetMs) return out
      out.tried++
      const urlKey = p.urlKey!
      const r = await fetchProductCover(p.pageUrl!)
      let result: { ok: true, url: string } | { ok: false, reason: SheetProductImageFailReason }
      if (r.ok) {
        try {
          result = { ok: true, url: await storeProductCover(workspaceId, doc.id, p.id, r.jpeg) }
        }
        catch (e) {
          console.warn('[sheet-products] 封面圖存不進 Storage（下一輪再試）：', workspaceId, doc.id, p.id, e)
          out.failed++
          continue
        }
      }
      else {
        console.warn('[sheet-products] 抓不到封面圖：', workspaceId, p.title, r.reason, r.detail)
        result = { ok: false, reason: r.reason }
      }
      await updateSheetProductRegistry(db, workspaceId, doc.id, latest => applyCoverResult(latest, p.id, urlKey, result, Date.now()))
      if (result.ok) out.fetched++
      else out.failed++
    }
  }
  return out
}
