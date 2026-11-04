/**
 * 客人生日（`C-57`）：存生日、「本月壽星」系統標籤、後台那幾個數字。規則與存法見 `shared/birthday.ts`。
 *
 * 為什麼做成標籤：推播挑人只有標籤一種會自己更新（同「N 天沒互動」，`inactive-tag.ts`）——
 * 每個月 1 號把這個月生日的人貼上、上個月的摘掉，推播頁選「本月壽星」就是這個月的壽星，推播端零改動。
 *
 * 查詢都只用**兩個等號**（`workspaceId`＋`birthdayMonth`）：Firestore 會合併單欄索引，⛔ 不需要另開複合索引
 * （開了要兩個專案各部署一次）。數幾位用 count()，一個月一次查詢、讀取費一筆。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { v4 as uuidv4 } from 'uuid'
import { getAiSettings } from './ai-settings'
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

const tagIdCache = new Map<string, { tagId: string | null, cachedAt: number }>()
const TAG_ID_CACHE_TTL_MS = 5 * 60_000

export function _clearBirthdayTagCacheForTest() {
  tagIdCache.clear()
}

/** 找「本月壽星」標籤；create=true 時沒有就建（客人留生日、每月貼標兩條路才建） */
export async function resolveBirthdayTagId(db: Firestore, workspaceId: string, opts: { create?: boolean } = {}): Promise<string | null> {
  const cached = tagIdCache.get(workspaceId)
  if (cached && Date.now() - cached.cachedAt < TAG_ID_CACHE_TTL_MS && (cached.tagId || !opts.create)) return cached.tagId

  const snap = await db.collection('tags')
    .where('workspaceId', '==', workspaceId)
    .where('code', '==', BIRTHDAY_TAG_CODE)
    .limit(1)
    .get()
  let tagId: string | null = snap.docs[0]?.id ?? null
  if (!tagId && opts.create) {
    const id = uuidv4()
    const doc: TagDoc = {
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
    }
    await db.collection('tags').doc(id).set(doc)
    tagId = id
  }
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

/**
 * 每月對齊「本月壽星」（掛 cron/run-tasks）：每工作區每個月只真跑一次（`cronState` 記哪個月做完）。
 * ⛔ 只對開了生日功能的工作區跑；關掉之後標籤停在最後一次的樣子（不清空：店家可能正要發）。
 * ⚠️ 一輪有上限：做不完不記「這個月做完了」，下一輪（10 分鐘後）接著做——貼、摘都是冪等的。
 */
export async function syncBirthdayMonthTag(db: Firestore, now: Date = new Date()): Promise<{ workspaces: number, tagged: number, untagged: number }> {
  const stats = { workspaces: 0, tagged: 0, untagged: 0 }
  const month = taipeiMonth(now)
  const monthKey = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric' }).format(now)}-${String(month).padStart(2, '0')}`
  const wsSnap = await db.collection('workspaces').select().get()

  for (const wsDoc of wsSnap.docs) {
    const workspaceId = wsDoc.id
    try {
      const settings = await getAiSettings(workspaceId, db)
      if (!settings.birthday?.enabled) continue
      const stateRef = db.collection('cronState').doc(`birthday-tag-${workspaceId}`)
      const state = (await stateRef.get()).data() as { doneMonth?: string } | undefined
      if (state?.doneMonth === monthKey) continue

      stats.workspaces += 1
      const tagId = await resolveBirthdayTagId(db, workspaceId, { create: true })
      if (!tagId) continue

      // ── 這個月的壽星貼上 ──
      const usersSnap = await db.collection('users')
        .where('workspaceId', '==', workspaceId)
        .where('birthdayMonth', '==', month)
        .select()
        .get()
      const current = new Set(usersSnap.docs.map(d => d.id))
      let budget = SYNC_LIMIT

      // ── 上個月（或改了生日）的摘掉 ──
      const taggedSnap = await db.collection('userTags')
        .where('workspaceId', '==', workspaceId)
        .where('tagId', '==', tagId)
        .get()
      const already = new Set<string>()
      for (const t of taggedSnap.docs) {
        const uid = String(t.data()?.userId ?? '')
        if (!uid) continue
        if (current.has(uid)) {
          already.add(uid)
          continue
        }
        if (budget <= 0) break
        budget -= 1
        const { removed } = await removeTagsFromUser(uid, [tagId], 'system', `birthday:month-${monthKey}`, workspaceId)
          .catch((e) => {
            console.warn('[birthday] untag failed:', uid, e)
            return { removed: [] as string[] }
          })
        stats.untagged += removed.length
      }

      for (const uid of current) {
        if (already.has(uid)) continue
        if (budget <= 0) break
        budget -= 1
        const { added } = await addTagsToUser(uid, [tagId], 'system', `birthday:month-${monthKey}`, workspaceId)
          .catch((e) => {
            console.warn('[birthday] tag failed:', uid, e)
            return { added: [] as string[] }
          })
        stats.tagged += added.length
      }

      // 做不完就不記，下一輪接著做（⛔ 記了就會有一批壽星這個月都沒被貼到）
      if (budget > 0) {
        await stateRef.set({ doneMonth: monthKey, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }
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

/** 早上報告的生日那一段（`D-170`）：各查各的，查不到的那一半回 null（⛔ 不當成 0） */
export async function loadBirthdayDigest(db: Firestore, workspaceId: string, coverDays: readonly string[], todayKey: string): Promise<BirthdayDigestFacts> {
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
      const p = await birthdayPeopleOn(db, workspaceId, todayKey, 200)
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
