import { v4 as uuidv4, v5 as uuidv5 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { CLICK_TRACKING_VERSION, wrapBroadcastMessagesForClickTracking } from './broadcast-click-track'
import { multicastMessage, pushMessagesPerRecipient } from './line'
import { renderModuleToLineMessages } from './handler'
import { attributeContextForUser, renderBroadcastMessagesForSend } from './render-attributes'
import { findSendVariables } from '~~/shared/preview-variables'
import { broadcastAggregationUnit } from '~~/shared/broadcast-insight'
import { lineStatsNextDueAt } from '~~/shared/broadcast-line-stats'
/**
 * ⛔ 「這則推播會不會被換成模組內容」的判斷**不在這支檔案裡自己寫一份**（`C-245`）：
 * 後台預覽要靠同一個判斷決定「要畫卡片還是畫模組內容」，兩邊各寫一份就會漂開，
 * 而漂開的結果就是 `C-229` 那個畫了四個月、客人一次都沒收到的預覽。
 */
import { extractBroadcastTriggerModuleId } from '~~/shared/broadcast-content'
import { lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { resolveAudienceUserIds } from './audience'
import { addTagsToUser } from './tagging'
import { getWorkspacePlan } from './billing'
import { planAllowsBroadcast, type BroadcastTier } from '~~/shared/billing/plans'
import { claimBroadcastForSend, type BroadcastSendSource } from './broadcast-claim'
import { BROADCAST_ALL_RECIPIENTS_FAILED, humanizeBroadcastSendFailure } from '~~/shared/broadcast-failure'
import type { BroadcastDoc, BroadcastDeliveryDoc, AudienceFilter } from '~~/shared/types/tag-broadcast'

export type ExecuteBroadcastSendOptions = {
  /** manual：後台立即發送（僅 draft）；scheduler：Cron 到期排程 */
  source?: BroadcastSendSource
}

/**
 * 一人一則送時，每一位的重送編號＝「這則推播＋這位客人」算出來的固定值（`D-118` A）。
 * ⛔ 不放重發次數：送到一半斷掉→重設→再送時要算出**同一個**編號，LINE 才會把已經收過的人擋下來。
 */
const BROADCAST_RETRY_KEY_NS = '0b7d5c1e-3f4a-4c8e-a2b9-6d1e8f3a7c52'
export function broadcastRetryKey(broadcastId: string, lineUserId: string): string {
  return uuidv5(`${broadcastId}:${lineUserId}`, BROADCAST_RETRY_KEY_NS)
}

/**
 * 一人一則送要用的每位客人資料（名字、收集到的欄位）。
 * 只讀換變數用得到的三格；一次 300 份分批讀（Firestore 的 getAll 一次塞太多會很慢）。
 * 讀不到的人回空的＝名字那一格留空（跟一般回覆取不到名字同一個結果）。
 */
async function loadAttributeContexts(
  db: FirebaseFirestore.Firestore,
  docIds: string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>()
  const CHUNK = 300
  const chunks: string[][] = []
  for (let i = 0; i < docIds.length; i += CHUNK) chunks.push(docIds.slice(i, i + CHUNK))
  await Promise.all(chunks.map(async (ids) => {
    const refs = ids.map(id => db.collection('users').doc(id))
    const snaps = await db.getAll(...refs, { fieldMask: ['displayName', 'lineUserId', 'attributes'] })
    for (const s of snaps) {
      if (s.exists) out.set(s.id, attributeContextForUser(s.data() as Record<string, unknown>))
    }
  }))
  return out
}

/**
 * 核心推播發送邏輯（共用於 /api/broadcast/:id/send 及排程觸發）
 */
export async function executeBroadcastSend(
  id: string,
  options: ExecuteBroadcastSendOptions = {},
): Promise<{
  success: boolean
  campaignId: string
  totalCount: number
  sentCount: number
  failedCount: number
  /** 訊息已送出、但發送後記帳未寫完時的說明（非發送失敗，呼叫端不該報「發送失敗」） */
  postSendError: string | null
  /**
   * LINE 收下了、但回報**每一位都沒送到**：推播本身會被標成 `failed`（`BROADCAST_ALL_RECIPIENTS_FAILED`）。
   * ⛔ 呼叫端寫操作紀錄要看這一格——`success` 在這種情況仍是 true（「有呼叫成功」），
   *    只看它的話紀錄會寫「送出了」，跟推播本身的「失敗」講反（2026-10-10 審查抓到）。
   */
  allFailed: boolean
}> {
  const source = options.source ?? 'manual'
  const runtimeConfig = useRuntimeConfig()
  const db = getDb()
  const ref = db.collection('broadcasts').doc(id)

  const data = await claimBroadcastForSend(id, source)
  const workspaceId = String(data.workspaceId || '').trim()
  if (!workspaceId) throw new Error('Broadcast missing workspaceId')

  if (!data.messages?.length) {
    throw new Error('No messages to send')
  }

  /**
   * 方案群發權限（`D-69` 拍板④）。**擋在這裡而不是只擋建立端點**，因為這是唯一的收斂點：
   * 手動送出、排程 cron（trigger-scheduled 沒有 workspace context）、重試，全都經過這裡。
   * 只擋 create 的話，「先建好再等排程送出」就整條繞過去了。
   *
   * 分眾（tags / audience / import）要 advanced；全體推播要 basic。
   */
  const plan = await getWorkspacePlan(workspaceId, db)
  if (plan) {
    const needsAdvanced = data.audienceSource.type !== 'all'
    const need: BroadcastTier = needsAdvanced ? 'advanced' : 'basic'
    if (!planAllowsBroadcast(plan, need)) {
      throw new Error(needsAdvanced
        ? `${plan.name}方案不含分眾推播，請改用全體推播或升級方案`
        : `${plan.name}方案不含群發推播，請升級方案`)
    }
  }

  // ── 解析受眾 ──────────────────────────────────────────────────────
  let resolvedUserIds: string[] = []

  /**
   * LINE 已回應後才會被填上：代表「訊息確實已經送出」。
   * 之後任何一步（deliveries 記錄、最終統計）掛掉,都不可再把整筆標成 failed——
   * 否則後台顯示「失敗／成功 0」,老闆會誤以為客人沒收到並重發。
   */
  type LineOutcome = {
    successCount: number
    failedCount: number
    allFailed: boolean
    aggregationUnit: string | null
    aggregationApplied: boolean
    /** 一人一則送時整批停下來的原因（本月額度用完這種），每一位都沒送到時拿來當失敗原因 */
    stoppedReason?: string | null
  }
  let lineOutcome: LineOutcome | null = null

  /** 發送結果的唯一寫法：三處寫入（checkpoint／最終／catch）都由此產生，避免欄位各寫一套而漂移 */
  const statsPatchFor = (o: LineOutcome) => ({
    status: o.allFailed ? 'failed' as const : 'completed' as const,
    sentCount: o.successCount,
    failedCount: o.failedCount,
    completedAt: FieldValue.serverTimestamp(),
    lineAggregationUnit: o.aggregationUnit,
    lineInsightAggregationApplied: o.aggregationApplied,
    // 每一條寫 failed 的路徑都要留下人看得懂的原因（小幫手警示已承諾「進去看失敗原因」）；
    // 成功時明確清成 null，才不會留著上一輪嘗試的舊原因
    // ⚠️ 一人一則送到一半整批停下來（額度用完）時講那個原因，⛔ 不要說成「多半是封鎖了」
    failureReason: o.allFailed ? (o.stoppedReason || BROADCAST_ALL_RECIPIENTS_FAILED) : null,
    /**
     * `D-121`：排上「發完第 1 天去問 LINE 的打開／點連結人數」。排程只讀這個時間到了的推播
     * （`server/utils/broadcast-line-stats.ts`），⛔ 少了這一欄這則就永遠不會被問到。
     * 一個人都沒送到的沒有人數可問，不排。
     */
    lineStatsNextAt: o.successCount > 0 ? lineStatsNextDueAt(Date.now(), null) : FieldValue.delete(),
  })

  try {
    if (data.audienceSource.type === 'all') {
      let query = db.collection('users').select('isBlocked') as FirebaseFirestore.Query
      if (workspaceId) query = query.where('workspaceId', '==', workspaceId)
      const usersSnap = await query.get()
      resolvedUserIds = usersSnap.docs
        .filter((d) => d.data().isBlocked !== true)
        .map((d) => d.id)
    }
    else if (data.audienceSource.type === 'tags' && data.audienceSource.tagIds?.length) {
      const filter: AudienceFilter = {
        conditions: [{ type: 'includeAny', tagIds: data.audienceSource.tagIds }],
        joinedAfter: null,
        joinedBefore: null,
        isBlocked: false,
      }
      resolvedUserIds = await resolveAudienceUserIds(filter, workspaceId)
    }
    else if (data.audienceSource.type === 'audience' && data.audienceSource.audienceId) {
      const audienceSnap = await db.collection('audiences').doc(data.audienceSource.audienceId).get()
      if (!audienceSnap.exists) throw new Error('Audience not found')
      if (String(audienceSnap.data()?.workspaceId || '') !== workspaceId) {
        throw new Error('Audience not found')
      }
      resolvedUserIds = await resolveAudienceUserIds(audienceSnap.data()!.filter as AudienceFilter, workspaceId)
    }
    else if (data.audienceSource.type === 'import') {
      resolvedUserIds = data.audienceSource.importedUserIds ?? []
    }

    if (!resolvedUserIds.length) {
      throw new Error('Resolved audience is empty')
    }

    // ── 組出「真正要送出去的那幾則」──────────────────────────────────
    const clickOrigin = String(runtimeConfig.clickTrackingBaseUrl || '').trim().replace(/\/$/, '')
    const triggerModuleId = extractBroadcastTriggerModuleId(data.messages)
    // 純文字／開網址：群發時變數換成空白再送（發模組那條路下面會整份換掉，規則相同）
    let outboundMessages = renderBroadcastMessagesForSend(data.messages)
    /** 一人一則送時，每一位用自己的資料重組（`D-118` A）。模組型下面換成模組的那一支 */
    let renderFor = (attributes: Record<string, string>) => renderBroadcastMessagesForSend(data.messages, attributes)
    /** 拿來看「有沒有用到變數」的那一份：送出去的是什麼就看什麼 */
    let contentForVariables: unknown = data.messages
    /**
     * `C-246`：把**真的送出去的那幾則**留下來。
     *
     * ⛔ 不留的話，「我那天到底發了什麼」永遠沒有答案：`broadcasts.messages` 存的是那張
     * 會被換掉的卡片，真正的內容在 `flows` 裡而模組**隨時會被改、沒有版本**。
     * ⚠️ 只有模組型才寫：非模組型的 `messages` 本身就是送出去的那一份，再存一份只會多一個
     * 可能漂掉的拷貝。
     */
    let sentContent: Record<string, unknown> | null = null
    if (triggerModuleId) {
      const rendered = await renderModuleToLineMessages(triggerModuleId, {
        workspaceId,
        requestOrigin: clickOrigin,
      })
      if (!rendered || rendered.lineMessages.length === 0) {
        throw new Error(`Broadcast module not found or empty: ${triggerModuleId}`)
      }
      outboundMessages = rendered.lineMessages as any[]
      renderFor = rendered.renderFor as (attributes: Record<string, string>) => any[]
      contentForVariables = rendered.hydratedMessages
      sentContent = {
        kind: 'module',
        moduleId: triggerModuleId,
        moduleName: String((rendered.flow as { name?: string })?.name || ''),
        /**
         * 存**編輯器格式**（圖文訊息已把當時的圖與熱區塞進 `payload`），因為後台的預覽元件
         * 讀的就是這個格式；存 LINE API 格式的話，回頭看只會看到一堆畫不出來的型別名。
         * ⛔ `undefined` 一定要先清掉——firebase-admin 沒開 `ignoreUndefinedProperties`，
         * 帶著 `undefined` 寫入會整筆丟例外，而這時訊息可能已經送出去了。
         */
        messages: JSON.parse(JSON.stringify(rendered.hydratedMessages ?? [])),
        lineMessageCount: rendered.lineMessages.length,
      }
    }

    /**
     * `D-118` A（2026-10-15 老闆「要看得到名字」）：**內容用了 {{變數}} 才一人一則送**，沒用的照舊群發。
     * ⛔ 不要全部改成一人一則：沒有變數的推播一人一則送不會多得到任何東西，只會更慢、多打幾千次 LINE。
     * 以前群發時變數一律是空白——9/29 起 MYFEEL 7 則上市／倒數推播、約 8,500 人次收到開頭空一格的句子。
     */
    const sendMode: 'perRecipient' | 'multicast' = findSendVariables(contentForVariables).length > 0
      ? 'perRecipient'
      : 'multicast'

    // ── 寫入受眾快照（status 已在 claim 時改為 processing）────────────
    const snapshotAt = FieldValue.serverTimestamp()
    await ref.update({
      totalCount: resolvedUserIds.length,
      'audienceSnapshot.resolvedUserIds': resolvedUserIds,
      'audienceSnapshot.estimatedCount': resolvedUserIds.length,
      /**
       * 這一次是群發還是一人一則（`D-118` A）。⚠️ 後台回頭看已送出的推播時靠它決定預覽畫名字還是空白
       * （這一欄之前送的都是群發＝名字是空白）；看門狗也靠它判斷「重發會不會重複」。
       * ⛔ 一定要在呼叫 LINE **之前**寫：送到一半斷掉時，看門狗讀得到。
       */
      sendMode,
      ...(sentContent ? { sentContent: { ...sentContent, at: snapshotAt } } : {}),
      /**
       * `C-301`：這一次發送的點擊紀錄認不認得圖片上的連結。成效頁靠它決定要不要講
       * 「這則發送時，圖片上的連結還不會記錄點擊」——舊推播的次數只算到文字按鈕。
       */
      ...(clickOrigin.startsWith('http') ? { clickTrackingVersion: CLICK_TRACKING_VERSION } : {}),
      // `D-121`：重設後再發一次是新的一輪，上一輪存下來的 LINE 人數不可以留著冒充這一輪
      lineStats: FieldValue.delete(),
      updatedAt: snapshotAt,
    })

    // ── 呼叫 LINE（群發或一人一則）──────────────────────────────────

    const wrapForLine = (messages: any[]) => (clickOrigin.startsWith('http')
      ? wrapBroadcastMessagesForClickTracking(messages, id, clickOrigin)
      : messages)

    if (!clickOrigin.startsWith('http')) {
      console.warn('[broadcast/send] PUBLIC_BASE_URL（或舊名 LINE_IMAGEMAP_BASE_URL／CLICK_TRACKING_BASE_URL）未設定，推播 URI 點擊不會寫入 broadcastClickLogs')
    }

    const recipients = resolvedUserIds
      .map((docId) => ({
        docId,
        lineUserId: String(lineUserIdFromFirestoreDocId(docId, workspaceId) || '').trim(),
      }))
      .filter((r) => Boolean(r.lineUserId))
    const lineUserIds = recipients.map((r) => r.lineUserId)

    if (!lineUserIds.length) {
      throw new Error('No valid LINE user IDs in audience')
    }

    // 重發過的推播要換一個彙總單位，否則 LINE 會把上一次的開封／點擊算進這一次
    const lineUnit = broadcastAggregationUnit(id, Number(data.retryCount ?? 0) + 1)
    let successCount: number
    let failedIds: string[]
    let lineAggregationApplied: boolean
    /** 一人一則才拿得到每一位各自的原因；群發是一批 500 人一起回 */
    let failureReasons: Record<string, string> = {}
    let stoppedReason: string | null = null

    if (sendMode === 'perRecipient') {
      const contexts = await loadAttributeContexts(db, recipients.map(r => r.docId))
      const contextByLineUserId = new Map(recipients.map(r => [r.lineUserId, contexts.get(r.docId) ?? {}]))
      const pushed = await pushMessagesPerRecipient(
        recipients.map(r => ({ lineUserId: r.lineUserId, retryKey: broadcastRetryKey(id, r.lineUserId) })),
        lineUserId => wrapForLine(renderFor(contextByLineUserId.get(lineUserId) ?? {})) as any,
        workspaceId,
        { customAggregationUnits: [lineUnit] },
      )
      ;({ successCount, failedIds, lineAggregationApplied, failureReasons, stoppedReason } = pushed)
      if (pushed.alreadySentCount) {
        // 送到一半斷掉後重發：這些人上一輪就收到了，LINE 認出同一個重送編號沒有再送（算在送達裡）
        console.info(`[broadcast/send] ${id}：${pushed.alreadySentCount} 位上一輪已收到，這一輪沒有重複送`)
      }
    }
    else {
      ;({ successCount, failedIds, lineAggregationApplied } = await multicastMessage(
        lineUserIds,
        wrapForLine(outboundMessages) as any,
        workspaceId,
        { customAggregationUnits: [lineUnit] },
      ))
    }

    if (!lineAggregationApplied) {
      console.warn('[broadcast/send] LINE 未套用 customAggregationUnits，開封數將無法從 LINE Insight 取得')
    }

    lineOutcome = {
      successCount,
      failedCount: failedIds.length,
      // 直接看有沒有人收到。failedIds 只會來自實際送出的 lineUserIds，
      // 拿它比 resolvedUserIds（過濾無效收件人「之前」的人數）會讓「全退回」永遠判不成立
      allFailed: successCount === 0,
      aggregationUnit: lineAggregationApplied ? lineUnit : null,
      aggregationApplied: lineAggregationApplied,
      stoppedReason,
    }

    // ── 送出後立刻落地發送結果（checkpoint）──────────────────────────
    // LINE 已回應，此刻起結果就是定局：狀態與人數一次寫死，
    // 後面記帳（deliveries、postSendError）再怎麼掛，都不會讓報表歸零或卡在 processing
    await ref.update({
      ...statsPatchFor(lineOutcome),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch((e) => {
      console.error('[broadcast/send] 發送結果 checkpoint 寫入失敗（訊息已送出）:', e)
    })

    // ── 發完幫「真的收到的人」貼標（`C-213`，選填）────────────────────
    //
    // ⛔ **放在 checkpoint 之後**：狀態與人數此刻已經寫死，這一段再怎麼掛都不會讓推播
    //    卡在「發送中」（08-13 那次卡死的教訓）。
    // ⛔ **只貼給送成功的人**：失敗的多半是封鎖了官方帳號，貼上去是一句謊話。
    // ⛔ **結果要寫回文件**，不可以只寫 log——貼失敗時畫面要講得出「訊息發出去了、
    //    但記號沒貼完」，否則之後照那顆標籤挑名單會漏人而且查不出為什麼。
    const completionTagIds = Array.isArray((data as any).completionTagIds)
      ? ((data as any).completionTagIds as string[]).map(String).filter(Boolean)
      : []
    if (completionTagIds.length) {
      const failedForTagging = new Set(failedIds)
      const succeeded = recipients.filter(r => !failedForTagging.has(r.lineUserId))
      let taggedCount = 0
      let tagFailedCount = 0
      // 分小批跑，不要一次丟幾百個 promise 出去（發送主線已經跑完，但這裡仍在同一個函式裡）
      const CHUNK = 20
      for (let i = 0; i < succeeded.length; i += CHUNK) {
        const chunk = succeeded.slice(i, i + CHUNK)
        const results = await Promise.allSettled(chunk.map(r =>
          // ⛔ 走既有的 addTagsToUser，不要另寫一份寫入——那支還維護命中次數等欄位
          addTagsToUser(r.docId, completionTagIds, 'system', `broadcast:${id}`, workspaceId),
        ))
        for (const res of results) {
          if (res.status === 'fulfilled') taggedCount += 1
          else tagFailedCount += 1
        }
      }
      if (tagFailedCount) {
        console.error(`[broadcast/send] 發完貼標有 ${tagFailedCount} 位失敗（訊息已送出）`)
      }
      await ref.update({
        completionTagOutcome: {
          taggedCount,
          failedCount: tagFailedCount,
          at: FieldValue.serverTimestamp(),
        },
      }).catch((e) => {
        console.error('[broadcast/send] 貼標結果寫入失敗:', e)
      })
    }

    // ── 只記「沒收到的人」到 deliveries ───────────────────────────────
    // 成功者不逐筆記錄：受眾名單已存在 audienceSnapshot，成功＝名單減掉失敗名單，
    // 且 LINE 的「成功」只代表它收下訊息、不代表客人看到（那是報表的開封數）。
    // 全員送達時這裡一筆都不寫，直接消掉了 3000＋人推播最容易逾時的一步。
    let postSendError: string | null = null
    const failedSet = new Set(failedIds)
    const failedRecipients = recipients.filter(r => failedSet.has(r.lineUserId))

    if (failedRecipients.length) {
      try {
        const BATCH_LIMIT = 400
        let batch = db.batch()
        let opsInBatch = 0

        const flushBatch = async () => {
          if (opsInBatch > 0) {
            await batch.commit()
            batch = db.batch()
            opsInBatch = 0
          }
        }

        const createdAt = FieldValue.serverTimestamp()

        for (const r of failedRecipients) {
          const deliveryDoc: BroadcastDeliveryDoc = {
            campaignId: id,
            userId: r.docId,
            deliveryStatus: 'failed',
            // 群發是一批最多 500 人一起回覆結果，拿不到每個人各自的原因；一人一則有
            failureReason: failureReasons[r.lineUserId] ?? 'LINE multicast failed',
            sentAt: null,
            createdAt,
          }

          const deliveryRef = db.collection('broadcasts').doc(id).collection('deliveries').doc(uuidv4())
          batch.set(deliveryRef, deliveryDoc)
          opsInBatch++

          if (opsInBatch >= BATCH_LIMIT) await flushBatch()
        }

        await flushBatch()
      }
      catch (e) {
        postSendError = `沒收到的名單未寫完：${e instanceof Error ? e.message : String(e)}`
        console.error('[broadcast/send] 失敗名單寫入失敗（訊息已送出，不影響推播結果）:', e)
      }
    }

    // ── 補記 postSendError（checkpoint 若失敗，這裡順便再寫一次結果）──
    await ref.update({
      ...statsPatchFor(lineOutcome),
      postSendError,
      updatedAt: FieldValue.serverTimestamp(),
    })

    return {
      success: true,
      campaignId: id,
      totalCount: resolvedUserIds.length,
      sentCount: lineOutcome.successCount,
      failedCount: lineOutcome.failedCount,
      postSendError,
      allFailed: lineOutcome.allFailed,
    }
  }
  catch (e) {
    const failedAt = FieldValue.serverTimestamp()
    const reason = e instanceof Error ? e.message : String(e)

    // lineOutcome 有值＝LINE 已收下訊息，壞掉的只是後續記帳。
    // 這種情形不可對外報「發送失敗」——否則老闆會以為客人沒收到而重發。
    if (lineOutcome) {
      const postSendError = `訊息已送出，但發送後的統計未寫完：${reason}`
      console.error('[broadcast/send] 發送後記帳中斷（訊息已送出）:', e)
      await ref.update({
        ...statsPatchFor(lineOutcome),
        postSendError,
        updatedAt: failedAt,
      }).catch(() => {})
      return {
        success: true,
        campaignId: id,
        totalCount: resolvedUserIds.length,
        sentCount: lineOutcome.successCount,
        failedCount: lineOutcome.failedCount,
        postSendError,
        allFailed: lineOutcome.allFailed,
      }
    }

    // 還沒送出就失敗：確實是發送失敗
    await ref.update({
      status: 'failed',
      failureReason: humanizeBroadcastSendFailure(reason),
      updatedAt: failedAt,
    }).catch(() => {})
    throw e
  }
}
