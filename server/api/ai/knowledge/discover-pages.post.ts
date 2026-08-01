import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { discoverSitePages } from '~~/server/utils/ai-site-discovery'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'

/** 網址正規化成比對用 key(去 fragment、去尾斜線),與探索端同一套規則 */
function urlKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href.replace(/\/$/, '')
  }
  catch {
    return url
  }
}

/**
 * POST /api/ai/knowledge/discover-pages
 * Body: { url }
 *
 * 整站匯入第一步:輸入網址 → 回同網域可匯入的頁面清單(sitemap 優先、robots 尊重、
 * 同域連結備援),給前端列清單勾選。只探索不抓內文;實際匯入仍逐頁走既有 preview-job。
 *
 * 每頁附 `imported`:這個網址已經有對應的知識來源。整站匯入是「一鍵勾很多頁」的操作,
 * 沒有這個標記,第二次跑同一個站會靜默生出整組重複來源與重複卡(反問選項會出現兩個一樣的)。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
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
  let existing = new Set<string>()
  try {
    const snap = await getDb().collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .limit(500)
      .get()
    existing = new Set(
      snap.docs
        .map(d => String((d.data() as any)?.url ?? '').trim())
        .filter(Boolean)
        .map(urlKey),
    )
  }
  catch (e) {
    console.warn('[discover-pages] existing source lookup failed:', e)
  }

  return {
    ...result,
    pages: result.pages.map(p => ({ ...p, imported: existing.has(urlKey(p.url)) })),
  }
})
