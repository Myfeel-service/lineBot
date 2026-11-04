/**
 * 客人生日（`C-57`）：存生日、「本月壽星」系統標籤、後台那幾個數字、早上報告要的事實（`D-170`）。
 * 規則與存法見 `shared/birthday.ts`。
 *
 * 為什麼做成標籤：推播挑人只有標籤一種會自己更新（同「N 天沒互動」，`inactive-tag.ts`）——
 * 每個月 1 號把這個月生日的人貼上、上個月的摘掉，推播頁選「本月壽星」就是這個月的壽星，推播端零改動。
 *
 * 查詢都只用**等號**（`workspaceId`＋`birthdayMonth`〔＋`birthdayDay`〕、`workspaceId`＋`birthdaySetDay`）：
 * Firestore 會合併單欄索引，⛔ 不需要另開複合索引（開了要兩個專案各部署一次）。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getAiSettings } from './ai-settings'
import { findOrCreateSystemTag } from './system-tag'
import { addTagsToUser, removeTagsFromUser } from './tagging'
import {
  BIRTHDAY_TAG_CODE,
  BIRTHDAY_TAG_DESCRIPTION,
  BIRTHDAY_TAG_NAME,
  birthdayKeysForDay,
  taipeiMonth,
  type BirthdayDigestFacts,
} from '~~/shared/birthday'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { taipeiDate } from '~~/shared/time'
import type { TagDoc } from '~~/shared/types/tag-broadcast'

/** 每輪每工作區最多貼／摘幾位（10 分鐘就有下一輪；超過的下一輪接著做，見 `syncBirthdayMonthTag`） */
const SYNC_LIMIT = 400
/** 每月對齊一次並行幾位（code review 第 12 條：以前一位一位 await，大店要跑好幾分鐘、把排程擠爆 `E-49`） */
const SYNC_CONCURRENCY = 8

const tagIdCache = new Map<string, { tagId: string | null, cachedAt: number }>()
const TAG_ID_CACHE_TTL_MS = 5 * 60_000
/**
 * 這台伺服器上「這個工作區這個月已經對齊過」（code review 第 12 條）：10 分鐘一輪，做完的月份不必每輪再讀一次
 * cronState。換一台（冷啟動）就清空、照樣先讀 cronState——只是省讀取，⛔ 不是正確性的依據。
 */
const syncedMonth = new Map<string, string>()

export function _clearBirthdayTagCacheForTest() {
  tagIdCache.clear()
  syncedMonth.clear()
}

/**
 * 找「本月壽星」標籤；create=true 時沒有就建（客人留生日、每月貼標兩條路才建）。
 * 找與建共用 `system-tag.ts`：固定 id＋create，同一秒好幾位客人一起留生日也只會有一顆（code review 第 5 條）。
 */
export async function resolveBirthdayTagId(db: Firestore, workspaceId: string, opts: { create?: boolean } = {}): Promise<string | null> {
  const cached = tagIdCache.get(workspaceId)
  if (cached && Date.now() - cached.cachedAt < TAG_ID_CACHE_TTL_MS && (cached.tagId || !opts.create)) return cached.tagId
  const { tagId } = await findOrCreateSystemTag(db, workspaceId, BIRTHDAY_TAG_CODE, opts.create
    ? (): TagDoc => ({
        workspaceId,
        code: BIRTHDAY_TAG_CODE,
        name: BIRTHDAY_TAG_NAME,
        category: 'behavior',
        color: '#E8A33D',
        description: BIRTHDAY_TAG_DESCRIPTION,
        status: 'active',
        createdBy: 'system',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
    : undefined)
  tagIdCache.set(workspaceId, { tagId, cachedAt: Date.now() })
  return tagId
}

/**
 * 客人在 LINE 上選了生日：存月日（⛔ 不存年）、照這個月是不是他的生日月貼／摘「本月壽星」。
 * @returns changed＝之前留過、這次改了日子（回覆講「改成」）
 */
export async function saveCustomerBirthday(
  db: Firestore,
  workspaceId: string,
  lineUserId: string,
  b: { month: number, day: number },
  now: Date = new Date(),
): Promise<{ changed: boolean }> {
  const docId = lineUserFirestoreDocId(lineUserId, workspaceId)
  const ref = db.collection('users').doc(docId)
  const prev = (await ref.get()).data() as { birthdayMonth?: number, birthdayDay?: number } | undefined
  const changed = !!prev?.birthdayMonth && (prev.birthdayMonth !== b.month || prev.birthdayDay !== b.day)
  // ⚠️ workspaceId 一起寫：舊的客人文件可能沒有這一欄，沒有的話每月那支查詢查不到他
  await ref.set({
    workspaceId,
    birthdayMonth: b.month,
    birthdayDay: b.day,
    birthdayUpdatedAt: FieldValue.serverTimestamp(),
    // `D-170`：第一次留的那一天（台北日期），早上報告講「昨天幾位留了生日」用；⛔ 改生日不動它
    ...(prev?.birthdayMonth ? {} : { birthdaySetDay: taipeiDate(now) }),
  }, { merge: true })

  // 這個月就是他的生日月＝馬上貼（⛔ 不等下個月 1 號：那時候他的生日已經過了）；改到別的月份＝摘掉
  try {
    const thisMonth = taipeiMonth(now)
    if (b.month === thisMonth) {
      const tagId = await resolveBirthdayTagId(db, workspaceId, { create: true })
      if (tagId) await addTagsToUser(docId, [tagId], 'system', 'birthday:set', workspaceId)
    }
    else if (prev?.birthdayMonth === thisMonth) {
      const tagId = await resolveBirthdayTagId(db, workspaceId)
      if (tagId) await removeTagsFromUser(docId, [tagId], 'system', 'birthday:changed', workspaceId)
    }
  }
  catch (e) {
    // 生日已經存好了；標籤每月 1 號那支會對齊
    console.warn('[birthday] tag on save failed:', docId, e)
  }
  return { changed }
}

/** 一次最多 `limit` 個一起跑（照順序取下一個），全部跑完才回 */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  }))
}

