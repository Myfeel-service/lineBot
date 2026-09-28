import type { DocumentData, Firestore } from 'firebase-admin/firestore'
import { CAMPAIGN_INACTIVE_CODE, CAMPAIGN_INACTIVE_MESSAGE } from '~~/shared/lead-page-failure'

/**
 * 停用的活動，連結就該失效。
 *
 * 2026-09-10 拍板前的行為：客人端（`/api/liff/claim`、`/api/liff/apply`）從頭到尾
 * 沒讀過 `leadCampaigns`，所以「停用」只影響後台要不要重新產生網址——外面流通的
 * 舊連結照樣綁定、照樣貼標。加上「活動檔期」自己就寫明不影響貼標，等於整個活動頁
 * 沒有任何一個開關能真的停掉一個活動，只能刪掉。
 *
 * ⛔ 擋的位置是「客人點連結那一刻」（claim），不是後續的 apply／follow 貼標：
 * 已經在停用前完成綁定的人，他的貼標本來就該照原本的約定完成，不該因為後台按了
 * 停用就半途消失。界線是「還能不能用這個連結進來」。
 */
export function isCampaignLinkDisabled(data: DocumentData | undefined | null): boolean {
  // 查不到活動文件＝活動已經被刪掉 → 當成已結束（2026-09-29 權限盤點時查到，`G-108`）。
  // 以前是放行：結果刪掉啟用中的活動，外面的連結照樣綁定、照樣貼標，後台卻再也沒有那一筆關得掉；
  // 刪掉**停用中**的活動更糟，本來點不開的連結會重新點得開。刪除比停用更重，連結沒道理反而活著。
  // ⚠️ 當初放行是怕「多租戶化前的舊資料本來就沒有活動文件」。同日唯讀盤點 myfeel：7,018 筆 leadClaims
  //    只有 2 個 campaignId 找不到活動，各 1 筆、最後活動在 5 月與 7 月＝早就刪掉的測試活動，沒有在跑的。
  // ⛔ 「讀取失敗」跟「查不到」不一樣：讀取丟例外會往外拋（claim 回 5xx），不會被當成已結束。
  if (!data) return true
  return data.isActive === false
}

/**
 * 讀活動並在停用時丟 410。`campaignId` 為空字串時直接放行（舊 claim 沒有這個欄位）。
 *
 * 多一次讀取換一個不會漏的判斷點：claim 有 shared／legacy 兩條路徑，只有呼叫這裡
 * 的位置是兩條路的共同出口——塞進其中一條的並行讀取裡會漏掉另一條。
 */
export async function assertCampaignLinkActive(db: Firestore, campaignId: string): Promise<void> {
  const id = String(campaignId || '').trim()
  if (!id) return
  const snap = await db.collection('leadCampaigns').doc(id).get()
  if (!isCampaignLinkDisabled(snap.exists ? snap.data() : null)) return
  throw createError({
    statusCode: 410,
    statusMessage: CAMPAIGN_INACTIVE_MESSAGE,
    data: { code: CAMPAIGN_INACTIVE_CODE },
  })
}
