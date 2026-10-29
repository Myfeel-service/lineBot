import type { Firestore } from 'firebase-admin/firestore'

/**
 * 成本頁主機費（AWS 帳單）的共用暫存（`D-164`③，2026-10-29）。
 *
 * 為什麼不只放記憶體：主機同時開好幾台（保溫就讓 4 台醒著）、又會被回收，每台各記一份＝
 * 打開成本頁常常落到沒存過的那台，又付一次查詢費（每次 US$0.01，2026-10 月查了 57 次）。
 * 存一份在資料庫、所有主機共用：讀一筆的錢比查一次帳單便宜幾萬倍。
 *
 * ⚠️ 存成一段文字（JSON）：帳單資料裡可能有 undefined 的欄位，Firestore 不收。
 * ⚠️ 讀寫失敗一律當「沒有暫存」照常去查帳單——⛔ 暫存壞掉不可以拖垮成本頁。
 * 資料庫規則整個擋掉前台（`firestore.rules` 一律 false），這份只有伺服器讀得到。
 */
export const HOST_COSTS_CACHE_COLLECTION = 'hostCostsCache'

export type HostCostsCacheEntry = { key: string, at: number, data: unknown }

/** 依 `keys` 的順序，回第一份還沒過期的；都沒有（或讀不到）回 null */
export async function readHostCostsCache(
  db: Firestore,
  keys: string[],
  ttlMs: number,
  now = Date.now(),
): Promise<HostCostsCacheEntry | null> {
  try {
    const snaps = await db.getAll(...keys.map(k => db.collection(HOST_COSTS_CACHE_COLLECTION).doc(k)))
    for (const [i, snap] of snaps.entries()) {
      if (!snap.exists) continue
      const at = Number(snap.get('at') || 0)
      const json = snap.get('json')
      if (!at || typeof json !== 'string' || now - at >= ttlMs) continue
      return { key: keys[i]!, at, data: JSON.parse(json) }
    }
    return null
  }
  catch (e) {
    console.warn('[host-costs] 讀共用暫存失敗，照常查帳單:', String((e as Error)?.message ?? e).slice(0, 200))
    return null
  }
}

/** 存一份給所有主機共用；失敗只留 log（下一次打開頁面再查一次而已） */
export async function writeHostCostsCache(db: Firestore, key: string, data: unknown, now = Date.now()): Promise<void> {
  try {
    await db.collection(HOST_COSTS_CACHE_COLLECTION).doc(key).set({ at: now, json: JSON.stringify(data) })
  }
  catch (e) {
    console.warn('[host-costs] 寫共用暫存失敗:', String((e as Error)?.message ?? e).slice(0, 200))
  }
}
