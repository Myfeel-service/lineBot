import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getWorkspaceProductNames } from '~~/server/utils/ai-knowledge-chunks'
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

  return {
    /** 下拉裡可以挑的（已收斂成正式名） */
    names: canonical,
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
