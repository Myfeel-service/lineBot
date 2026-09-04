import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getWorkspaceProductNames, KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { canonicalProductName, dedupeProductNames, getProductAliases } from '~~/server/utils/ai-product-alias'

/**
 * GET /api/ai/knowledge/product-names
 *
 * 「所屬產品」欄位的候選清單：這個帳號已經在用的產品名。
 *
 * 為什麼要有這支：產品名原本兩處都是空白手打，同一台機器打成「GPLUS 智慧除濕機 12L」與
 * 「GPLUS除濕機12公升」，AI 就當成兩台不同的機器——客人問保固會被反問「您指的是哪一台」，
 * 還列出兩個其實一樣的選項。有清單可挑，第二次就選得到第一次那個名字，源頭上不會分岔。
 * （`product-aliases` 那支也回 productNames，但它同時要掃 300 筆來源算合併候選；
 *   填欄位只需要名字，所以另開這支輕的：產品索引 + 別名對照各一份文件，都有快取。）
 *
 * 已經確認「是同一台」而被合併掉的舊叫法會收斂成正式名——不然剛清乾淨的別名
 * 又會排在下拉裡等人選回去。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const db = getDb()

  const [names, aliasMap] = await Promise.all([
    getWorkspaceProductNames(db, workspaceId),
    getProductAliases(db, workspaceId),
  ])

  const canonical = dedupeProductNames(
    names.map(n => canonicalProductName(n, aliasMap.aliases)).filter(Boolean),
  ).sort((a, b) => a.localeCompare(b, 'zh-TW'))

  /**
   * 每個名字目前有幾張卡在用（`C-136`）。
   *
   * 為什麼不是「把沒人用的名字刪掉」：這份清單裡有**刻意種進去、還沒有卡片的別名**
   * （用來讓之後匯入的卡片靠標題認領產品），從來源反推不出哪些是這種，
   * 全量重建會把它們洗掉——所以設計上就是只增不減（見 `addWorkspaceProductName`）。
   * 但「只增不減」的代價是下拉愈長愈亂：2026-09-04 盤點時 MYFEEL 20 個名字裡有 5 個
   * 沒有任何卡片在用，其中「MATELASER《筋牌特務》 W1 REGEN」與
   * 「MATELASER 筋牌特務 W1 REGEN」只差標點——挑錯就是同一台被當成兩台。
   * 所以改成**把數字講出來**讓人自己分得清，而不是替他決定刪誰。
   *
   * ⛔用 count() 聚合逐名查，不要把卡片整批讀回來自己數：後者是每次開下拉就數百次讀取
   * （2026-08-11 讀取費暴衝就是這種形狀）。這裡是 N 個名字 ≈ N 次讀，N 是個位數到數十。
   * 失敗不擋欄位：拿不到數字就是不顯示，不能讓下拉整個開不出來。
   */
  const usage: Record<string, number> = {}
  await Promise.all(canonical.map(async (name) => {
    try {
      const base = db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
        .where('workspaceId', '==', workspaceId)
        .where('productName', '==', name)
      /**
       * ⛔ **不可以寫成 `where('isDeleted', '==', false)`**（2026-09-04 實測踩到）：
       * 舊卡片根本沒有這個欄位，等值條件會把它們整批濾掉——實測 MYFEEL「GPLUS 除濕機」
       * 這樣查回 **0 張**，實際有 100 張。查詢不會報錯，只會回一個**假數字**，
       * 而假數字比沒有數字更糟（人會照著它做決定）。
       * 正解與 `countSourceChunks` 同一招：先數全部，再扣掉明確標記已刪的（兩次都是聚合，各約 1 次讀）。
       */
      const [allAgg, deletedAgg] = await Promise.all([
        base.count().get(),
        base.where('isDeleted', '==', true).count().get(),
      ])
      usage[name] = Math.max(0, allAgg.data().count - deletedAgg.data().count)
    }
    catch (e) {
      console.warn('[product-names] 算不出「幾張卡在用」:', (e as Error)?.message)
    }
  }))

  return {
    /** 下拉裡可以挑的（已收斂成正式名） */
    names: canonical,
    /** 每個名字目前有幾張卡在用；查不到的名字不會出現在這裡（≠ 0 張） */
    usage,
    /**
     * 「這個名字以前出現過嗎」用的完整集合＝原始清單 ∪ 已合併掉的舊叫法。
     *
     * 不能拿上面那份收斂過的清單來判斷「是不是新產品」：已經確認合併掉的舊叫法不在裡面，
     * AI 若又標出那個舊叫法，畫面會說它是「新」的、還請人再去合併一次——
     * 使用者明明已經處理過了。
     */
    known: [...new Set([...names, ...Object.values(aliasMap.aliasLabels)])].filter(Boolean),
  }
})
