import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { wrapBroadcastMessagesForClickTracking } from './broadcast-click-track'
import { multicastMessage } from './line'
import { renderModuleToLineMessages } from './handler'
import { broadcastAggregationUnit } from '~~/shared/broadcast-insight'
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
    failureReason: o.allFailed ? BROADCAST_ALL_RECIPIENTS_FAILED : null,
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
    let outboundMessages = data.messages
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

    // ── 寫入受眾快照（status 已在 claim 時改為 processing）────────────
    const snapshotAt = FieldValue.serverTimestamp()
    await ref.update({
      totalCount: resolvedUserIds.length,
      'audienceSnapshot.resolvedUserIds': resolvedUserIds,
      'audienceSnapshot.estimatedCount': resolvedUserIds.length,
      ...(sentContent ? { sentContent: { ...sentContent, at: snapshotAt } } : {}),
      updatedAt: snapshotAt,
    })

    // ── 呼叫 LINE multicast API ──────────────────────────────────────

    const messagesForLine = clickOrigin.startsWith('http')
      ? wrapBroadcastMessagesForClickTracking(outboundMessages, id, clickOrigin)
      : outboundMessages

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
    const { successCount, failedIds, lineAggregationApplied } = await multicastMessage(
      lineUserIds,
      messagesForLine as any,
      workspaceId,
      { customAggregationUnits: [lineUnit] },
    )

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
            // LINE 是一批最多 500 人一起回覆結果，拿不到每個人各自的原因
            failureReason: 'LINE multicast failed',
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
