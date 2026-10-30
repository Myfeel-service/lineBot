import { v4 as uuidv4 } from 'uuid'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { loadSheetProductRegistry, rememberSheetCatalogTagPrefix, updateSheetProductRegistry } from './sheet-products'
import { readSheetCatalogSource, sheetCatalogColumns, sheetProductTagName } from '~~/shared/sheet-catalog'
import type { SheetProductRegistry } from '~~/shared/sheet-products'
import type { TagDoc } from '~~/shared/types/tag-broadcast'

/**
 * 商品目錄「照試算表排」的伺服器那半（`C-436`）。規則在 `shared/sheet-catalog.ts`。
 *  - 送出前：照商品清單把卡片產生出來（`hydrateSheetCatalogs`，每一條送模組的路都經過 handler 的 hydrateRichMessageRefs）。
 *  - 存模組時：記下這份試算表有目錄在用、替勾進目錄的商品建標籤（`configureSheetCatalog`）。
 *  - 同步時：新勾進目錄的商品也建標籤（`ensureSheetProductTags`，由 `syncSheetProducts` 呼叫）。
 * ⛔ 送訊息的路不寫任何東西（建標籤只在存模組、同步時做）。
 */

/** 30 秒：目錄是客人按圖文選單就送的，一則讀一次商品清單；試算表最快一小時才同步，短快取省讀取 */
const CACHE_MS = 30_000
const cache = new Map<string, { at: number, reg: SheetProductRegistry | null }>()

/**
 * 送出前把「照試算表排」的卡片訊息換成真的卡片。
 * 一張都沒有（還沒勾、勾了都還沒有圖、讀不到商品清單）＝這一則不送（LINE 不收空的卡片訊息，整包會被退），留 log；
 * 店家那邊的提醒在 `C-438`。
 */
export async function hydrateSheetCatalogs(messages: any[], workspaceId: string): Promise<any[]> {
  if (!Array.isArray(messages) || !messages.some(m => m?.type === 'flexImageCarousel' && m?.sheetSource)) return messages
  const out: any[] = []
  for (const msg of messages) {
    const source = msg?.type === 'flexImageCarousel' ? readSheetCatalogSource(msg) : null
    if (!source) {
      out.push(msg)
      continue
    }
    const { sheetSource: _drop, ...rest } = msg
    const reg = await cachedSheetProductRegistry(workspaceId, source.sourceId)
    const columns = reg && source.tapModuleId ? sheetCatalogColumns(source, reg) : []
    if (!columns.length) {
      console.warn('[sheet-catalog] 商品目錄一張卡都沒有（沒勾「放進LINE目錄」、勾了的都還沒有圖、或讀不到商品清單），這一則不送：', workspaceId, source.sourceId)
      continue
    }
    out.push({ ...rest, columns })
  }
  return out
}

/** 商品清單（30 秒快取，讀不到＝null）。商品資訊範本填「這個商品」也用這份（`C-437`） */
export async function cachedSheetProductRegistry(workspaceId: string, sourceId: string): Promise<SheetProductRegistry | null> {
  const key = `${workspaceId}/${sourceId}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.reg
  let reg: SheetProductRegistry | null = null
  try {
    reg = await loadSheetProductRegistry(getDb(), workspaceId, sourceId)
  }
  catch (e) {
    console.error('[sheet-catalog] 讀不到商品清單：', workspaceId, sourceId, e)
  }
  cache.set(key, { at: Date.now(), reg })
  return reg
}

/** 測試用：清掉 30 秒快取 */
export function clearSheetCatalogCache(): void {
  cache.clear()
}

/**
 * 存模組時（`flow/create`、`flow/[id]` PUT）：模組裡有照試算表排的卡片訊息，就記下「這份試算表有目錄在用」
 * （標籤名稱開頭照模組上設的；沒設過而且以前也沒記＝空字串）並替已經勾進目錄的商品建標籤。
 * ⛔ 失敗不擋存檔（模組已經存好了；標籤下次同步或存檔再補），留 log。
 */
export async function configureSheetCatalogs(db: Firestore, workspaceId: string, messages: any[]): Promise<void> {
  const sources = (Array.isArray(messages) ? messages : [])
    .map(m => (m?.type === 'flexImageCarousel' ? readSheetCatalogSource(m) : null))
    .filter((s): s is NonNullable<typeof s> => !!s?.sourceId)
  for (const s of sources) {
    try {
      // 還沒同步出商品清單也記得住（第一次同步帶進去、照樣建標籤，`C-438` code review）
      await rememberSheetCatalogTagPrefix(db, workspaceId, s.sourceId, s.tagPrefix)
      await ensureSheetProductTags(db, workspaceId, s.sourceId)
    }
    catch (e) {
      console.warn('[sheet-catalog] 存模組時沒設好商品目錄（標籤下次同步再補）：', workspaceId, s.sourceId, e)
    }
  }
}

/**
 * 替「在表上、勾進目錄、還沒有標籤」的商品建標籤（`C-436`）。只有這份試算表有目錄在用（`catalogTagPrefix` 有值）才做。
 * 同名的標籤已經有了（例：店家自己先建好「客服 - BOYA mini2」）＝直接用那一個，⛔ 不另建一個同名的。
 * 回傳這一輪接上標籤的商品數。
 */
export async function ensureSheetProductTags(db: Firestore, workspaceId: string, sourceId: string): Promise<number> {
  const reg = await loadSheetProductRegistry(db, workspaceId, sourceId)
  if (!reg || reg.catalogTagPrefix === undefined) return 0
  const need = Object.values(reg.products).filter(p => p.missingSince === null && p.inCatalog && !p.tagId).slice(0, 20)
  if (!need.length) return 0
  const tagIds = new Map<string, string>()
  for (const p of need) {
    const name = sheetProductTagName(reg.catalogTagPrefix, p.title)
    if (!name) continue
    const same = await db.collection('tags')
      .where('workspaceId', '==', workspaceId)
      .where('name', '==', name)
      .limit(5)
      .get()
    // ⛔ 店家停用（軟刪）的同名標籤不接（`C-438` code review）：接上去＝客人點了貼一個推播挑不到、後台看不到的標籤
    let tagId = same.docs.find(d => (d.data() as { status?: string }).status !== 'inactive')?.id
    if (!tagId) {
      tagId = uuidv4()
      const doc: TagDoc = {
        workspaceId,
        code: `sheet_product_${p.id}`,
        name,
        category: 'interest',
        color: '#6B7280',
        description: '客人在商品目錄點了這個商品（照試算表排的目錄自動建的）',
        status: 'active',
        createdBy: 'system',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }
      await db.collection('tags').doc(tagId).set(doc)
    }
    tagIds.set(p.id, tagId)
  }
  if (!tagIds.size) return 0
  await updateSheetProductRegistry(db, workspaceId, sourceId, (latest) => {
    let changed = false
    const products = { ...latest.products }
    for (const [pid, tagId] of tagIds) {
      const p = products[pid]
      if (!p || p.tagId) continue
      products[pid] = { ...p, aliases: [...p.aliases], tagId }
      changed = true
    }
    return changed ? { ...latest, products } : null
  })
  return tagIds.size
}
