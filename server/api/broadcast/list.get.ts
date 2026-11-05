import { getDb, listDocs } from '~~/server/utils/firebase'
import { birthdayPeopleOnDays } from '~~/server/utils/birthday-tag'
import { birthdayDayRange } from '~~/shared/birthday'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { paginateInMemoryList } from '~~/server/utils/paginated-collection-list'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { workspaceBroadcastTier } from '~~/server/utils/broadcast-plan-gate'
import { getLineMessageQuota, readLineMessageQuotaCached } from '~~/server/utils/line'
import type { BroadcastDoc } from '~~/shared/types/tag-broadcast'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'

/**
 * GET /api/broadcast/list
 * Query: ?status=draft|scheduled|completed|...
 * Query: page, limit（有帶則回傳 { items, total, page, limit, hasMore }）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')

  const query = getQuery(event)

  /**
   * `part=birthday&day=YYYY-MM-DD`（`D-170`）：早上報告「今天幾位壽星」的連結打開推播頁時，
   * 推播頁拿這一天的壽星（LINE 編號＋名字）與生日禮，自己開一張草稿（⛔ 不存檔：最後一顆按鈕留給人）。
   * ⚠️ 借這支路由不另開一支（TS2589）；已封鎖的不回（發不到）。
   */
  if (query.part === 'birthday') {
    const day = String(query.day ?? '').trim()
    const since = String(query.since ?? '').trim() || day
    const days = birthdayDayRange(since, day)
    if (!days) throw createError({ statusCode: 400, statusMessage: '日期格式不對' })
    const [people, settings] = await Promise.all([
      birthdayPeopleOnDays(getDb(), workspaceId, days),
      getAiSettings(workspaceId),
    ])
    // 生日禮：有寫就帶（code review 第 7 條：「問生日」模組卡上寫了，祝福就要跟上，不看「加好友時問生日」開沒開）
    return { day, since, people, gift: settings.birthday?.gift ?? '' }
  }

  /**
   * `part=names&ids=U…,U…`（`C-467`，2026-11-05 老闆「uid 對使用者是沒有意義的」）：「匯入名單」那一格的編號講成名字。
   * 已存的草稿重開、別人貼來的名單，推播頁拿不到名字——這裡照編號查好友的 LINE 名稱。
   * ⚠️ 一次最多 100 位（一位一筆讀取；畫面也只列前幾個名字）；⛔ 只查這個帳號的好友（文件 id 帶帳號前綴）。
   * ⚠️ 借這支路由不另開一支（TS2589）。
   */
  if (query.part === 'names') {
    const ids = [...new Set(String(query.ids ?? '').split(',').map(s => s.trim()).filter(s => /^U[0-9a-f]{32}$/i.test(s)))].slice(0, 100)
    if (!ids.length) return { names: {} }
    const db = getDb()
    const snaps = await db.getAll(...ids.map(id => db.collection('users').doc(lineUserFirestoreDocId(id, workspaceId))))
    const names: Record<string, string> = {}
    snaps.forEach((s, i) => {
      const n = String(s.exists ? (s.data()?.displayName ?? '') : '').trim()
      if (n) names[ids[i]!] = n.slice(0, 40)
    })
    return { names }
  }

  /**
   * `planOnly=1`：**只問推播等級**（`C-352`①）——好友頁、好友統計、首頁檔期卡、活動精靈要在入口就講方案限制，
   * 它們只需要這一格。⛔ 排在讀清單之前：清單是整個推播集合，為了一個等級把每一則都讀一遍是白付讀取費。
   * 跟 `withPlan` 同一個規矩：只回等級、不回方案名（`G-103`）；null＝讀不到訂閱（畫面不鎖，推播頁與送出端照擋）。
   */
  if (query.planOnly) {
    return { broadcastTier: await workspaceBroadcastTier(workspaceId) }
  }

  /**
   * `lineQuotaOnly=1`：**只問 LINE 這個月還剩幾則**（`D-146`）——登入後第一頁那一條、用完時每一頁最上面的紅條要用。
   * 跟 `planOnly` 同一個做法：放在推播自己的端點、排在讀清單之前（⛔ 不為了一個數字把整個推播集合讀一遍），
   * 不另開端點（多一支路由 typecheck 會在不相干的地方爆型別太深）。走 5 分鐘快取：每換一頁都會問，不必每次打 LINE。
   * null＝還沒接 LINE 或這次問不到（畫面不顯示）。
   */
  if (query.lineQuotaOnly) {
    const r = await readLineMessageQuotaCached(workspaceId)
    return { lineQuota: r.kind === 'ok' ? r.quota : null }
  }

  const statusFilter = query.status as string | undefined

  /**
   * `withLineQuota=1`（要配分頁參數）：順便回 LINE 這個月還剩幾則（`C-380`），推播頁左邊那一行。
   * 跟 `withPlan` 同一趟問、不另開端點（多一支路由 typecheck 會在不相干的地方爆型別太深）。
   * 先起跑、最後才等：跟讀清單並行。讀不到是 null（它自己吞錯，不會讓清單失敗）。
   */
  const lineQuotaP = query.withLineQuota ? getLineMessageQuota(workspaceId) : null

  const broadcasts = await listDocs<BroadcastDoc>('broadcasts', ref =>
    ref.where('workspaceId', '==', workspaceId).orderBy('createdAt', 'desc'),
  )

  const filtered = statusFilter
    ? broadcasts.filter(b => b.status === statusFilter)
    : broadcasts

  /**
   * ⛔ `sentContent`（`C-246` 存的「當時真的送出去的那幾則」）**不跟著清單回**：
   * 它含圖文訊息的整份設定，一則好幾 KB，而清單一次回幾十則、背景還會定時刷新。
   * 要看那一份的只有「點開某一則」那個當下，去 `GET /api/broadcast/:id` 拿就好
   * （同 `messages` 當初被拿掉的理由，見 `docs/ADMIN-PERF-AUDIT-20260827.md`）。
   */
  const rows = filtered.map(({ audienceSnapshot, messages, sentContent, ...rest }) => ({
    ...rest,
    audienceSnapshot: {
      estimatedCount: audienceSnapshot?.estimatedCount ?? 0,
      filter: audienceSnapshot?.filter ?? null,
    },
    messageCount: Array.isArray(messages) ? messages.length : 0,
  }))

  const result = paginateInMemoryList(rows, query)

  /**
   * `withPlan=1`（要配分頁參數）：順便回這個帳號的推播等級（`D-131`）——推播頁拿它先把選不到的發送對象鎖起來，
   * 不要等按了送出才失敗。放在推播自己的端點而不是方案摘要：客服（agent）也會發推播、也要知道哪些選不了，
   * 而方案摘要要管理員權限。⛔ 只回等級、不回方案名（方案名屬計費資訊，`G-103`）。null＝讀不到訂閱（畫面不鎖，送出端照擋）。
   */
  if ((query.withPlan || lineQuotaP) && !Array.isArray(result)) {
    const [broadcastTier, lineQuota] = await Promise.all([
      query.withPlan ? workspaceBroadcastTier(workspaceId) : undefined,
      lineQuotaP ?? undefined,
    ])
    return {
      ...result,
      ...(query.withPlan ? { broadcastTier } : {}),
      ...(lineQuotaP ? { lineQuota } : {}),
    }
  }
  return result
})
