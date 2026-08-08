/**
 * 把 firestore.indexes.json 裡缺少的複合索引建到 Firestore（**只新增，永不刪除**）。
 *
 * 為什麼不用 `firebase deploy --only firestore:indexes`：那支會把「專案上有、但檔案裡沒有」
 * 的索引列出來問你要不要刪，非互動環境下很容易誤刪掉某人在 Console 上手動建的索引。
 * 這支只做加法：比對之後把缺的建起來，其餘一律不動，所以可以安心重跑。
 *
 * 認證用的是各 env 檔裡的服務帳號（與其他 scripts 相同）。若回 403，代表那個服務帳號
 * 沒有建索引的權限（需要 Cloud Datastore Index Admin 或 Firebase Admin），
 * 那就得請有權限的人在 Console 建，或另外授權。
 *
 * 用法：
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/deploy-firestore-indexes.ts          # dry-run
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/deploy-firestore-indexes.ts --apply
 *   （每個 Firebase 專案各跑一次：.env_myfeel 與 .env_splash 是不同專案）
 *
 * 索引建立是非同步的：回 200 只代表「已排入建置」，大型集合可能要數分鐘到數小時；
 * 建置期間查詢會照舊走退路（見 messages.get.ts 的 loadUserSessions）。
 */
import { readFileSync } from 'node:fs'
import { GoogleAuth } from 'google-auth-library'

const apply = process.argv.includes('--apply')

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY')
  process.exit(1)
}

interface IndexField {
  fieldPath: string
  order?: 'ASCENDING' | 'DESCENDING'
  arrayConfig?: 'CONTAINS'
}
interface IndexDef {
  collectionGroup: string
  queryScope?: string
  fields: IndexField[]
}

/** 兩個索引是不是同一個：集合 + 欄位順序 + 每個欄位的方向／陣列設定全部一樣 */
function indexKey(collectionGroup: string, queryScope: string, fields: IndexField[]): string {
  const parts = fields
    // __name__ 是 Firestore 自己補的，比對時忽略（檔案裡通常不寫，API 回傳會帶）
    .filter(f => f.fieldPath !== '__name__')
    .map(f => `${f.fieldPath}:${f.arrayConfig ?? f.order ?? ''}`)
  return `${collectionGroup}|${queryScope}|${parts.join(',')}`
}

async function main() {
  const auth = new GoogleAuth({
    credentials: { client_email: clientEmail, private_key: privateKey!.replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/datastore'],
  })
  const client = await auth.getClient()
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)`

  const wanted = (JSON.parse(readFileSync('firestore.indexes.json', 'utf8')).indexes ?? []) as IndexDef[]

  // '-' = 所有 collection group
  const existing: IndexDef[] = []
  let pageToken = ''
  do {
    // 這支 API 只接受預設頁數（帶 pageSize 會被拒），所以只跟著 nextPageToken 翻頁
    const url = `${base}/collectionGroups/-/indexes${pageToken ? `?pageToken=${pageToken}` : ''}`
    const res = await client.request<{ indexes?: any[], nextPageToken?: string }>({ url })
    for (const idx of res.data.indexes ?? []) {
      // name 形如 projects/x/databases/(default)/collectionGroups/{col}/indexes/{id}
      const collectionGroup = String(idx.name || '').split('/collectionGroups/')[1]?.split('/')[0] ?? ''
      existing.push({ collectionGroup, queryScope: idx.queryScope, fields: idx.fields ?? [] })
    }
    pageToken = res.data.nextPageToken ?? ''
  } while (pageToken)

  const existingKeys = new Set(existing.map(i => indexKey(i.collectionGroup, i.queryScope ?? 'COLLECTION', i.fields)))
  const missing = wanted.filter(i => !existingKeys.has(indexKey(i.collectionGroup, i.queryScope ?? 'COLLECTION', i.fields)))

  console.log(`[indexes] 專案 ${projectId}：檔案 ${wanted.length} 個、線上 ${existing.length} 個、缺少 ${missing.length} 個`)
  for (const m of missing) {
    console.log(`  · ${m.collectionGroup}: ${m.fields.map(f => `${f.fieldPath} ${f.arrayConfig ?? f.order}`).join(', ')}`)
  }
  if (!missing.length) return
  if (!apply) {
    console.log('[indexes] dry-run（沒有真的建立）。確認上面的清單後加 --apply')
    return
  }

  for (const m of missing) {
    const url = `${base}/collectionGroups/${m.collectionGroup}/indexes`
    try {
      await client.request({
        url,
        method: 'POST',
        data: { queryScope: m.queryScope ?? 'COLLECTION', fields: m.fields },
      })
      console.log(`[indexes] 已排入建置：${m.collectionGroup} (${m.fields.map(f => f.fieldPath).join(', ')})`)
    }
    catch (e: any) {
      const status = e?.response?.status
      const message = e?.response?.data?.error?.message ?? e?.message
      // 已存在（例如剛剛才建、或欄位順序等價）不算失敗
      if (status === 409) console.log(`[indexes] 已存在，略過：${m.collectionGroup}`)
      else console.error(`[indexes] 建立失敗 ${m.collectionGroup}（HTTP ${status}）：${message}`)
    }
  }
}

main().catch((e) => {
  console.error('[indexes] 失敗：', e?.response?.data?.error?.message ?? e)
  process.exit(1)
})
