import type { DocumentSnapshot } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { fetchAllFollowerUserIds, getUserProfile } from '~~/server/utils/line'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/**
 * POST /api/users/sync-from-line
 *
 * 呼叫 LINE Messaging API「取得好友 userId 清單」，並寫入／更新 Firestore `users`。
 * 解決：僅在收到訊息／postback／follow webhook 時才建檔 → 清單只有「有互動過」的帳號。
 *
 * Body（JSON，可選）:
 *   offset            — 從第幾位好友開始處理（預設 0，大量好友時可分批）
 *   maxFetchProfiles  — 本請求最多處理幾位（預設 400，上限 800，避免逾時）
 *
 * Response:
 *   lineFollowerTotal, offset, processed, remaining, listTruncated, profileFailures
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  try {
    const body = (await readBody(event).catch(() => ({}))) as {
      offset?: number
      maxFetchProfiles?: number
    }

    const offset = Math.max(0, Number(body?.offset) || 0)
    const maxFetchProfiles = Math.min(
      Math.max(1, Number(body?.maxFetchProfiles) || 400),
      800,
    )

    const { userIds, truncated: listTruncated } = await fetchAllFollowerUserIds({ workspaceId })
    const slice = userIds.slice(offset, offset + maxFetchProfiles)
    const remaining = Math.max(0, userIds.length - offset - slice.length)

    if (!slice.length) {
      return {
        ok: true,
        lineFollowerTotal: userIds.length,
        offset,
        processed: 0,
        remaining: 0,
        listTruncated,
        profileFailures: 0,
      }
    }

    const db = getDb()
    const CONCURRENCY = 12

    const readSnaps = async (ids: string[]) => {
      const out: DocumentSnapshot[] = []
      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const chunk = ids.slice(i, i + CONCURRENCY)
        const part = await Promise.all(chunk.map((id) => db.collection('users').doc(`${workspaceId}_${id}`).get()))
        out.push(...part)
      }
      return out
    }

    const fetchProfiles = async (ids: string[]) => {
      const out: Awaited<ReturnType<typeof getUserProfile>>[] = []
      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const chunk = ids.slice(i, i + CONCURRENCY)
        const part = await Promise.all(chunk.map((id) => getUserProfile(id, workspaceId)))
        out.push(...part)
      }
      return out
    }

    const [snaps, profiles] = await Promise.all([
      readSnaps(slice),
      fetchProfiles(slice),
    ])

    let created = 0
    let updated = 0
    let profileFailures = 0

    let batch = db.batch()
    let ops = 0

    const flush = async () => {
      if (ops > 0) {
        await batch.commit()
        batch = db.batch()
        ops = 0
      }
    }

    for (let i = 0; i < slice.length; i++) {
      const lineUserId = slice[i]!
      const snap = snaps[i]!
      const profile = profiles[i]
      const ref = db.collection('users').doc(`${workspaceId}_${lineUserId}`)

      if (!profile) profileFailures++

      const displayName = profile?.displayName ?? lineUserId
      const pictureUrl = profile?.pictureUrl ?? ''

      if (!snap.exists) {
        batch.set(ref, {
          workspaceId,
          lineUserId,
          displayName,
          pictureUrl,
          createdAt: FieldValue.serverTimestamp(),
          isBlocked: false,
        })
        created++
      }
      else {
        const patch: Record<string, unknown> = {
          workspaceId,
          lineUserId,
          displayName,
          pictureUrl,
          isBlocked: false,
        }
        const data = snap.data()
        if (!data?.createdAt) patch.createdAt = FieldValue.serverTimestamp()
        batch.set(ref, patch, { merge: true })
        updated++
      }
      ops++
      if (ops >= 400) await flush()
    }

    await flush()

    return {
      ok: true,
      lineFollowerTotal: userIds.length,
      offset,
      processed: slice.length,
      remaining,
      listTruncated,
      profileFailures,
      created,
      updated,
    }
  }
  catch (error) {
    const msg = String((error as Error)?.message || error || 'sync failed')
    if (msg.includes('Access to this API is not available for your account')) {
      throw createError({
        statusCode: 403,
        statusMessage: '此 LINE 官方帳號目前不支援好友清單 API（followers/ids），只能透過 Webhook 事件逐步累積好友。',
      })
    }
    throw createError({
      statusCode: 500,
      statusMessage: msg.length > 180 ? `${msg.slice(0, 180)}...` : msg,
    })
  }
})
