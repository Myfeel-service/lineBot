import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { discoverSitePages } from '~~/server/utils/ai-site-discovery'
import { listSourceUrlKeys, sourceUrlKey } from '~~/server/utils/ai-knowledge-sources'

/** 「這幾個網址加過了沒」一次最多問幾個：跟加入視窗一次最多加入的頁數同一個量級，多了就是亂丟進來的 */
const MAX_CHECK_URLS = 50

/**
 * POST /api/ai/knowledge/discover-pages
 * Body: { url }        → 整站匯入第一步：同網域可匯入的頁面清單，每頁附 imported
 * Body: { urls: [...] } → 不探站，只回 { imported: string[] }：這幾個網址哪幾個已經加過了（原樣回傳）
 *
 * 整站匯入第一步:輸入網址 → 回同網域可匯入的頁面清單(sitemap 優先、robots 尊重、
 * 同域連結備援),給前端列清單勾選。只探索不抓內文;實際匯入仍逐頁走既有 preview-job。
 *
 * 每頁附 `imported`:這個網址已經有對應的知識來源。整站匯入是「一鍵勾很多頁」的操作,
 * 沒有這個標記,第二次跑同一個站會靜默生出整組重複來源與重複卡(反問選項會出現兩個一樣的)。
 *
 * `urls` 那種問法給「一次貼好幾個網址」用（2026-10-13 `/code-review`）：那條路以前每一頁都當沒加過，
 * 網頁只要改了幾個字（內容指紋對不上）同一個網址就多一份。判斷跟整站同一支（listSourceUrlKeys，回收桶裡的不算）。
 * ⚠️ 刻意併在這支、不另開一支端點：多一支路由，Nitro 產生的路由型別就深到 TypeScript 算不下去
 *    （2026-10-13 實測，另開一支 imported-urls 後 typecheck 在三個不相干的 $fetch 呼叫報「型別太深」）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'knowledge.write')
  const body = await readBody(event)

  if (Array.isArray(body?.urls)) {
    const urls = (body.urls as unknown[])
      .map(u => String(u ?? '').trim())
      .filter(u => /^https?:\/\//i.test(u))
      .slice(0, MAX_CHECK_URLS)
    if (!urls.length) return { imported: [] as string[] }
    const existing = await listSourceUrlKeys(getDb(), workspaceId)
    return { imported: urls.filter(u => existing.has(sourceUrlKey(u))) }
  }

  const url = String(body?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) {
    throw createError({ statusCode: 400, statusMessage: 'URL 必須為 http:// 或 https:// 開頭' })
  }

  const result = await discoverSitePages(url)
  if (!result.pages.length) {
    throw createError({
      statusCode: 422,
      statusMessage: '找不到可匯入的頁面(網站可能沒有 sitemap、頁面全被 robots 排除,或內容由程式動態載入)',
    })
  }

  // 既有 url 來源(查詢失敗不擋探索,只是少了標記)
  const existing = await listSourceUrlKeys(getDb(), workspaceId)

  return {
    ...result,
    pages: result.pages.map(p => ({ ...p, imported: existing.has(sourceUrlKey(p.url)) })),
  }
})