/**
 * 每月對齊「本月壽星」（掛 cron/run-tasks）：每工作區每個月只真跑一次（`cronState` 記哪個月做完）。
 * ⭐ **有「本月壽星」這顆標籤就跑，不管「加好友時問生日」開沒開**（code review 第 3 條）：
 *    只用「問生日」模組問現有好友的店，那個開關是關的，但客人留生日時一樣會被貼上——以前只跑開著的店，
 *    11 月的壽星到 12 月還掛著標籤，12 月照標籤發祝福就發給 11 月的人。
 *    開著的店沒有標籤就建（這個月還沒人留也要有一顆給推播選）；關著又沒有標籤＝沒東西可對齊，這個月不再看。
 * ⚠️ 一輪有上限：做不完不記「這個月做完了」，下一輪（10 分鐘後）接著做——貼、摘都是冪等的。
 */
export async function syncBirthdayMonthTag(db: Firestore, now: Date = new Date()): Promise<{ workspaces: number, tagged: number, untagged: number }> {
  const stats = { workspaces: 0, tagged: 0, untagged: 0 }
  const month = taipeiMonth(now)
  const monthKey = taipeiDate(now).slice(0, 7)
  const wsSnap = await db.collection('workspaces').select().get()

  for (const wsDoc of wsSnap.docs) {
    const workspaceId = wsDoc.id
    if (syncedMonth.get(workspaceId) === monthKey) continue
    try {
      const settings = await getAiSettings(workspaceId, db)
      const tagId = await resolveBirthdayTagId(db, workspaceId, { create: settings.birthday?.enabled === true })
      if (!tagId) {
        syncedMonth.set(workspaceId, monthKey) // 沒開、也沒有人留過＝這個月沒東西要對齊
        continue
      }
      const stateRef = db.collection('cronState').doc(`birthday-tag-${workspaceId}`)
      const state = (await stateRef.get()).data() as { doneMonth?: string } | undefined
      if (state?.doneMonth === monthKey) {
        syncedMonth.set(workspaceId, monthKey)
        continue
      }

      stats.workspaces += 1

      // ── 這個月的壽星 ──
      const usersSnap = await db.collection('users')
        .where('workspaceId', '==', workspaceId)
        .where('birthdayMonth', '==', month)
        .select()
        .get()
      const current = new Set(usersSnap.docs.map(d => d.id))

      // ── 現在掛著標籤的：不是這個月的摘掉、是的記下來不重貼 ──
      const taggedSnap = await db.collection('userTags')
        .where('workspaceId', '==', workspaceId)
        .where('tagId', '==', tagId)
        .get()
      const already = new Set<string>()
      const toRemove: string[] = []
      for (const t of taggedSnap.docs) {
        const uid = String(t.data()?.userId ?? '')
        if (!uid) continue
        if (current.has(uid)) already.add(uid)
        else toRemove.push(uid)
      }
      const toAdd = [...current].filter(uid => !already.has(uid))

      // 一輪有上限：先摘再貼（摘不掉的人會收到別人的生日祝福，比晚一輪貼到更糟）
      const removeNow = toRemove.slice(0, SYNC_LIMIT)
      const addNow = toAdd.slice(0, Math.max(0, SYNC_LIMIT - removeNow.length))
      const source = `birthday:month-${monthKey}`
      await eachLimited(removeNow, SYNC_CONCURRENCY, async (uid) => {
        const { removed } = await removeTagsFromUser(uid, [tagId], 'system', source, workspaceId)
          .catch((e) => {
            console.warn('[birthday] untag failed:', uid, e)
            return { removed: [] as string[] }
          })
        stats.untagged += removed.length
      })
      await eachLimited(addNow, SYNC_CONCURRENCY, async (uid) => {
        const { added } = await addTagsToUser(uid, [tagId], 'system', source, workspaceId)
          .catch((e) => {
            console.warn('[birthday] tag failed:', uid, e)
            return { added: [] as string[] }
          })
        stats.tagged += added.length
      })

      // 做不完就不記，下一輪接著做（⛔ 記了就會有一批壽星這個月都沒被貼到）
      if (removeNow.length + addNow.length < toRemove.length + toAdd.length) continue
      await stateRef.set({ doneMonth: monthKey, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      syncedMonth.set(workspaceId, monthKey)
    }
    catch (e) {
      console.warn('[birthday] workspace sync failed:', workspaceId, e)
    }
  }
  return stats
}

/**
 * 這一天的壽星（`D-170`）：已封鎖、退好友的不算（發不到）。最多回 `limit` 位。
 * 三個等號（workspaceId＋月＋日）＝合併單欄索引，⛔ 不用開複合索引。
 */
export async function birthdayPeopleOn(
  db: Firestore,
  workspaceId: string,
  dayKey: string,
  limit = 500,
): Promise<Array<{ lineUserId: string, displayName: string }>> {
  const snaps = await Promise.all(birthdayKeysForDay(dayKey).map(k =>
    db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .where('birthdayMonth', '==', k.month)
      .where('birthdayDay', '==', k.day)
      .select('displayName', 'isBlocked', 'lineUserId')
      .limit(limit)
      .get()))
  const out: Array<{ lineUserId: string, displayName: string }> = []
  for (const s of snaps) {
    for (const d of s.docs) {
      const data = d.data() as { displayName?: string, isBlocked?: boolean, lineUserId?: string }
      if (data.isBlocked) continue
      out.push({ lineUserId: String(data.lineUserId || lineUserIdFromFirestoreDocId(d.id, workspaceId)), displayName: String(data.displayName ?? '').trim() })
    }
  }
  return out.slice(0, limit)
}

/**
 * 好幾天的壽星（休假日回來那天把休假那幾天一起講，code review 第 4 條）：照日子順序、同一位只算一次。
 */
export async function birthdayPeopleOnDays(
  db: Firestore,
  workspaceId: string,
  dayKeys: readonly string[],
  limit = 500,
): Promise<Array<{ lineUserId: string, displayName: string }>> {
  const perDay = await Promise.all(dayKeys.map(day => birthdayPeopleOn(db, workspaceId, day, limit)))
  const seen = new Set<string>()
  const out: Array<{ lineUserId: string, displayName: string }> = []
  for (const p of perDay.flat()) {
    if (seen.has(p.lineUserId)) continue
    seen.add(p.lineUserId)
    out.push(p)
  }
  return out.slice(0, limit)
}

/**
 * 早上報告的生日那一段（`D-170`）：各查各的，查不到的那一半回 null（⛔ 不當成 0）。
 * @param coverDays 「幾位留了生日」算哪幾天（＝報告講成績的那幾天）
 * @param birthdayDays 「壽星」算哪幾天：上一則報告之後到今天（上一則那天自己講過了）
 */
export async function loadBirthdayDigest(
  db: Firestore,
  workspaceId: string,
  coverDays: readonly string[],
  birthdayDays: readonly string[],
): Promise<BirthdayDigestFacts> {
  // ⚠️ 包成 async：查詢在組的當下就丟錯（同步）的話也要落到 catch，⛔ 不可以把整則早上報告弄掛
  const [newlySet, today] = await Promise.all([
    (async () => {
      const cs = await Promise.all(coverDays.map(day =>
        db.collection('users')
          .where('workspaceId', '==', workspaceId)
          .where('birthdaySetDay', '==', day)
          .count()
          .get()
          .then(s => s.data().count)))
      return cs.reduce((a, b) => a + b, 0)
    })().catch((e) => {
      console.warn('[birthday] digest newlySet failed:', workspaceId, e)
      return null
    }),
    (async () => {
      const p = await birthdayPeopleOnDays(db, workspaceId, birthdayDays, 200)
      return { count: p.length, names: p.map(x => x.displayName).filter(Boolean).slice(0, 3) }
    })().catch((e) => {
      console.warn('[birthday] digest today failed:', workspaceId, e)
      return null
    }),
  ])
  return { newlySet, today }
}

/** 後台「生日」那個框的數字：每個月幾位（index 0＝1 月）、合計、這個月 */
export async function birthdayStats(db: Firestore, workspaceId: string, now: Date = new Date()): Promise<{
  byMonth: number[]
  total: number
  month: number
  thisMonth: number
}> {
  const counts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .where('birthdayMonth', '==', i + 1)
      .count()
      .get()
      .then(s => s.data().count),
  ))
  const month = taipeiMonth(now)
  return { byMonth: counts, total: counts.reduce((a, b) => a + b, 0), month, thisMonth: counts[month - 1] ?? 0 }
}
