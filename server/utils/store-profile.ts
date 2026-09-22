/**
 * 店家輪廓的讀寫（`D-85` / `C-217`）。
 *
 * 擺法跟 `aiSettings` 一樣：頂層集合 `storeProfiles`、doc id = workspaceId。
 * ⛔ 刻意**不**塞進 `workspaces/{id}`：那份文件在每次權限檢查都會被讀到，
 *    輪廓是只有少數畫面要看的東西，沒必要讓它搭上所有熱路徑的順風車。
 *
 * ⛔ 這裡不做快取。`aiSettings` 有 60 秒快取是因為**每一則客人訊息**都要讀它；
 *    輪廓只有後台頁面與精靈會讀，加快取只會換來「改完看不到」的客訴。
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import {
  emptyStoreProfile,
  normalizeStoreProfile,
  type SiteReadResult,
  type StoreProfileDoc,
  type StoreProfileFieldId,
} from '~~/shared/types/store-profile'

export const STORE_PROFILE_COLLECTION = 'storeProfiles'

/** 讀。沒有文件就回空輪廓（不是 null）——呼叫端不用到處判 null。 */
export async function getStoreProfile(workspaceId: string, db: Firestore = getDb()): Promise<StoreProfileDoc> {
  const snap = await db.collection(STORE_PROFILE_COLLECTION).doc(workspaceId).get()
  if (!snap.exists) return emptyStoreProfile()
  return normalizeStoreProfile(snap.data())
}

/**
 * 整份覆寫（欄位、網址、讀取結果）。
 *
 * ⚠️ 用 `set(..., { merge: true })` 會讓**刪掉的欄位留在資料庫裡**
 * （商家把「競爭對手」清空，merge 之後那一格還在），所以 `fields` 這一層
 * 刻意整包覆寫；`createdAt` 用 merge 語意另外補，避免每次存檔都被蓋掉。
 */
export async function saveStoreProfile(
  workspaceId: string,
  profile: StoreProfileDoc,
  db: Firestore = getDb(),
): Promise<void> {
  const ref = db.collection(STORE_PROFILE_COLLECTION).doc(workspaceId)
  const normalized = normalizeStoreProfile(profile)
  const snap = await ref.get()
  await ref.set({
    fields: normalized.fields,
    siteUrl: normalized.siteUrl,
    ...(normalized.siteRead ? { siteRead: normalized.siteRead } : {}),
    ...(normalized.refreshAskedAt ? { refreshAskedAt: normalized.refreshAskedAt } : {}),
    ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/** 只更新「讀網站的結果」那一格（讀網站是非同步的，不該把整份輪廓一起覆寫回去）。 */
export async function saveSiteReadResult(
  workspaceId: string,
  siteRead: SiteReadResult,
  db: Firestore = getDb(),
): Promise<void> {
  await db.collection(STORE_PROFILE_COLLECTION).doc(workspaceId).set({
    siteRead,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/** 前端送上來的欄位 patch：{ id: 值 }。值一律字串，空字串＝清空這一格。 */
export type StoreProfilePatch = Partial<Record<StoreProfileFieldId, string>>
