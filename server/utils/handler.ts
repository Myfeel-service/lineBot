import type { webhook } from '@line/bot-sdk'
import type { messagingApi } from '@line/bot-sdk'
import { createError } from 'h3'
import { getDb } from './firebase'
import { replyMessage, pushMessage, getUserProfile, linkRichMenuIdToUser, showLoadingAnimation } from './line'
import { getLineWorkspaceCredentials } from './line-workspace-credentials'
import { resolveLineOaBasicId } from './line-oa-basic-id'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import {
  encodeTriggerMessage,
  encodeTriggerModule,
  parseTriggerMessageData,
  parseTriggerModuleData,
  parseSwitchMenuData,
} from '~~/shared/action-schema'
import {
  pickBestMatchingAutoReplyRule,
  normalizeAutoReplyAction,
  normalizeAutoReplyRule,
  normalizeAutoReplyCooldownsMap,
  normalizeAutoReplyModuleCooldownsMap,
  isAutoReplyRuleOnCooldown,
  isAutoReplyModuleOnCooldown,
  type AutoReplyRuleShape,
} from '~~/shared/auto-reply-rule'
import { RICH_LAYOUT_PRESETS } from '~~/shared/rich-layout-presets'
import { normalizeRichMessageActions } from '~~/shared/rich-message-editor-helpers'
import { resolveRichMessageFromImageSize, resolveFlexImageCarouselAspectRatio } from '~~/shared/line-image-spec'
import { archiveConversationMedia } from './conversation-media'
import { readInboundImage } from './media-describe'
import { clearClaimPushMarkFailure, recordClaimPushMarkFailure } from './claim-push-health'
import { createImagemapImageToken } from './line-imagemap-image-token'
import { createUriTagToken } from './line-action-tag-token'
import { addTagsToUser } from './tagging'
import {
  ensureConversationSession,
  enterModule,
  getSessionStatusCached,
  onHumanOutgoingMessage,
  recordConversationEvent,
  shouldSuppressInboundBotAutomationForSession,
} from './conversation-session'
import type { ModuleType } from '~~/shared/types/conversation-stats'
import { SYSTEM_MODULE_IDS } from '~~/shared/types/conversation-stats'
import { answerWithAi, routeMessage, summarizeHandoffContext, truncateLabel, type AiChatTurn, type RouteResult } from './ai-answer'
import { getAiSettings } from './ai-settings'
import { recordAiUsage } from './ai-usage'
import { notifyHandoffToStaff } from './ai-handoff-notify'
import { tryConsumeMemberLineBindCode } from './member-line-bind'
import { detectSensitiveTopic, DEFAULT_DND_REPLY, type AiConversationMeta, type HandoffReason } from '~~/shared/types/ai-knowledge'
import { isServiceHoursDnd } from '~~/shared/time'
import { HUMAN_REQUEST_TEXTS, matchesScriptKeywords, type ActiveScriptState, type ScriptDoc } from '~~/shared/types/ai-script'
import { advanceScript, loadActiveScripts, startScript } from './ai-scripts'
import {
  lineUserFirestoreDocId,
  lineUserIdFromFirestoreDocId,
} from '~~/shared/line-workspace'
import { capMapSize } from './bounded-cache'
import { systemModuleId } from './workspace-system-modules'

// ── In-Memory Caching to Reduce DB Latency ──────────────────────────

interface CacheEntry<T> {
  data: T
  expires: number
}
const flowDocCache = new Map<string, CacheEntry<FlowDoc | null>>()
const richMessageCache = new Map<string, CacheEntry<any | null>>()
const autoReplyRuleCache = new Map<string, CacheEntry<AutoReplyRuleShape[]>>()
const userDocCache = new Map<string, CacheEntry<UserDoc | null>>()

// Cache lifetime in milliseconds (increased to 60s for better hit rate)
const CACHE_TTL_MS = 60 * 1000
// Shorter TTL for user docs since activeInput/attributes change more often
const USER_CACHE_TTL_MS = 30 * 1000
// 快取上限：userDocCache 以使用者為 key 會隨活躍用戶成長，必須設上限
const CACHE_MAX_ENTRIES = 1000
const USER_CACHE_MAX_ENTRIES = 5000

function requireWorkspaceId(workspaceId: string | undefined, context: string): string {
  const wid = String(workspaceId || '').trim()
  if (!wid) throw createError({ statusCode: 400, statusMessage: `workspaceId is required in ${context}` })
  return wid
}

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const cached = map.get(key)
  if (cached && cached.expires > Date.now()) {
    return cached.data
  }
  return undefined
}

function setCache<T>(map: Map<string, CacheEntry<T>>, key: string, data: T) {
  map.set(key, { data, expires: Date.now() + CACHE_TTL_MS })
  capMapSize(map, CACHE_MAX_ENTRIES)
}

function setUserDocCache(docId: string, data: UserDoc) {
  userDocCache.set(docId, { data, expires: Date.now() + USER_CACHE_TTL_MS })
  capMapSize(userDocCache, USER_CACHE_MAX_ENTRIES)
}

function invalidateUserDocCache(docId: string) {
  userDocCache.delete(docId)
}

export function invalidateActiveAutoReplyRulesCache(workspaceId: string) {
  autoReplyRuleCache.delete(`active:autoReplies:${workspaceId}`)
}

/** 一次讀取使用者文件，同時取出冷卻狀態與 activeInput，節省 Firestore round-trip */
async function loadUserStateForIncomingText(fsUserDocId: string): Promise<{
  ruleCooldowns: Record<string, number>
  moduleCooldowns: Record<string, { triggeredAt: number; durationMs: number }>
  activeInput: UserDoc['activeInput'] | null
}> {
  const snap = await getDb().collection('users').doc(fsUserDocId).get()
  if (!snap.exists) {
    return { ruleCooldowns: {}, moduleCooldowns: {}, activeInput: null }
  }
  const data = snap.data() as UserDoc | undefined
  return {
    ruleCooldowns: normalizeAutoReplyCooldownsMap(
      data?.autoReplyCooldowns as Record<string, unknown> | undefined,
    ),
    moduleCooldowns: normalizeAutoReplyModuleCooldownsMap(
      data?.autoReplyModuleCooldowns as Record<string, unknown> | undefined,
    ),
    activeInput: data?.activeInput ?? null,
  }
}

/**
 * 原子性地確認冷卻狀態並寫入觸發時間。
 * 使用 Firestore Transaction，確保並行請求（同一使用者快速連傳）只有第一則真正觸發。
 * 回傳 true = 可以觸發；false = 已在冷卻中
 */
async function claimAutoReplyCooldown(
  fsUserDocId: string,
  rule: AutoReplyRuleShape,
): Promise<boolean> {
  if (!rule.cooldown?.enabled || !rule.id) return true

  const db = getDb()
  const userRef = db.collection('users').doc(fsUserDocId)
  const ruleId = rule.id
  const durationMs = Number(rule.cooldown.durationMs)
  const triggeredAt = Date.now()
  let shouldTrigger = false

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef)
      const data = snap.data() as UserDoc | undefined
      const cooldowns = normalizeAutoReplyCooldownsMap(
        data?.autoReplyCooldowns as Record<string, unknown> | undefined,
      )

      if (isAutoReplyRuleOnCooldown(rule, cooldowns, triggeredAt)) {
        shouldTrigger = false
        return
      }

      shouldTrigger = true
      const updates: Record<string, unknown> = {
        [`autoReplyCooldowns.${ruleId}`]: triggeredAt,
      }
      if (rule.action.type === 'module' && rule.action.moduleId) {
        updates[`autoReplyModuleCooldowns.${rule.action.moduleId}`] = {
          triggeredAt,
          durationMs,
        }
      }

      if (snap.exists) {
        tx.update(userRef, updates)
      } else {
        const mergeData: Record<string, unknown> = {
          autoReplyCooldowns: { [ruleId]: triggeredAt },
        }
        if (rule.action.type === 'module' && rule.action.moduleId) {
          mergeData.autoReplyModuleCooldowns = {
            [rule.action.moduleId]: { triggeredAt, durationMs },
          }
        }
        tx.set(userRef, mergeData, { merge: true })
      }
    })
  } catch (e) {
    // fail-closed：Firestore 故障時寧可這一輪不觸發，也不要讓冷卻全面失效造成大量重複觸發
    console.error('[autoReply] cooldown transaction error (fail-closed):', e)
    return false
  }

  if (shouldTrigger) {
    const entry = userDocCache.get(fsUserDocId)
    if (entry?.data) {
      entry.data.autoReplyCooldowns = {
        ...(entry.data.autoReplyCooldowns ?? {}),
        [ruleId]: triggeredAt,
      }
    }
  }
  return shouldTrigger
}

// ── Type Definitions ──────────────────────────────────────────────

interface FlowDoc {
  trigger: string
  messages: messagingApi.Message[]
  isActive: boolean
  moduleType?: ModuleType
  isSystem?: boolean
  /** 模組名稱（值班通知要寫「客人按了『真人客服』」，不然客服看不出他按了什麼） */
  name?: string
}

interface UserDoc {
  workspaceId?: string
  lineUserId?: string
  displayName: string
  pictureUrl: string
  createdAt: FirebaseFirestore.FieldValue
  isBlocked?: boolean
  blockedAt?: FirebaseFirestore.FieldValue | null
  unblockedAt?: FirebaseFirestore.FieldValue | null
  activeInput?: {
    moduleId: string
    attribute?: string
    tagIds?: string[]
    expiresAt: number
  } | null
  activeScript?: ActiveScriptState | null
  attributes?: Record<string, string>
  autoReplyCooldowns?: Record<string, number>
  autoReplyModuleCooldowns?: Record<string, { triggeredAt: number; durationMs: number }>
}

function toConversationText(msg: messagingApi.Message): string {
  const type = (msg as any)?.type
  if (type === 'text') return String((msg as any).text || '').trim()
  if (type === 'image') return '[圖片]'
  if (type === 'video') return '[影片]'
  if (type === 'audio') return '[語音]'
  if (type === 'sticker') return '[貼圖]'
  if (type === 'location') return '[位置]'
  if (type === 'imagemap') return '[Imagemap]'
  if (type === 'template') return String((msg as any).altText || '[模板訊息]').trim()
  if (type === 'flex') return String((msg as any).altText || '[Flex 訊息]').trim()
  return `[${String(type || 'message')}]`
}

function sanitizeForFirestore(value: any): any {
  if (value === null) return null
  if (value === undefined) return undefined
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value
      .map(item => sanitizeForFirestore(item))
      .filter(item => item !== undefined)
  }
  if (typeof value === 'object') {
    const result: Record<string, any> = {}
    for (const [key, raw] of Object.entries(value)) {
      const parsed = sanitizeForFirestore(raw)
      if (parsed !== undefined) result[key] = parsed
    }
    return result
  }
  return undefined
}

function renderWithAttributes(value: string, attributes: Record<string, string>): string {
  if (!value || !value.includes('{{')) return value
  return value.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_, key: string) => {
    return attributes[key] ?? ''
  })
}

function buildAttributeContext(userData: UserDoc | null): Record<string, string> {
  const context: Record<string, string> = { ...(userData?.attributes ?? {}) }
  if (userData?.displayName) {
    context.displayName = userData.displayName
  }
  return context
}

/**
 * 把 {{屬性}} 換成這位客人的實際值。
 *
 * 給「先填進回覆框、客服改完再送」這種要先看到成品的路徑用——代換必須和真的送出
 * （buildAutoReplyActionMessages）是同一套，否則客服會把 {{displayName}} 原封不動送給客人。
 */
export function renderTextForUser(value: string, userData: Record<string, any> | null): string {
  return renderWithAttributes(value, buildAttributeContext((userData ?? null) as UserDoc | null))
}

// ── Helpers ───────────────────────────────────────────────────────

async function ensureUser(
  userIdOrDocId: string,
  preloadedProfile?: { displayName: string; pictureUrl: string } | null,
  workspaceId?: string,
): Promise<UserDoc | null> {
  const wid = requireWorkspaceId(workspaceId, 'ensureUser')
  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(userIdOrDocId, wid)
  const docId = lineUserFirestoreDocId(lineUserId, wid)

  // Return cached user data when no preloadedProfile is forcing a refresh
  if (!preloadedProfile) {
    const cached = getCached(userDocCache, docId)
    if (cached !== undefined) return cached
  }

  const ref = db.collection('users').doc(docId)
  const snap = await ref.get()

  if (!snap.exists) {
    // Use caller-supplied profile to avoid a redundant LINE API round-trip
    const profile = preloadedProfile ?? await getUserProfile(lineUserId, wid)
    const newDoc: UserDoc = {
      workspaceId: wid,
      lineUserId,
      displayName: profile?.displayName ?? lineUserId,
      pictureUrl: profile?.pictureUrl ?? '',
      createdAt: FieldValue.serverTimestamp(),
      isBlocked: false,
    }
    await ref.set(newDoc)
    setUserDocCache(docId, newDoc)
    return newDoc
  }

  const data = snap.data() as UserDoc
  if (data.isBlocked) {
    await ref.update({ isBlocked: false, unblockedAt: FieldValue.serverTimestamp() })
    // Don't cache blocked users — they're edge cases and we want fresh state next time
    return data
  }
  setUserDocCache(docId, data)
  return data
}

export async function handleFollowEvent(
  userId: string,
  preloadedProfile?: { displayName: string; pictureUrl: string } | null,
  workspaceId?: string,
): Promise<void> {
  const wid = requireWorkspaceId(workspaceId, 'handleFollowEvent')
  try {
    await ensureUser(userId, preloadedProfile, wid)
    console.log('[webhook] follow ensureUser:', userId)
    // Session creation and claim application are independent — run in parallel。
    // session 用 promise 傳下去（不先 await）：推播延遲不變，但推播後的「已回應」蓋章
    // 就能用同一場 session，不必再開一次交易去問「是哪一場」。
    // origin='follow':加好友/活動入口出生的 session,客人開口前不進首接統計
    const sessionPromise = ensureConversationSession(userId, wid, { origin: 'follow' }).catch((e) => {
      console.error('[session] follow session error:', e)
      return null
    })
    await Promise.all([
      sessionPromise,
      applyPendingClaims(userId, wid, sessionPromise),
    ])
  }
  catch (e) {
    console.error('[webhook] handleFollowEvent error:', e)
  }
}

/**
 * 原子性地把 leadClaim 從 claimed 轉成 applying（搶處理權）。
 * 回傳 true = 搶到鎖可處理；false = 已被其他請求處理中／已處理，跳過。
 * 處理中途當機會留下 applying 狀態：超過 2 分鐘視為 stale 可重搶；
 * 使用者重新點活動連結時 /api/liff/claim 也會把狀態重設回 claimed。
 */
const CLAIM_APPLYING_STALE_MS = 2 * 60 * 1000

async function claimLeadClaimForApply(
  ref: FirebaseFirestore.DocumentReference,
): Promise<boolean> {
  const db = getDb()
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return false
      const data = snap.data() ?? {}
      const status = String(data.status || '')
      const applyingAtMs = (data.applyingAt as FirebaseFirestore.Timestamp | undefined)?.toMillis?.() ?? 0
      const staleApplying = status === 'applying'
        && applyingAtMs > 0
        && (Date.now() - applyingAtMs) > CLAIM_APPLYING_STALE_MS
      if (status !== 'claimed' && !staleApplying) return false
      tx.update(ref, { status: 'applying', applyingAt: Timestamp.now() })
      return true
    })
  }
  catch (e) {
    // 搶鎖失敗（Firestore 故障）不處理：claim 維持 claimed，下次 follow / apply 再試
    console.error('[follow] claimLeadClaimForApply transaction error:', e)
    return false
  }
}

/**
 * follow 事件後，查詢此 userId 已綁定（claimed）但尚未套用的 leadClaim，
 * 依活動快照執行貼標，並選擇性推送機器人模組，最後標記 applied。
 */
/**
 * 活動／加好友推播送出後，把該工作區的會話移出「待處理」佇列。
 *
 * 記 system_notice 而不是 bot_flow 是刻意的（口徑見 docs/CONVERSATION-STATS-DEFINITIONS.md）：
 * 這則推播是客人沒問就送的，不是回答，
 * 記成機器人首接會讓活動流量灌水統計（活動辦越大灌越兇）。system_notice 只動 status、
 * 不動 initialHandler——客服不會再看到一筆「其實已經推播過」的待處理，統計也保持誠實。
 *
 * ⚠️ 這一步曾經安靜壞掉（2026-08 抽查同活動 40 筆只有 11 筆蓋到章），所以現在：
 *   1. 不再自己呼叫 ensureConversationSession。改用「已經建好的那一場」，缺失時由 enterModule
 *      自己從 conversations.currentSessionId 補撈（一次點讀）。少一次交易、也不再依賴
 *      in-memory 快取；而且推播本來就不該「創造」一場會話。
 *   2. 失敗往外丟，由呼叫端記進健康狀態（異常提醒中心看得到），不再只印 log。
 *
 * knownSessionId 為 null 時代表「這張 claim 的工作區與 follow 事件的工作區不同」
 * （見 claimWorkspaceId），不能沿用那一份 session，交給 enterModule 自己撈。
 */
async function markClaimPushHandled(
  userId: string,
  claimWorkspaceId: string,
  knownSessionId: string | null,
): Promise<void> {
  await enterModule(knownSessionId, userId, 'system_notice', undefined, claimWorkspaceId)
}

async function applyPendingClaims(
  userId: string,
  workspaceId: string,
  /** handleFollowEvent 已在建立的那一場 session（同工作區時才可沿用，見 markClaimPushHandled） */
  followSessionPromise?: Promise<string | null>,
): Promise<void> {
  const db = getDb()
  const now = new Date()
  const campaignWorkspaceCache = new Map<string, string>()

  const snap = await db.collection('leadClaims')
    .where('lineUserId', '==', userId)
    .where('status', '==', 'claimed')
    .get()

  if (snap.empty) return

  for (const doc of snap.docs) {
    const claim = doc.data()
    let claimWorkspaceId = String(claim.workspaceId || '').trim()
    if (!claimWorkspaceId && claim.campaignId) {
      const campaignId = String(claim.campaignId || '').trim()
      if (campaignId) {
        const cached = campaignWorkspaceCache.get(campaignId)
        if (cached) {
          claimWorkspaceId = cached
        }
        else {
          try {
            const campaignSnap = await db.collection('leadCampaigns').doc(campaignId).get()
            const wid = String(campaignSnap.data()?.workspaceId || '').trim()
            if (wid) {
              claimWorkspaceId = wid
              campaignWorkspaceCache.set(campaignId, wid)
              await doc.ref.set({ workspaceId: wid }, { merge: true })
            }
          }
          catch (e) {
            console.warn('[follow] resolve campaign workspace failed:', e, 'campaignId:', campaignId)
          }
        }
      }
    }
    if (!claimWorkspaceId) {
      console.warn('[follow] claim missing workspaceId, skipped:', doc.id)
      continue
    }

    // 原子搶鎖：claimed → applying。follow webhook 與 /api/liff/apply 可能併發處理
    // 同一張 claim，只有搶到鎖的一方執行貼標／推播，避免雙重套用。
    const locked = await claimLeadClaimForApply(doc.ref)
    if (!locked) {
      console.log('[follow] claim already being applied elsewhere, skipped:', doc.id)
      continue
    }

    const { channelSecret } = await getLineWorkspaceCredentials(claimWorkspaceId)

    // 逾期檢查：僅舊 claim 含 expiresAt 時有效
    const rawExp = claim.expiresAt
    if (rawExp != null) {
      const expiresAt = rawExp instanceof Date ? rawExp : rawExp?.toDate?.()
      if (expiresAt && expiresAt < now) {
        await doc.ref.update({ status: 'expired' })
        console.log('[follow] claim expired, skipping:', doc.id)
        continue
      }
    }

    // 活動下一步動作（同步計算，供下方並行使用）
    const action = normalizeAutoReplyAction(claim.action, String(claim.moduleId ?? ''))

    // 並行：貼標 + 取 flow（互不依賴）
    const [userData, taggingResult, flow] = await Promise.all([
      ensureUser(userId, undefined, claimWorkspaceId).catch((e) => {
        console.error('[follow] ensure user for claim workspace failed:', e, 'workspaceId:', claimWorkspaceId)
        return null
      }),
      Array.isArray(claim.tagIds) && claim.tagIds.length > 0
        ? addTagsToUser(
            lineUserFirestoreDocId(userId, claimWorkspaceId),
            claim.tagIds,
            'system',
            doc.id,
            claimWorkspaceId,
          )
        : Promise.resolve(null),
      action.type === 'module' && action.moduleId
        ? getFlowByModuleId(action.moduleId)
        : Promise.resolve(null),
    ])
    const userAttributes = buildAttributeContext(userData)

    if (taggingResult) {
      console.log('[follow] tagging result:', taggingResult, 'claimId:', doc.id)
    }

    /**
     * 推播 + 存訊息 + 後續動作 + 「已回應」蓋章。
     *
     * ⚠️ 這裡刻意**不用一個 Promise.all 包起來**：先前四件事綁在一起，任何一件失敗
     * （例如存訊息或 dispatchPostReplyActions 出錯）就會連帶跳過蓋章，
     * 結果是「客人收到推播了、會話卻永遠掛在待處理」——實測抽 40 筆只有 11 筆蓋到章。
     * 現在的規則：**推播成功就一定要蓋章**，其餘步驟各自失敗、互不牽連。
     */
    const pushAndMark = async (messages: messagingApi.Message[], label: string) => {
      const sideEffects: Array<Promise<unknown>> = [
        saveOutgoingConversationMessagesByWorkspace(userId, messages, claimWorkspaceId),
      ]
      if (action.type === 'module' && flow) {
        sideEffects.push(dispatchPostReplyActions(userId, flow.messages, claimWorkspaceId))
      }

      let pushed = false
      try {
        // 推播與「存訊息／後續動作」並行（互不依賴），但成敗分開判斷
        const [pushResult, ...sideResults] = await Promise.allSettled([
          pushMessage(userId, messages, claimWorkspaceId),
          ...sideEffects,
        ])
        pushed = pushResult!.status === 'fulfilled'
        if (!pushed) console.error(`[follow] ${label} push failed:`, (pushResult as PromiseRejectedResult).reason)
        // 副作用失敗不影響蓋章，但一定要留下記錄（客人收到了、後台卻沒有那則訊息）
        for (const r of sideResults) {
          if (r.status === 'rejected') console.error(`[follow] ${label} side effect failed:`, r.reason)
        }
      }
      catch (e) {
        // allSettled 不會 reject，走到這裡只可能是同步例外（例如訊息組裝有問題）
        console.error(`[follow] ${label} failed before push:`, e)
      }

      // 推播沒成功就不蓋章：客人什麼都沒收到，這場確實還需要人看一眼
      if (!pushed) return
      try {
        await markClaimPushHandled(
          userId,
          claimWorkspaceId,
          claimWorkspaceId === workspaceId ? await (followSessionPromise ?? Promise.resolve(null)) : null,
        )
        // 清狀態失敗不算蓋章失敗（章已經蓋上了）→ 不要走進下面的 catch 誤報
        await clearClaimPushMarkFailure(db, claimWorkspaceId)
          .catch(e => console.warn('[follow] clear mark failure state failed:', e))
      }
      catch (e) {
        // 蓋章失敗＝客服會看到假待辦。不再只印 log：寫進健康狀態，異常提醒中心看得到
        console.error('[follow] mark claim push handled failed:', e)
        await recordClaimPushMarkFailure(db, claimWorkspaceId, e)
          .catch(err => console.error('[follow] record mark failure failed:', err))
      }
    }

    if (action.type === 'module' && flow) {
      try {
        const hydratedMessages = await hydrateRichMessageRefs(flow.messages as any[])
        const lineMessages = buildLineMessages(
          hydratedMessages,
          userAttributes,
          '',
          userId,
          channelSecret,
        )
        if (lineMessages.length > 0) await pushAndMark(lineMessages, 'pushMessage module')
      }
      catch (e) {
        console.error('[follow] pushMessage module failed:', e)
      }
    }
    else if (action.type !== 'module') {
      const actionMessages = buildAutoReplyActionMessages(action, userAttributes)
      if (actionMessages.length > 0) await pushAndMark(actionMessages, 'pushMessage action')
    }

    // 標記已完成
    await doc.ref.update({
      status: 'applied',
      appliedAt: FieldValue.serverTimestamp(),
    })
    console.log('[follow] claim applied:', doc.id)
  }
}

export async function handleUnfollowEvent(
  userId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const db = getDb()
    const docId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, workspaceId), workspaceId)
    const ref = db.collection('users').doc(docId)
    const snap = await ref.get()
    if (snap.exists) {
      await ref.update({ isBlocked: true, blockedAt: FieldValue.serverTimestamp() })
    }
    console.log('[webhook] unfollow/block marked:', userId)
  }
  catch (e) {
    console.error('[webhook] handleUnfollowEvent error:', e)
  }
}

async function dispatchPostReplyActions(
  userId: string,
  messages: any[],
  workspaceId: string,
) {
  const userInputMsg = messages.find((m: any) => m.type === 'userInput')
  if (userInputMsg && userInputMsg.moduleId) {
    const db = getDb()
    const uid = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, workspaceId), workspaceId)
    const tagging = userInputMsg?.tagging
    const tagIds = tagging?.enabled && Array.isArray(tagging?.addTagIds)
      ? tagging.addTagIds.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : []
    await db.collection('users').doc(uid).set({
      activeInput: {
        moduleId: userInputMsg.moduleId,
        attribute: userInputMsg.attribute || null,
        tagIds,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
      }
    }, { merge: true })
    invalidateUserDocCache(uid)
  }
}

async function getFlowByModuleId(moduleId: string): Promise<FlowDoc | null> {
  const id = String(moduleId || '').trim()
  if (!id) return null
  const cacheKey = `flow:${id}`
  const cached = getCached(flowDocCache, cacheKey)
  if (cached !== undefined) return cached

  const db = getDb()
  const snap = await db.collection('flows').doc(id).get()
  const flow = (snap.exists && snap.data()?.isActive) ? (snap.data() as FlowDoc) : null
  setCache(flowDocCache, cacheKey, flow)
  return flow
}

async function loadActiveAutoReplyRules(workspaceId: string): Promise<AutoReplyRuleShape[]> {
  const cacheKey = `active:autoReplies:${workspaceId}`
  const cached = getCached(autoReplyRuleCache, cacheKey)
  if (cached !== undefined) return cached

  const db = getDb()
  // Use equality-only filter (no orderBy) to avoid requiring a composite Firestore index.
  // Sorting is done in-memory before normalization (createdAt is stripped by normalizeAutoReplyRule).
  const snap = await db.collection('autoReplies')
    .where('workspaceId', '==', workspaceId)
    .get()

  const rawDocs = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a: any, b: any) => {
      const aMs = a.createdAt?.toMillis?.() ?? a.createdAt ?? 0
      const bMs = b.createdAt?.toMillis?.() ?? b.createdAt ?? 0
      return bMs - aMs
    })

  const rules = rawDocs
    .map((raw) => normalizeAutoReplyRule(raw))
    .filter((rule) => rule.isActive)
  setCache(autoReplyRuleCache, cacheKey, rules)
  return rules
}

/**
 * 預熱單一 workspace 的機器人自動化快取（自動回覆規則、腳本、AI 設定、
 * 模組規則指到的 flow＋圖文訊息快照）。給 /api/warmup 的定時 ping 用：
 * Lambda 執行個體與 in-memory 快取一起保溫，客人觸發模組時就走全快取路徑。
 */
export async function warmWorkspaceAutomationCaches(workspaceId: string): Promise<void> {
  const [rules] = await Promise.all([
    loadActiveAutoReplyRules(workspaceId).catch(() => [] as AutoReplyRuleShape[]),
    loadActiveScripts(workspaceId).catch(() => []),
    getAiSettings(workspaceId).catch(() => null),
    // 活動入口（/api/liff/claim・config）會查 OA basicId；一併保溫（快取 24h）
    resolveLineOaBasicId(workspaceId).catch(() => ''),
  ])
  const moduleIds = [...new Set(
    rules
      .filter(r => r.action.type === 'module' && r.action.moduleId)
      .map(r => (r.action as { moduleId: string }).moduleId),
  )].slice(0, 30)
  await Promise.all(moduleIds.map(id =>
    getFlowByModuleId(id)
      .then(f => (f ? hydrateRichMessageRefs(f.messages as any[]) : null))
      .catch(() => null),
  ))
}

async function matchAutoReplyRule(
  inputText: string,
  workspaceId: string,
  options: {
    allowAnyText: boolean
    ruleCooldowns?: Record<string, number>
  } = { allowAnyText: true },
): Promise<AutoReplyRuleShape | null> {
  const rules = await loadActiveAutoReplyRules(workspaceId)
  const excludeRuleIds = new Set<string>()
  while (true) {
    const rule = pickBestMatchingAutoReplyRule(rules, inputText, {
      allowAnyText: options.allowAnyText,
      excludeRuleIds,
    })
    if (!rule?.id) return rule
    if (!isAutoReplyRuleOnCooldown(rule, options.ruleCooldowns)) return rule
    excludeRuleIds.add(rule.id)
  }
}

function buildAutoReplyActionMessages(
  action: AutoReplyRuleShape['action'],
  attributes: Record<string, string>,
): messagingApi.Message[] {
  if (action.type === 'message') {
    return [{
      type: 'text',
      text: renderWithAttributes(action.text || '', attributes).slice(0, 5000),
    } as messagingApi.TextMessage]
  }

  if (action.type === 'uri') {
    const targetUrl = renderWithAttributes(action.uri || '', attributes)
    return [{
      type: 'template',
      altText: '開啟網址',
      template: {
        type: 'buttons',
        text: '請點擊下方連結',
        actions: [{
          type: 'uri',
          label: '開啟網址',
          uri: targetUrl,
        }],
      },
    } as messagingApi.TemplateMessage]
  }

  return []
}

/**
 * 管理後台手動送出一則預存內容：以 push 發送，邏輯對齊自動回覆命中後的模組／文字／網址處理。
 * 兩個來源共用（action 是同一個 shape）：
 *   - 「客服預存」（/api/conversations/[userId]/send-preset）
 *   - 對話頁手動挑一則「自動回覆」規則（/api/conversations/[userId]/send-auto-reply）
 *
 * 送出後必須記 onHumanOutgoingMessage——這是真人客服的動作，與收件匣手打訊息
 * （/api/conversations/[userId]/send）同一件事。先前漏記造成兩個問題：
 *   1. 會話停在 open/unhandled，客服明明回過了卻一直掛在「未首接」佇列
 *   2. 更嚴重：狀態沒轉 human_handling → 機器人／AI 不會閉嘴，會跟真人搶話回客人
 *
 * sourceRefId＝這則內容的來源文件 id（預存 id 或自動回覆規則 id），只用於標籤紀錄的來源欄位。
 */
export async function pushSupportPresetActionToUser(
  userIdOrDocId: string,
  action: AutoReplyRuleShape['action'],
  tagging: AutoReplyRuleShape['tagging'],
  sourceRefId: string,
  requestOrigin: string,
  workspaceId: string,
): Promise<void> {
  const lineUserId = lineUserIdFromFirestoreDocId(userIdOrDocId, workspaceId)
  const fsUserDocId = lineUserFirestoreDocId(lineUserId, workspaceId)
  const userData = await ensureUser(userIdOrDocId, undefined, workspaceId)
  const userAttributes = buildAttributeContext(userData)
  const { channelSecret } = await getLineWorkspaceCredentials(workspaceId)

  if (tagging?.enabled && Array.isArray(tagging.addTagIds) && tagging.addTagIds.length > 0) {
    addTagsToUser(fsUserDocId, tagging.addTagIds, 'manual', sourceRefId, workspaceId).catch((e) => {
      console.error('[supportPreset] tagging failed:', e)
    })
  }

  if (action.type === 'module') {
    const flow = await getFlowByModuleId(action.moduleId)
    if (!flow) {
      throw createError({ statusCode: 400, statusMessage: '找不到或已停用的機器人模組' })
    }
    const hydratedMessages = await hydrateRichMessageRefs(flow.messages as any[])
    const lineMessages = buildLineMessages(
      hydratedMessages,
      userAttributes,
      requestOrigin,
      lineUserId,
      channelSecret,
    )
    if (lineMessages.length === 0) {
      throw createError({ statusCode: 400, statusMessage: '此機器人模組沒有可發送的訊息' })
    }
    await pushMessage(lineUserId, lineMessages, workspaceId)
    saveOutgoingConversationMessagesByWorkspace(lineUserId, lineMessages, workspaceId).catch(e => console.error('[conv] save error:', e))
    dispatchPostReplyActions(lineUserId, flow.messages, workspaceId).catch(e => console.error('[postReply] dispatchPostReplyActions failed:', e))
    onHumanOutgoingMessage(userIdOrDocId, workspaceId).catch(e => console.error('[supportPreset] onHumanOutgoing error:', e))
    return
  }

  const actionMessages = buildAutoReplyActionMessages(action, userAttributes)
  if (actionMessages.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '無法送出此預存動作' })
  }
  await pushMessage(lineUserId, actionMessages, workspaceId)
  await saveOutgoingConversationMessagesByWorkspace(lineUserId, actionMessages, workspaceId)
  onHumanOutgoingMessage(userIdOrDocId, workspaceId).catch(e => console.error('[supportPreset] onHumanOutgoing error:', e))
}

function buildRichMessageSnapshot(item: any) {
  const actions = Array.isArray(item?.actions)
    ? item.actions
    : Array.isArray(item?.buttons)
      ? item.buttons
      : []
  return {
    layoutId: item?.layoutId || 'custom',
    heroImageWidth: Number(item?.heroImageWidth) || undefined,
    heroImageHeight: Number(item?.heroImageHeight) || undefined,
    transparentBackground: Boolean(item?.transparentBackground),
    altText: item?.altText || '',
    heroImageUrl: item?.heroImageUrl || '',
    actions: actions.map((action: any, index: number) => ({
      slot: action?.slot || String.fromCharCode(65 + index),
      type: action?.type === 'message' || action?.type === 'module' ? action.type : 'uri',
      uri: action?.uri || '',
      text: action?.text || '',
      moduleId: action?.moduleId || '',
      tagging: {
        enabled: action?.tagging?.enabled === true,
        addTagIds: Array.isArray(action?.tagging?.addTagIds) ? action.tagging.addTagIds : [],
      },
      ...(action?.bounds && typeof action.bounds === 'object' ? { bounds: action.bounds } : {}),
    })),
  }
}

async function loadRichMessageSnapshot(id: string): Promise<any | null> {
  if (!id) return null
  const cacheKey = `richMessage:${id}`
  const cached = getCached(richMessageCache, cacheKey)
  if (cached !== undefined) return cached

  const db = getDb()
  const snap = await db.collection('richMessages').doc(id).get()
  if (!snap.exists) {
    setCache(richMessageCache, cacheKey, null)
    return null
  }
  const payload = buildRichMessageSnapshot(snap.data())
  setCache(richMessageCache, cacheKey, payload)
  return payload
}

async function hydrateRichMessageRefs(messages: any[]): Promise<any[]> {
  if (!Array.isArray(messages) || messages.length === 0) return []
  const hydrated = [...messages]
  const ids = Array.from(new Set(hydrated
    .filter((msg: any) => msg?.type === 'richMessageRef' && msg?.richMessageId)
    .map((msg: any) => String(msg.richMessageId))))
  if (ids.length === 0) return hydrated

  const snapshots = await Promise.all(ids.map((id) => loadRichMessageSnapshot(id)))
  const snapshotMap = new Map<string, any | null>()
  ids.forEach((id, index) => snapshotMap.set(id, snapshots[index] ?? null))

  return hydrated.map((msg: any) => {
    if (msg?.type !== 'richMessageRef') return msg
    const latest = msg?.richMessageId ? snapshotMap.get(String(msg.richMessageId)) : null
    if (latest) return { ...msg, payload: latest }
    return msg
  })
}

function resolveRichMessageLayoutId(raw: unknown): string {
  const id = typeof raw === 'string' && raw.trim() ? raw.trim() : 'single'
  return RICH_LAYOUT_PRESETS.some((p) => p.id === id) ? id : 'single'
}

function normalizePublicBase(raw: string): string {
  const cleaned = String(raw || '').trim().replace(/\/$/, '')
  if (!cleaned) return ''
  if (!/^https?:\/\//i.test(cleaned)) return ''
  return cleaned
}

function resolveLineImagemapPublicBase(fallbackOrigin = ''): string {
  try {
    const c = useRuntimeConfig()
    const configured = normalizePublicBase(String((c as { lineImagemapBaseUrl?: string }).lineImagemapBaseUrl || ''))
    if (configured) return configured
  }
  catch {
    /* useRuntimeConfig 在非 Nitro 內容下可能不可用 */
  }

  const envCandidates = [
    process.env.PUBLIC_BASE_URL,
    process.env.LINE_IMAGEMAP_BASE_URL,
    process.env.CLICK_TRACKING_BASE_URL,
    process.env.APP_BASE_URL,
    process.env.SITE_URL,
    process.env.DEPLOY_PRIME_URL,
    process.env.DEPLOY_URL,
    process.env.URL,
  ]
  for (const value of envCandidates) {
    const normalized = normalizePublicBase(String(value || ''))
    if (normalized) return normalized
  }

  return normalizePublicBase(fallbackOrigin)
}

function extractTagIdsFromAction(action: any): string[] {
  if (!action?.tagging?.enabled) return []
  if (!Array.isArray(action?.tagging?.addTagIds)) return []
  return action.tagging.addTagIds
    .map((item: unknown) => String(item || '').trim())
    .filter(Boolean)
}

function resolveUriWithTagging(input: {
  uri: string
  action: any
  userId: string
  publicBaseOverride?: string
  channelSecret: string
}): string {
  const original = String(input.uri || '').trim()
  if (!original) return original
  const tagIds = extractTagIdsFromAction(input.action)
  if (!tagIds.length) return original
  if (!input.userId) return original
  if (!/^https?:\/\//i.test(original)) return original

  const secret = String(input.channelSecret || '').trim()
  if (!secret) return original
  const publicBase = resolveLineImagemapPublicBase(input.publicBaseOverride || '')
  if (!publicBase) return original

  const token = createUriTagToken({
    targetUrl: original,
    userId: input.userId,
    tagIds,
  }, secret)
  return `${publicBase}/api/t/${encodeURIComponent(token)}`
}

function clampImagemapArea(
  bounds: { x: number; y: number; width: number; height: number },
  maxW: number,
  maxH: number,
) {
  const x = Math.max(0, Math.min(maxW, Math.floor(Number(bounds.x) || 0)))
  const y = Math.max(0, Math.min(maxH, Math.floor(Number(bounds.y) || 0)))
  const w = Math.max(1, Math.min(maxW - x, Math.floor(Number(bounds.width) || 0)))
  const h = Math.max(1, Math.min(maxH - y, Math.floor(Number(bounds.height) || 0)))
  return { x, y, width: w, height: h }
}

/**
 * 圖文訊息：預設 Flex（可 postback 觸發模組）。
 * 「保留 PNG 透明」且僅 uri/message 區塊時改送 Imagemap（全螢幕預覽也較能維持透明）；需設定 lineImagemapBaseUrl。
 * 若有「觸發模組」區塊則只能用 Flex，底圖需為 image 設透明底色才不易出現白底。
 */
function buildRichMessageLineMessage(input: {
  altText: string
  heroImageUrl: string
  layoutId: unknown
  heroImageWidth?: number
  heroImageHeight?: number
  actions: any[]
  attributes: Record<string, string>
  transparentBackground: boolean
  publicBaseOverride?: string
  userId: string
  channelSecret: string
}): messagingApi.Message {
  const layoutId = resolveRichMessageLayoutId(input.layoutId)
  const aspect = resolveRichMessageFromImageSize(input.heroImageWidth, input.heroImageHeight)
  const normalized = normalizeRichMessageActions(
    layoutId,
    input.actions,
    input.heroImageWidth,
    input.heroImageHeight,
  )
  const hasModule = normalized.some((a: any) => a?.type === 'module')
  const hasTaggedMessage = normalized.some((a: any) => a?.type === 'message' && extractTagIdsFromAction(a).length > 0)
  const publicBase = resolveLineImagemapPublicBase(input.publicBaseOverride || '')
  const channelSecret = String(input.channelSecret || '').trim()

  const tryImagemap =
    Boolean(input.transparentBackground)
    && !hasModule
    && Boolean(publicBase && channelSecret)
    && normalized.some((a: any) => a?.type)

  if (tryImagemap) {
    if (hasTaggedMessage) {
      console.warn('[richMessage] transparent mode uses imagemap, message tagging will be ignored in this delivery')
    }
    const renderedUrl = renderWithAttributes(input.heroImageUrl, input.attributes)
    const token = createImagemapImageToken(renderedUrl, channelSecret)
    const baseUrl = `${publicBase}/api/line-imagemap-img/${encodeURIComponent(token)}`
    if (baseUrl.length <= 1900) {
      const actions = normalized
        .filter((a: any) => a?.type === 'uri' || a?.type === 'message')
        .map((a: any) => {
          const b = a.bounds
          if (!b) return null
          const area = clampImagemapArea(b, aspect.canvasWidth, aspect.canvasHeight)
          if (a.type === 'uri') {
            return {
              type: 'uri',
              linkUri: resolveUriWithTagging({
                uri: renderWithAttributes(a.uri || 'https://google.com', input.attributes),
                action: a,
                userId: input.userId,
                publicBaseOverride: input.publicBaseOverride,
                channelSecret: input.channelSecret,
              }),
              area,
            }
          }
          return {
            type: 'message',
            text: renderWithAttributes(a.text || a.slot || ' ', input.attributes).slice(0, 300),
            area,
          }
        })
        .filter(Boolean)

      if (actions.length > 0) {
        return {
          type: 'imagemap',
          baseUrl,
          altText: renderWithAttributes(input.altText, input.attributes).slice(0, 400),
          baseSize: { width: aspect.canvasWidth, height: aspect.canvasHeight },
          actions,
        } as messagingApi.Message
      }
    }
  }

  return buildRichMessageFlexMessage({
    altText: input.altText,
    heroImageUrl: input.heroImageUrl,
    layoutId: input.layoutId,
    heroImageWidth: input.heroImageWidth,
    heroImageHeight: input.heroImageHeight,
    actions: input.actions,
    attributes: input.attributes,
    transparentBackground: input.transparentBackground,
    userId: input.userId,
    publicBaseOverride: input.publicBaseOverride,
    channelSecret: input.channelSecret,
  })
}

/** Flex footer 按鈕 action（與輪播 template 按鈕邏輯一致，需顯示 label） */
function buildFlexCarouselButtonAction(
  action: any,
  attributes: Record<string, string>,
  userId: string,
  publicBaseOverride: string,
  lineChannelSecret: string,
): Record<string, unknown> | null {
  const type = String(action?.type || '').trim()
  if (!type || type === 'none') return null
  if (type === 'uri') {
    return {
      type: 'uri',
      label: renderWithAttributes(action.label || '　', attributes).slice(0, 20),
      uri: resolveUriWithTagging({
        uri: renderWithAttributes(action.uri || 'https://google.com', attributes),
        action,
        userId,
        publicBaseOverride,
        channelSecret: lineChannelSecret,
      }),
    }
  }
  if (type === 'module') {
    return {
      type: 'postback',
      label: renderWithAttributes(action.label || '觸發模組', attributes).slice(0, 20),
      data: encodeTriggerModule(
        action.moduleId,
        action?.tagging?.enabled && Array.isArray(action?.tagging?.addTagIds)
          ? action.tagging.addTagIds
          : [],
      ),
    }
  }
  const renderedText = renderWithAttributes(action?.text || action?.label || '　', attributes).slice(0, 300)
  const tagIds = extractTagIdsFromAction(action)
  if (tagIds.length > 0) {
    return {
      type: 'postback',
      label: renderWithAttributes(action?.label || '　', attributes).slice(0, 20),
      data: encodeTriggerMessage(renderedText, tagIds),
      displayText: renderedText,
    }
  }
  return {
    type: 'message',
    label: renderWithAttributes(action?.label || '　', attributes).slice(0, 20),
    text: renderedText,
  }
}

function buildFlexImageCarouselBody(
  col: any,
  attributes: Record<string, string>,
): Record<string, unknown> | undefined {
  const title = renderWithAttributes(col?.title || '', attributes).trim().slice(0, 80)
  const text = renderWithAttributes(col?.text || '', attributes).trim().slice(0, 300)
  const contents: Record<string, unknown>[] = []
  if (title) {
    contents.push({
      type: 'text',
      text: title,
      weight: 'bold',
      size: 'md',
      wrap: true,
    })
  }
  if (text) {
    contents.push({
      type: 'text',
      text,
      size: 'sm',
      color: '#666666',
      wrap: true,
    })
  }
  if (!contents.length) return undefined
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    paddingAll: '12px',
    contents,
  }
}

function buildFlexImageCarouselFooter(
  actions: any[],
  attributes: Record<string, string>,
  userId: string,
  publicBaseOverride: string,
  lineChannelSecret: string,
): Record<string, unknown> | undefined {
  const buttons = (actions ?? [])
    .slice(0, 3)
    .map((action) => buildFlexCarouselButtonAction(action, attributes, userId, publicBaseOverride, lineChannelSecret))
    .filter(Boolean)
    .map((flexAction) => ({
      type: 'button',
      style: 'link',
      height: 'sm',
      action: flexAction,
    }))
  if (!buttons.length) return undefined
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: buttons,
  }
}

/** Flex：底圖 + 依編輯器座標疊透明點擊區（類似圖文選單），可保留 postback 觸發模組 */
function buildRichMessageFlexMessage(input: {
  altText: string
  heroImageUrl: string
  layoutId: unknown
  heroImageWidth?: number
  heroImageHeight?: number
  actions: any[]
  attributes: Record<string, string>
  transparentBackground?: boolean
  userId: string
  publicBaseOverride?: string
  channelSecret: string
}): messagingApi.FlexMessage {
  const layoutId = resolveRichMessageLayoutId(input.layoutId)
  const aspect = resolveRichMessageFromImageSize(input.heroImageWidth, input.heroImageHeight)
  const normalized = normalizeRichMessageActions(
    layoutId,
    input.actions,
    input.heroImageWidth,
    input.heroImageHeight,
  )
  const imageUrl = renderWithAttributes(input.heroImageUrl, input.attributes)
  const canvasW = aspect.canvasWidth
  const canvasH = aspect.canvasHeight
  const pctW = (px: number) => `${(px / canvasW) * 100}%`
  const pctH = (px: number) => `${(px / canvasH) * 100}%`
  const transparent = Boolean(input.transparentBackground)

  const overlayBoxes = normalized
    .filter((action: any) => action?.type)
    .map((action: any) => {
      const b = action.bounds
      if (!b) return null
      let flexAction: Record<string, unknown>
      if (action.type === 'uri') {
        flexAction = {
          type: 'uri',
          label: ' ',
          uri: resolveUriWithTagging({
            uri: renderWithAttributes(action.uri || 'https://google.com', input.attributes),
            action,
            userId: input.userId,
            publicBaseOverride: input.publicBaseOverride,
            channelSecret: input.channelSecret,
          }),
        }
      }
      else if (action.type === 'module') {
        flexAction = {
          type: 'postback',
          label: ' ',
          data: encodeTriggerModule(
            action.moduleId || '',
            action?.tagging?.enabled && Array.isArray(action?.tagging?.addTagIds)
              ? action.tagging.addTagIds
              : [],
          ),
        }
      }
      else {
        const renderedText = renderWithAttributes(action.text || action.slot || ' ', input.attributes).slice(0, 300)
        const tagIds = extractTagIdsFromAction(action)
        flexAction = tagIds.length > 0
          ? {
              type: 'postback',
              label: ' ',
              data: encodeTriggerMessage(renderedText, tagIds),
              displayText: renderedText,
            }
          : {
              type: 'message',
              label: ' ',
              text: renderedText,
            }
      }
      return {
        type: 'box',
        layout: 'vertical',
        position: 'absolute',
        offsetTop: pctH(b.y),
        offsetStart: pctW(b.x),
        width: pctW(b.width),
        height: pctH(b.height),
        action: flexAction,
        ...(transparent ? { backgroundColor: '#00000000' } : {}),
        contents: [{ type: 'filler', flex: 1 }],
      }
    })
    .filter(Boolean)

  const bodyBox: Record<string, unknown> = {
    type: 'box',
    layout: 'vertical',
    position: 'relative',
    paddingAll: '0px',
    ...(transparent ? { backgroundColor: '#00000000' } : {}),
    contents: [
      {
        type: 'image',
        url: imageUrl,
        size: 'full',
        aspectRatio: aspect.lineAspectRatio,
        aspectMode: 'fit',
        gravity: 'center',
        // Flex 圖片預設會在 PNG 透明處疊白底；設為全透明才會透出聊天室背景（與 Imagemap 行為較接近）
        ...(transparent ? { backgroundColor: '#00000000' } : {}),
      },
      ...overlayBoxes,
    ],
  }

  return {
    type: 'flex',
    altText: renderWithAttributes(input.altText, input.attributes).slice(0, 400),
    contents: {
      type: 'bubble',
      ...(transparent
        ? {
            styles: {
              body: { backgroundColor: '#00000000' },
            },
          }
        : {}),
      body: bodyBox,
    },
  } as messagingApi.FlexMessage
}

// ── Main Event Handlers ───────────────────────────────────────────

function buildLineMessages(
  dbMessages: any[],
  attributes: Record<string, string> = {},
  publicBaseOverride = '',
  userId = '',
  lineChannelSecret: string,
): messagingApi.Message[] {
  if (!dbMessages) return []
  return dbMessages.flatMap((msg) => {
    // ── Text with buttons → Buttons Template ──
    if (msg.type === 'text' && msg.buttons && msg.buttons.length > 0) {
      const renderedText = renderWithAttributes(msg.text || '', attributes)
      return [{
        type: 'template',
        altText: renderedText.slice(0, 400),
        template: {
          type: 'buttons',
          text: (renderedText || '無內容').slice(0, 160),
          actions: msg.buttons.slice(0, 4).map((b: any) => {
            if (b.type === 'uri') {
              return {
                type: 'uri',
                label: renderWithAttributes(b.label || '開啟連結', attributes).slice(0, 20),
                uri: resolveUriWithTagging({
                  uri: renderWithAttributes(b.uri || 'https://google.com', attributes),
                  action: b,
                  userId,
                  publicBaseOverride,
                  channelSecret: lineChannelSecret,
                }),
              }
            }
            if (b.type === 'module') {
              return {
                type: 'postback',
                label: renderWithAttributes(b.label || '觸發模組', attributes).slice(0, 20),
                data: encodeTriggerModule(
                  b.moduleId,
                  b?.tagging?.enabled && Array.isArray(b?.tagging?.addTagIds)
                    ? b.tagging.addTagIds
                    : [],
                )
              }
            }
            const renderedText = renderWithAttributes(b.text || b.label || '點擊傳送', attributes).slice(0, 300)
            const tagIds = extractTagIdsFromAction(b)
            if (tagIds.length > 0) {
              return {
                type: 'postback',
                label: renderWithAttributes(b.label || '點擊傳送', attributes).slice(0, 20),
                data: encodeTriggerMessage(renderedText, tagIds),
                displayText: renderedText,
              }
            }
            return {
              type: 'message',
              label: renderWithAttributes(b.label || '點擊傳送', attributes).slice(0, 20),
              text: renderedText,
            }
          }),
        },
      } as messagingApi.TemplateMessage]
    }

    // ── Video ──
    if (msg.type === 'video') {
      if (!msg.originalContentUrl || !msg.previewImageUrl) return []
      return [{
        type: 'video',
        originalContentUrl: msg.originalContentUrl,
        previewImageUrl: msg.previewImageUrl,
      } as messagingApi.VideoMessage]
    }

    // ── Carousel ──
    if (msg.type === 'carousel') {
      const normalizeCarouselAction = (action: any) => {
        if (action?.type === 'uri') {
          return {
            type: 'uri',
            label: renderWithAttributes(action.label || '　', attributes).slice(0, 20),
            uri: resolveUriWithTagging({
              uri: renderWithAttributes(action.uri || 'https://google.com', attributes),
              action,
              userId,
              publicBaseOverride,
              channelSecret: lineChannelSecret,
            }),
          }
        }
        if (action?.type === 'module') {
          return {
            type: 'postback',
            label: renderWithAttributes(action.label || '觸發模組', attributes).slice(0, 20),
            data: encodeTriggerModule(
              action.moduleId,
              action?.tagging?.enabled && Array.isArray(action?.tagging?.addTagIds)
                ? action.tagging.addTagIds
                : [],
            )
          }
        }
        const renderedText = renderWithAttributes(action?.text || action?.label || '　', attributes).slice(0, 300)
        const tagIds = extractTagIdsFromAction(action)
        if (tagIds.length > 0) {
          return {
            type: 'postback',
            label: renderWithAttributes(action?.label || '　', attributes).slice(0, 20),
            data: encodeTriggerMessage(renderedText, tagIds),
            displayText: renderedText,
          }
        }
        return {
          type: 'message',
          label: renderWithAttributes(action?.label || '　', attributes).slice(0, 20),
          text: renderedText,
        }
      }

      const rawColumns = (msg.columns ?? []).map((col: any) => ({
        thumbnailImageUrl: col.thumbnailImageUrl || undefined,
        title: renderWithAttributes(col.title || '', attributes).slice(0, 80) || undefined,
        text: renderWithAttributes(col.text || '　', attributes).slice(0, 300),
        actions: (col.actions ?? []).slice(0, 3).map(normalizeCarouselAction),
      }))

      // LINE carousel requires every column to have the same action count (1~3).
      const targetActionCount = Math.max(1, ...rawColumns.map((col: any) => col.actions.length))
      const columns = rawColumns.map((col: any) => {
        const actions = [...col.actions]
        while (actions.length < targetActionCount) {
          actions.push({ type: 'message', label: '　', text: '　' })
        }
        return { ...col, actions }
      })
      if (!columns.length) return []
      const carouselAspect = String(msg.imageAspectRatio || '').trim() === 'square' ? 'square' : 'rectangle'
      return [{
        type: 'template',
        altText: renderWithAttributes(msg.altText || '輪播訊息', attributes).slice(0, 400),
        template: {
          type: 'carousel',
          columns,
          imageAspectRatio: carouselAspect,
          imageSize: 'cover',
        },
      } as messagingApi.TemplateMessage]
    }

    // ── Image Carousel ──
    if (msg.type === 'imageCarousel') {
      const columns = (msg.columns ?? [])
        .filter((col: any) => col.imageUrl)
        .map((col: any) => {
          const actionType = col.action?.type
          let action: any
          if (actionType === 'uri') {
            action = {
              type: 'uri',
              label: renderWithAttributes(col.action.label || '開啟', attributes).slice(0, 20),
              uri: resolveUriWithTagging({
                uri: renderWithAttributes(col.action.uri || 'https://google.com', attributes),
                action: col.action,
                userId,
                publicBaseOverride,
                channelSecret: lineChannelSecret,
              }),
            }
          } else if (actionType === 'module') {
            action = {
              type: 'postback',
              label: renderWithAttributes(col.action.label || '觸發模組', attributes).slice(0, 20),
              data: encodeTriggerModule(
                col.action.moduleId,
                col.action?.tagging?.enabled && Array.isArray(col.action?.tagging?.addTagIds)
                  ? col.action.tagging.addTagIds
                  : [],
              )
            }
          } else if (actionType === 'message') {
            const renderedText = renderWithAttributes(col.action.text || '', attributes).slice(0, 300)
            const tagIds = extractTagIdsFromAction(col.action)
            action = tagIds.length > 0
              ? {
                  type: 'postback',
                  label: renderWithAttributes(col.action.label || '傳送', attributes).slice(0, 20),
                  data: encodeTriggerMessage(renderedText, tagIds),
                  displayText: renderedText,
                }
              : {
                  type: 'message',
                  label: renderWithAttributes(col.action.label || '傳送', attributes).slice(0, 20),
                  text: renderedText,
                }
          } else {
            // LINE API requires an action for image_carousel. If 'none', use a silent postback without label.
            action = { type: 'postback', data: 'ignore' }
          }
          return { imageUrl: col.imageUrl, action }
        })
      if (!columns.length) return []
      return [{
        type: 'template',
        altText: renderWithAttributes(msg.altText || '圖片輪播', attributes).slice(0, 400),
        template: { type: 'image_carousel', columns },
      } as messagingApi.TemplateMessage]
    }

    // ── Flex Image Carousel（自訂比例，整圖可點擊）──
    if (msg.type === 'flexImageCarousel') {
      const enableImage = msg.enableImage !== false
      const aspect = resolveFlexImageCarouselAspectRatio(msg.imageAspectRatio)
      const bubbles = (msg.columns ?? [])
        .map((col: any) => {
          const imageUrl = String(col?.imageUrl || '').trim()
          const actionType = col.action?.type
          let heroAction: Record<string, unknown> | undefined
          if (enableImage && actionType === 'uri') {
            heroAction = {
              type: 'uri',
              label: ' ',
              uri: resolveUriWithTagging({
                uri: renderWithAttributes(col.action.uri || 'https://google.com', attributes),
                action: col.action,
                userId,
                publicBaseOverride,
                channelSecret: lineChannelSecret,
              }),
            }
          } else if (enableImage && actionType === 'module') {
            heroAction = {
              type: 'postback',
              label: ' ',
              data: encodeTriggerModule(
                col.action.moduleId || '',
                col.action?.tagging?.enabled && Array.isArray(col.action?.tagging?.addTagIds)
                  ? col.action.tagging.addTagIds
                  : [],
              ),
            }
          } else if (enableImage && actionType === 'message') {
            const renderedText = renderWithAttributes(col.action.text || '', attributes).slice(0, 300)
            const tagIds = extractTagIdsFromAction(col.action)
            heroAction = tagIds.length > 0
              ? {
                  type: 'postback',
                  label: ' ',
                  data: encodeTriggerMessage(renderedText, tagIds),
                  displayText: renderedText,
                }
              : {
                  type: 'message',
                  label: ' ',
                  text: renderedText,
                }
          }
          const bubble: Record<string, unknown> = { type: 'bubble', size: 'mega' }
          if (enableImage && imageUrl) {
            const hero: Record<string, unknown> = {
              type: 'image',
              url: renderWithAttributes(col.imageUrl, attributes),
              size: 'full',
              aspectRatio: aspect.lineAspectRatio,
              aspectMode: 'cover',
            }
            if (heroAction) hero.action = heroAction
            bubble.hero = hero
          }
          const body = buildFlexImageCarouselBody(col, attributes)
          if (body) bubble.body = body
          const footer = buildFlexImageCarouselFooter(
            col.actions,
            attributes,
            userId,
            publicBaseOverride,
            lineChannelSecret,
          )
          if (footer) bubble.footer = footer
          if (!bubble.hero && !bubble.body && !bubble.footer) return null
          return bubble
        })
        .filter(Boolean)
      if (!bubbles.length) return []
      return [{
        type: 'flex',
        altText: renderWithAttributes(msg.altText || '輪播訊息', attributes).slice(0, 400),
        contents: { type: 'carousel', contents: bubbles },
      } as messagingApi.FlexMessage]
    }

    // ── Rich Message Inline（底圖 + 疊在圖上的點擊區，類似圖文選單）──
    if (msg.type === 'richMessage') {
      if (!msg.altText) return []
      if (!msg.heroImageUrl) return []
      const actions = Array.isArray(msg.actions) ? msg.actions : []
      return [
        buildRichMessageLineMessage({
          altText: msg.altText,
          heroImageUrl: msg.heroImageUrl,
          layoutId: msg.layoutId,
          heroImageWidth: Number(msg.heroImageWidth) || undefined,
          heroImageHeight: Number(msg.heroImageHeight) || undefined,
          actions,
          attributes,
          transparentBackground: Boolean(msg.transparentBackground),
          publicBaseOverride,
          userId,
          channelSecret: lineChannelSecret,
        }),
      ]
    }

    // ── Rich Message Reference（同上）──
    if (msg.type === 'richMessageRef') {
      const payload = msg.payload
      if (!payload?.altText) return []
      if (!payload?.heroImageUrl) return []
      const actions = Array.isArray(payload?.actions)
        ? payload.actions
        : Array.isArray(payload?.buttons)
          ? payload.buttons.map((btn: any, index: number) => ({
              slot: String.fromCharCode(65 + index),
              type: btn?.type === 'message' || btn?.type === 'module' ? btn.type : 'uri',
              uri: btn?.uri || '',
              text: btn?.text || '',
              moduleId: btn?.moduleId || '',
              tagging: {
                enabled: btn?.tagging?.enabled === true,
                addTagIds: Array.isArray(btn?.tagging?.addTagIds) ? btn.tagging.addTagIds : [],
              },
            }))
          : []
      return [
        buildRichMessageLineMessage({
          altText: payload.altText,
          heroImageUrl: payload.heroImageUrl,
          layoutId: payload.layoutId,
          heroImageWidth: Number(payload.heroImageWidth) || undefined,
          heroImageHeight: Number(payload.heroImageHeight) || undefined,
          actions,
          attributes,
          transparentBackground: Boolean(payload.transparentBackground),
          publicBaseOverride,
          userId,
          channelSecret: lineChannelSecret,
        }),
      ]
    }

    // ── Quick Reply ──
    if (msg.type === 'quickReply') {
      const items = (msg.quickReplies || []).slice(0, 13).map((qr: any) => {
        let action: any
        const actionType = qr.action?.type
        if (actionType === 'uri') {
          action = {
            type: 'uri',
            label: renderWithAttributes(qr.action.label || '開啟', attributes).slice(0, 20),
            uri: resolveUriWithTagging({
              uri: renderWithAttributes(qr.action.uri || 'https://google.com', attributes),
              action: qr.action,
              userId,
              publicBaseOverride,
              channelSecret: lineChannelSecret,
            })
          }
        } else if (actionType === 'module') {
          action = {
            type: 'postback',
            label: renderWithAttributes(qr.action.label || '觸發模組', attributes).slice(0, 20),
            data: encodeTriggerModule(
              qr.action.moduleId,
              qr.action?.tagging?.enabled && Array.isArray(qr.action?.tagging?.addTagIds)
                ? qr.action.tagging.addTagIds
                : [],
            )
          }
        } else {
          const renderedText = renderWithAttributes(qr.action.text || qr.action.label || '傳送', attributes).slice(0, 300)
          const tagIds = extractTagIdsFromAction(qr.action)
          action = tagIds.length > 0
            ? {
                type: 'postback',
                label: renderWithAttributes(qr.action.label || '傳送', attributes).slice(0, 20),
                data: encodeTriggerMessage(renderedText, tagIds),
                displayText: renderedText,
              }
            : {
                type: 'message',
                label: renderWithAttributes(qr.action.label || '傳送', attributes).slice(0, 20),
                text: renderedText,
              }
        }
        
        return {
          type: 'action',
          imageUrl: qr.imageUrl || undefined,
          action
        }
      })
      
      return [{
        type: 'text',
        text: renderWithAttributes(msg.text || '快速回覆', attributes).slice(0, 5000),
        quickReply: items.length > 0 ? { items } : undefined
      } as messagingApi.TextMessage]
    }

    // ── User Input ──
    if (msg.type === 'userInput') {
      return [{
        type: 'text',
        text: renderWithAttributes(msg.text || '請輸入內容：', attributes).slice(0, 5000)
      } as messagingApi.TextMessage]
    }

    if (msg.type === 'text') {
      return [{
        ...msg,
        text: renderWithAttributes(msg.text || '', attributes).slice(0, 5000)
      } as messagingApi.TextMessage]
    }

    // ── Default: plain text / image ──
    const { buttons, ...cleanMsg } = msg
    return [cleanMsg as messagingApi.Message]
  })
}

export async function renderModuleToLineMessages(
  moduleId: string,
  options: {
    workspaceId: string
    requestOrigin?: string
    userId?: string
    attributes?: Record<string, string>
  },
): Promise<{ flow: FlowDoc; lineMessages: messagingApi.Message[] } | null> {
  const wid = requireWorkspaceId(options.workspaceId, 'renderModuleToLineMessages')
  const flow = await getFlowByModuleId(moduleId)
  if (!flow) return null
  const { channelSecret } = await getLineWorkspaceCredentials(wid)
  const hydratedMessages = await hydrateRichMessageRefs(flow.messages as any[])
  const lineMessages = buildLineMessages(
    hydratedMessages,
    options.attributes ?? {},
    options.requestOrigin || '',
    options.userId || '',
    channelSecret,
  )
  return { flow, lineMessages }
}


export async function handleMessageEvent(
  event: webhook.MessageEvent,
  options: { requestOrigin?: string; workspaceId: string; dedupClaim?: Promise<boolean> },
): Promise<void> {
  const userId = event.source?.userId
  if (!userId) return
  const workspaceId = String(options.workspaceId || '').trim()
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'workspaceId is required in handleMessageEvent' })

  const lineEventTimestampMs = typeof event.timestamp === 'number' ? event.timestamp : undefined
  const dedupClaim = options.dedupClaim ?? Promise.resolve(true)

  if (event.message.type === 'text') {
    const textContent = (event.message as webhook.TextMessageContent).text

    // Run session, user data, cache warm-ups, and the dedup claim all in parallel.
    // The claim (a Firestore write) is awaited before any side effect below; the
    // preloads are reads / idempotent so running them on a redelivery is harmless.
    // preloadedUser is passed to handleIncomingText so it skips the ensureUser call inside.
    const [sessionId, preloadedUser, , , isFirstDelivery] = await Promise.all([
      // inboundAtMs：開新會話時用「客人這句話的時間」當開始時間，否則時間軸會切掉這第一句
      ensureConversationSession(userId, workspaceId, { inboundAtMs: lineEventTimestampMs }).catch((e) => {
        console.error('[session] ensureConversationSession error:', e)
        return null
      }),
      ensureUser(userId, undefined, workspaceId).catch(() => null),
      loadActiveAutoReplyRules(workspaceId).catch(() => []),  // warm cache; result discarded
      getAiSettings(workspaceId).catch(() => null),           // warm cache; result discarded
      dedupClaim,
    ])
    if (!isFirstDelivery) {
      console.log('[webhook] duplicate message event skipped')
      return
    }

    saveConversationMessage(userId, 'incoming', textContent, {
      messageType: 'text',
      payload: { type: 'text', text: textContent },
      lineEventTimestampMs,
    }, workspaceId).catch(e => console.error('[conv] save error:', e))

    // 客服人員把後台產的綁定碼傳進來 → 記到該成員身上就結束,不進自動回覆／AI。
    // 不像綁定碼時只花一次 regex,熱路徑零額外讀取。
    const consumedBindCode = await tryConsumeMemberLineBindCode({
      lineUserId: lineUserIdFromFirestoreDocId(userId, workspaceId),
      text: textContent,
      workspaceId,
      replyToken: event.replyToken,
    }).catch((e) => {
      console.error('[member-bind] error:', e)
      return false
    })
    if (consumedBindCode) {
      // 綁定訊息（成功或失敗）都已由系統回覆完畢，沒有客服要做的事——蓋 system_notice
      // 把會話移出「待處理」。只動 status、不動 initialHandler，口徑同 markClaimPushHandled：
      // 綁定的是自家成員不是客人提問，記成機器人首接會灌水統計。
      await enterModule(sessionId, userId, 'system_notice', undefined, workspaceId).catch(e =>
        console.error('[member-bind] enterModule error:', e),
      )
      return
    }

    await handleIncomingText(userId, textContent, event.replyToken, options, preloadedUser, sessionId, workspaceId)
  } else {
    if (!(await dedupClaim)) {
      console.log('[webhook] duplicate message event skipped')
      return
    }
    const typeLabel = NON_TEXT_QUERY_LABELS[event.message.type]
      ?? (event.message.type === 'sticker' ? '[貼圖]' : `[${event.message.type}]`)
    // 不 await：存訊息與下面的 ack／存檔沒有先後關係。但要留著 promise——
    // 圖片的 AI 描述得補寫回這一則，需要它的 doc id。
    const savedMessageId = saveConversationMessage(userId, 'incoming', typeLabel, {
      messageType: event.message.type,
      payload: event.message,
      lineEventTimestampMs,
    }, workspaceId).catch((e) => {
      console.error('[conv] save error:', e)
      return ''
    })
    const sessionId = await ensureConversationSession(userId, workspaceId, { inboundAtMs: lineEventTimestampMs }).catch((e) => {
      console.error('[session] error:', e)
      return null
    })
    ensureUser(userId, undefined, workspaceId).catch(e => console.error('[ensureUser] Error:', e))

    // 看圖作答：開了這個開關，圖片就不再只是回一句「我看不懂」，而是讀圖 → 推出客人想問什麼
    // → 走一般答題流程回覆。此時**引導語不能先發**：一則進來的訊息只有一個 replyToken，
    // 被引導語用掉之後答案就只能改用推播（另外計費、且會變成兩則訊息）。
    // 真人接手中（suppress）一律不啟動：機器人插話比不回更糟。
    const imageAnswerOn = event.message.type === 'image'
      && await getAiSettings(workspaceId).then(s => s?.enabled === true && s.imageAnswer?.enabled === true).catch(() => false)
    const willAnswerImage = imageAnswerOn
      && !(await shouldSuppressInboundBotAutomationForSession(sessionId).catch(() => false))

    // 有內容的非文字訊息(圖/影/音/檔):AI 讀不懂,完全沉默會像被已讀不回 → 回一句引導。
    // 貼圖刻意不回(多半是裝飾/情緒,回「我看不懂」反而突兀)。
    if (NON_TEXT_INBOUND_TYPES.has(event.message.type) && event.replyToken && !willAnswerImage) {
      maybeAckNonTextMessage(sessionId, userId, event.replyToken, workspaceId)
        .catch(e => console.error('[non-text-ack] error:', e))
    }

    // 圖片：webhook 只給 messageId，原始檔要另外抓，而且 LINE 只暫存一段時間——
    // 沒有在當下存檔，客服晚幾天才回頭看就永遠看不到那張圖了。所以收訊即存檔。
    // 這裡刻意 await（Lambda 回應後容器就凍結，沒 await 的下載會被砍掉）。
    // 影片／語音／檔案體積大，改在後台真的要看時才抓（見 resolveConversationMediaUrl）。
    if (event.message.type === 'image') {
      // 要作答就會沉默好幾秒（讀圖 + 查知識庫），先讓客人看到「輸入中…」才不像已讀不回
      if (willAnswerImage) showLoadingAnimation(userId, workspaceId, 20).catch(() => {})

      const lineMessageId = String((event.message as { id?: string }).id || '')
      const archived = await archiveConversationMedia({ workspaceId, lineMessageId, messageType: 'image' })
        .catch((e) => {
          console.error('[conv-media] archive error:', e)
          return null
        })
      if (archived && !archived.ok) {
        console.warn('[conv-media] image not archived:', lineMessageId, archived.state, archived.detail || '')
      }

      // 存檔完就讓 AI 看一眼：描述一律寫給客服看；問句只有開了看圖作答才會有。
      // 同樣 await：Lambda 回應後容器會凍結，沒 await 的後續工作會被砍掉。
      let question = ''
      if (archived?.ok) {
        question = await describeAndAttachImage({
          workspaceId,
          userIdOrDocId: userId,
          messageIdPromise: savedMessageId,
          storagePath: archived.path,
          contentType: archived.contentType,
        }).catch((e) => {
          console.error('[media-describe] attach error:', e)
          return ''
        })
      }

      if (willAnswerImage && event.replyToken) {
        if (question) {
          await answerImageQuestion({
            workspaceId,
            lineUserId: userId,
            question,
            replyToken: event.replyToken,
            sessionId,
            requestOrigin: options.requestOrigin || '',
          })
        }
        else {
          // 讀不出客人想問什麼（自拍、風景、模糊照，或讀圖整個失敗）→ 退回原本的引導語。
          // replyToken 還沒被用掉,所以這裡仍發得出去——這正是前面不搶先發引導語的原因。
          await maybeAckNonTextMessage(sessionId, userId, event.replyToken, workspaceId)
            .catch(e => console.error('[non-text-ack] error:', e))
        }
      }
    }
  }
}

/**
 * 把「客人傳的圖」翻譯出來的問句，丟進一般答題流程回覆客人。
 *
 * 刻意重用 tryAiFallback 而不是自己組一套：用量記帳、額度、敏感詞、信心門檻、
 * 答不出來就轉真人、草稿模式不對客人說話——這些全都在那支裡面。自己寫一條平行路徑，
 * 遲早會漏掉其中一項（例如圖片問答不算額度、或草稿模式偷偷回覆客人）。
 */
async function answerImageQuestion(params: {
  workspaceId: string
  lineUserId: string
  question: string
  replyToken: string
  sessionId: string | null
  requestOrigin: string
}): Promise<void> {
  const { workspaceId, lineUserId, question, replyToken, sessionId, requestOrigin } = params
  try {
    const [userData, { channelSecret }] = await Promise.all([
      ensureUser(lineUserId, undefined, workspaceId).catch(() => null),
      getLineWorkspaceCredentials(workspaceId),
    ])
    await tryAiFallback({
      workspaceId,
      lineUserId,
      textContent: question,
      replyToken,
      userAttributes: buildAttributeContext(userData),
      channelSecret,
      sessionId,
      requestOrigin,
    })
  }
  catch (e) {
    console.error('[image-answer] failed:', e)
  }
}

/**
 * 讓 AI 看一眼客人剛傳的圖，把那句描述寫回兩個地方：
 *   1. 訊息本身（`mediaDescription`）→ 對話裡圖片下方的說明，客服掃一眼就知道是什麼
 *   2. 對話文件（`lastNonTextInboundSummary`）→ 客人接著喊「找真人」時，
 *      轉真人案例的原句就不只是「[圖片]」，而是「[圖片] 破掉的杯子」
 *
 * 回傳「客人可能想問的問句」給呼叫端拿去作答（沒開看圖作答時一律是空字串）。
 *
 * 描述失敗（Gemini 掛了 / 逾時 / AI 未啟用）一律安靜跳過：圖片本身已經存好也顯示得出來，
 * 少一句說明不該讓客服看不到圖。
 */
async function describeAndAttachImage(params: {
  workspaceId: string
  userIdOrDocId: string
  messageIdPromise: Promise<string>
  storagePath: string
  contentType: string
}): Promise<string> {
  const { workspaceId, userIdOrDocId, storagePath, contentType } = params
  const { description, question } = await readInboundImage({ workspaceId, storagePath, contentType })
  if (!description) return question

  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(userIdOrDocId, workspaceId)
  const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)
  // 這個 await 順序是必要的:存訊息時會把 lastNonTextInboundSummary 清空(防張冠李戴),
  // 等它落地再寫描述,才不會被那個清空動作蓋掉。
  const messageId = await params.messageIdPromise

  await Promise.all([
    messageId
      ? db.collection('conversations').doc(convDocId).collection('messages').doc(messageId)
          .set({ mediaDescription: description }, { merge: true })
      : Promise.resolve(),
    db.collection('conversations').doc(convDocId)
      .set({ lastNonTextInboundSummary: description }, { merge: true }),
  ])
  return question
}

export async function saveConversationMessage(
  userIdOrDocId: string,
  direction: 'incoming' | 'outgoing',
  text: string,
  options?: {
    messageType?: string
    payload?: unknown
    /** LINE webhook `event.timestamp`（毫秒），用於來訊時間與「對方曾互動」推定 */
    lineEventTimestampMs?: number
    /**
     * 這則 outgoing 是 AI 生成的（答題 / 反問澄清）。訊息流過去沒有任何 AI 標記，
     * 「AI 當時到底回了什麼」「真人後來怎麼改口」都無法回溯——從現在開始標，
     * 讓之後的答錯分析 / 從真人回覆學習有資料可用。
     */
    aiGenerated?: boolean
  },
  workspaceId?: string,
): Promise<string> {
  const wid = requireWorkspaceId(workspaceId, 'saveConversationMessage')
  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(userIdOrDocId, wid)
  const convDocId = lineUserFirestoreDocId(lineUserId, wid)
  const now = FieldValue.serverTimestamp()
  const useLineTs = direction === 'incoming'
    && options?.lineEventTimestampMs != null
    && Number.isFinite(Number(options.lineEventTimestampMs))
  const messageTimestamp = useLineTs
    ? Timestamp.fromMillis(Number(options!.lineEventTimestampMs))
    : now
  const msgRef = db.collection('conversations').doc(convDocId).collection('messages').doc()
  const payload = sanitizeForFirestore(options?.payload)

  const convPatch: Record<string, unknown> = {
    workspaceId: wid,
    userId: lineUserId,
    lastMessage: text,
    lastDirection: direction,
    lastMessageAt: now,
  }
  if (direction === 'incoming') {
    convPatch.lastPeerActivityAt = useLineTs
      ? Timestamp.fromMillis(Number(options!.lineEventTimestampMs))
      : now
    // 客人傳了 AI 看不懂的內容(圖/影/音/檔)就蓋一個時間戳。之後那句「找真人」才有辦法
    // 回溯真正的起因——引導語叫客人打「找真人」,轉接當下若只看那三個字,監控頁會把
    // 「傳圖被擋住」和「客人自己想找真人」記成同一種,兩者的處理方式完全不同。
    // 蓋在這裡而不是引導語那邊:節流/真人接手時引導語不會發,但起因仍然是那張圖。
    if (NON_TEXT_INBOUND_TYPES.has(String(options?.messageType || ''))) {
      convPatch.lastNonTextInboundAt = messageTimestamp
      convPatch.lastNonTextInboundType = options!.messageType
      // 描述是收訊之後才補寫的（見 describeAndAttachImage）。這裡先清空，
      // 否則這張圖描述失敗時會沿用上一張圖的說明，變成張冠李戴。
      convPatch.lastNonTextInboundSummary = ''
    }
  }

  await Promise.all([
    msgRef.set({
      direction,
      text,
      timestamp: messageTimestamp,
      messageType: options?.messageType || 'text',
      ...(options?.aiGenerated ? { aiGenerated: true } : {}),
      ...(payload !== undefined ? { payload } : {}),
    }),
    db.collection('conversations').doc(convDocId).set(convPatch, { merge: true }),
  ])
  // 回傳訊息 doc id：收訊後才生得出來的東西（例如圖片的 AI 描述）要補寫回這一則，
  // 沒有 id 就只能反查，而 payload.id 沒有索引。呼叫端不需要時忽略即可。
  return msgRef.id
}

async function saveOutgoingConversationMessagesByWorkspace(
  userId: string,
  messages: messagingApi.Message[],
  workspaceId: string,
  opts?: { aiGenerated?: boolean },
): Promise<void> {
  if (!Array.isArray(messages) || messages.length === 0) return
  await Promise.all(
    messages.map((msg) => {
      const text = toConversationText(msg)
      if (!text) return Promise.resolve()
      return saveConversationMessage(userId, 'outgoing', text, {
        messageType: String((msg as any)?.type || 'message'),
        payload: msg,
        aiGenerated: opts?.aiGenerated === true,
      }, workspaceId)
    }),
  )
}

/** 使用者 postback 等互動（無寫入一則 incoming 訊息時）仍更新對話上的「對方最後活動」時間，供推定已讀。 */
export async function bumpConversationPeerActivity(
  userIdOrDocId: string,
  lineEventTimestampMs?: number,
  workspaceId?: string,
): Promise<void> {
  const wid = requireWorkspaceId(workspaceId, 'bumpConversationPeerActivity')
  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(userIdOrDocId, wid)
  const convDocId = lineUserFirestoreDocId(lineUserId, wid)
  const at = lineEventTimestampMs != null && Number.isFinite(Number(lineEventTimestampMs))
    ? Timestamp.fromMillis(Number(lineEventTimestampMs))
    : FieldValue.serverTimestamp()
  await db.collection('conversations').doc(convDocId).set(
    {
      workspaceId: wid,
      userId: lineUserId,
      lastPeerActivityAt: at,
    },
    { merge: true },
  )
}

async function handleIncomingText(
  userId: string,
  textContent: string,
  replyToken: string | undefined,
  options: { requestOrigin?: string; allowAnyText?: boolean; workspaceId?: string } = {},
  userDataOverride?: UserDoc | null,
  sessionId?: string | null,
  workspaceId?: string,
): Promise<void> {
  const wid = requireWorkspaceId(workspaceId, 'handleIncomingText')
  const lineUserId = lineUserIdFromFirestoreDocId(userId, wid)
  const fsUserDocId = lineUserFirestoreDocId(lineUserId, wid)
  // Run all independent fetches concurrently; loadActiveAutoReplyRules warms cache
  // so the subsequent matchAutoReplyRule call is a near-instant cache hit
  const [userData, { channelSecret }, suppressBotAutomation] = await Promise.all([
    userDataOverride != null ? Promise.resolve(userDataOverride) : ensureUser(userId, undefined, wid),
    getLineWorkspaceCredentials(wid),
    sessionId ? shouldSuppressInboundBotAutomationForSession(sessionId) : Promise.resolve(false),
    loadActiveAutoReplyRules(wid).catch(() => []),
  ])
  const userAttributes = buildAttributeContext(userData)
  let handledByInput = false

  // 直接從已取得的 userData 提取冷卻狀態與 activeInput / activeScript，省去重複的 Firestore read
  const userState = !suppressBotAutomation && userData
    ? {
        ruleCooldowns: normalizeAutoReplyCooldownsMap(
          userData.autoReplyCooldowns as Record<string, unknown> | undefined,
        ),
        moduleCooldowns: normalizeAutoReplyModuleCooldownsMap(
          userData.autoReplyModuleCooldowns as Record<string, unknown> | undefined,
        ),
        activeInput: userData.activeInput ?? null,
        activeScript: userData.activeScript ?? null,
      }
    : { ruleCooldowns: {}, moduleCooldowns: {}, activeInput: null, activeScript: null }

  const activeInput = userState.activeInput

  if (activeInput && activeInput.expiresAt > Date.now()) {
    const { moduleId, attribute, tagIds } = activeInput

    if (isAutoReplyModuleOnCooldown(moduleId, userState.moduleCooldowns)) {
      await getDb().collection('users').doc(fsUserDocId).update({ activeInput: FieldValue.delete() })
      invalidateUserDocCache(fsUserDocId)
      handledByInput = true
    } else {
    const db = getDb()
    const updates: any = { activeInput: FieldValue.delete() }
    if (attribute) {
      updates[`attributes.${attribute}`] = textContent
      userAttributes[attribute] = textContent
    }
    // Run user write and flow fetch in parallel; both are independent
    const [, flow] = await Promise.all([
      db.collection('users').doc(fsUserDocId).update(updates),
      getFlowByModuleId(moduleId),
    ])
    invalidateUserDocCache(fsUserDocId)

    // Tags are non-blocking — flow/reply doesn't depend on tagging result
    if (Array.isArray(tagIds) && tagIds.length > 0) {
      addTagsToUser(fsUserDocId, tagIds, 'system', `userInput:${moduleId}`, wid)
        .catch(e => console.error('[tagging] userInput tagging failed:', e))
    }

    if (flow) {
      // Flow found: mark handled so auto-reply doesn't intercept the user's answer
      handledByInput = true
      if (replyToken) {
        const hydratedMessages = await hydrateRichMessageRefs(flow.messages as any[])
        const lineMessages = buildLineMessages(
          hydratedMessages,
          userAttributes,
          options.requestOrigin || '',
          lineUserId,
          channelSecret,
        )
        if (lineMessages.length > 0) {
          await replyMessage(replyToken, lineMessages, wid)
          dispatchPostReplyActions(lineUserId, flow.messages, wid).catch(e => console.error('[postReply] dispatchPostReplyActions failed:', e))
          saveOutgoingConversationMessagesByWorkspace(lineUserId, lineMessages, wid).catch(e => console.error('[conv] save error:', e))
          enterModule(sessionId, lineUserId, flow.moduleType ?? 'bot_flow', moduleId, wid).catch(e =>
            console.error('[session] enterModule error:', e),
          )
          // 按到「真人客服」模組 → 真的轉真人（通知值班客服，見 notifyStaffForLiveAgentModule）
          if (isLiveAgentModule(flow)) {
            await notifyStaffForLiveAgentModule({
              workspaceId: wid, lineUserId,
              displayName: userAttributes.displayName || '',
              customerMessage: textContent,
            })
          }
        } else {
          console.warn('[userInput] next flow has no renderable messages, skipping reply:', moduleId)
        }
      }
    } else {
      // Flow not found: activeInput already deleted above, let auto-reply run normally
      console.warn(
        '[userInput] activeInput flow missing/inactive:',
        moduleId,
      )
    }
    }
  }

  // 等待真人期間（pending_human）的輕量 ack：所有自動回覆都被抑制，客人傳訊息會
  // 完全已讀不回。給一個節流過的「已收到」回饋。human_handling（真人對話中）不插話。
  if (!handledByInput && suppressBotAutomation && replyToken) {
    await maybeSendWaitingAck(sessionId ?? null, lineUserId, replyToken, wid)
  }

  if (!handledByInput && !suppressBotAutomation) {
    // 安全層（最優先）：敏感情境（退費退款／法律／醫療…）用確定性比對先攔截，**在推進進行中腳本、
    // 自動回覆規則、啟動新腳本之前**——一律交給 AI 敏感詞護欄轉真人，不被任何腳本/規則攔截。
    const safetySettings = await getAiSettings(wid).catch(() => null)
    if (safetySettings && detectSensitiveTopic(textContent, safetySettings.sensitiveTopics)) {
      await tryAiFallback({
        workspaceId: wid,
        lineUserId,
        textContent,
        replyToken,
        userAttributes,
        channelSecret,
        sessionId: sessionId ?? null,
        requestOrigin: options.requestOrigin || '',
      })
      return
    }

    // 0. 使用者已在某條腳本中 → 推進、處理回覆 / handoff，結束
    if (userState.activeScript) {
      const advanced = await runScriptAdvance(
        userState.activeScript,
        textContent,
        userAttributes,
        fsUserDocId,
        lineUserId,
        replyToken,
        wid,
        sessionId ?? null,
        options.requestOrigin || '',
        channelSecret,
      )
      if (advanced) return
      // advanced=false → 腳本已過期 / 狀態壞掉、已清掉 activeScript；落回一般流程
    }

    const rule = await matchAutoReplyRule(textContent, wid, {
      allowAnyText: options.allowAnyText !== false,
      ruleCooldowns: userState.ruleCooldowns,
    })
    if (!rule) {
      // 對話脈絡 lazy 共用：意圖路由與 AI 答題吃同一次 Firestore 讀取;
      // 關鍵字就命中腳本（或沒有腳本）的訊息完全不會觸發載入
      let convoCtxPromise: Promise<AiConvoContext> | null = null
      const getConvoCtx = () => (convoCtxPromise ??= loadAiConvoContext(fsUserDocId, textContent))

      // 1. 規則沒命中 → 嘗試啟動腳本（關鍵字快速通道 + 統一意圖路由）
      const scriptRes = await runScriptStart(
        textContent,
        userAttributes,
        fsUserDocId,
        lineUserId,
        replyToken,
        wid,
        sessionId ?? null,
        options.requestOrigin || '',
        channelSecret,
        () => getConvoCtx().then(c => c.history),
      )
      if (scriptRes.handled) return

      // 2. 還是沒命中 → AI 保底（重用路由的意圖分類與已載入的對話脈絡）
      await tryAiFallback({
        workspaceId: wid,
        lineUserId,
        textContent,
        replyToken,
        userAttributes,
        channelSecret,
        sessionId: sessionId ?? null,
        requestOrigin: options.requestOrigin || '',
        precomputedIntent: scriptRes.route,
        getConvoCtx,
      })
      return
    }
    if (rule) {
      // 模組回覆所需的 flow＋圖文訊息預載與冷卻交易並行（純讀取，冷卻沒搶到也無副作用）。
      // 冷卻沒搶到會提早 return 而不 await 此 promise，故錯誤要在這裡收掉以免 unhandled rejection。
      const flowHydrateTask: Promise<{ flow: FlowDoc | null; hydrated: any[] }> =
        rule.action.type === 'module' && rule.action.moduleId
          ? getFlowByModuleId(rule.action.moduleId).then(async f =>
              f ? { flow: f, hydrated: await hydrateRichMessageRefs(f.messages as any[]) } : { flow: null, hydrated: [] })
            .catch((e) => {
              console.error('[autoReply] flow preload failed:', e)
              return { flow: null, hydrated: [] }
            })
          : Promise.resolve({ flow: null, hydrated: [] })

      // 冷卻規則：原子性地確認並寫入冷卻；並行請求中只有第一則能取得鎖
      const canTrigger = await claimAutoReplyCooldown(fsUserDocId, rule)
      if (!canTrigger) return

      // 貼標（非阻塞，不影響回覆速度）
      if (rule.tagging?.enabled && Array.isArray(rule.tagging?.addTagIds) && rule.tagging.addTagIds.length > 0) {
        addTagsToUser(fsUserDocId, rule.tagging.addTagIds, 'rule', rule.id ?? null, wid)
          .catch(e => console.error('[tagging] autoReply tagging failed:', e))
      }

      if (replyToken) {
        if (rule.action.type === 'module') {
          // 回覆組裝期間先顯示「輸入中…」，訊息送達時動畫自動消失（fire-and-forget）
          showLoadingAnimation(lineUserId, wid, 10).catch(() => {})
          const { flow, hydrated: hydratedMessages } = await flowHydrateTask
          if (flow) {
            const lineMessages = buildLineMessages(
              hydratedMessages,
              userAttributes,
              options.requestOrigin || '',
              lineUserId,
              channelSecret,
            )
            if (lineMessages.length > 0) {
              await replyMessage(replyToken, lineMessages, wid)
              dispatchPostReplyActions(lineUserId, flow.messages, wid).catch(e => console.error('[postReply] dispatchPostReplyActions failed:', e))
              saveOutgoingConversationMessagesByWorkspace(lineUserId, lineMessages, wid).catch(e => console.error('[conv] save error:', e))
              enterModule(sessionId, lineUserId, flow.moduleType ?? 'bot_flow', rule.action.moduleId, wid).catch(e =>
                console.error('[session] enterModule error:', e),
              )
              if (isLiveAgentModule(flow)) {
                await notifyStaffForLiveAgentModule({
                  workspaceId: wid, lineUserId,
                  displayName: userAttributes.displayName || '',
                  customerMessage: textContent,
                })
              }
            }
          } else {
            console.warn(
              '[autoReply] matched rule module missing/inactive:',
              rule.id ?? '(no-rule-id)',
              rule.action.moduleId,
            )
          }
        }
        else {
          const actionMessages = buildAutoReplyActionMessages(rule.action, userAttributes)
          if (actionMessages.length > 0) {
            await replyMessage(replyToken, actionMessages, wid)
            saveOutgoingConversationMessagesByWorkspace(lineUserId, actionMessages, wid).catch(e => console.error('[conv] save error:', e))
            // 純文字/網址回覆也是機器人真實首接(與模組動作同等;先前漏記會被誤計成未首接)
            enterModule(sessionId, lineUserId, 'bot_flow', undefined, wid).catch(e =>
              console.error('[session] enterModule error:', e),
            )
          }
        }
      }
    }
  }
}

/** 一條腳本的「觸發情境提示」（關鍵字 + 語意範例，去重）給統一意圖路由參考 */
function triggerHints(script: ScriptDoc & { id: string }): string[] {
  const root = script.nodes.find(n => n.id === script.rootNodeId)
  if (root?.type !== 'trigger') return []
  return [...new Set([...(root.keywords ?? []), ...(root.examples ?? [])].map(s => String(s).trim()).filter(Boolean))]
}

/**
 * 嘗試從使用者輸入啟動腳本。
 * 回傳 true 表示已處理（已回覆使用者）；false 表示沒有任何腳本命中。
 */
async function runScriptStart(
  textContent: string,
  userAttributes: Record<string, string>,
  fsUserDocId: string,
  lineUserId: string,
  replyToken: string | undefined,
  workspaceId: string,
  sessionId: string | null,
  requestOrigin: string,
  channelSecret: string,
  /** 對話脈絡 lazy loader：只有走到意圖路由才會真的讀 Firestore（與 tryAiFallback 共用同一次讀取） */
  getHistory?: () => Promise<AiChatTurn[]>,
): Promise<{ handled: boolean; route: RouteResult | null }> {
  const scripts = await loadActiveScripts(workspaceId).catch(() => [])
  if (!scripts.length) return { handled: false, route: null }
  // 註：敏感情境已在編排最上層（呼叫此函式之前）攔截，這裡不需再檢查。

  // 1) 關鍵字快速通道：明確、零成本、確定性（不分模式；keywords 一律當明確觸發詞）
  let matched = scripts.find(s => matchesScriptKeywords(s, textContent)) ?? null
  let route: RouteResult | null = null

  if (matched) {
    // 腳本啟動要先寫入使用者狀態才回覆，期間先顯示「輸入中…」（fire-and-forget）
    showLoadingAnimation(lineUserId, workspaceId, 10).catch(() => {})
  }

  // 2) 沒命中 → 統一意圖路由（一次 LLM 呼叫，由 LLM 理解意圖+優先序決定走哪條腳本或交給 AI）。
  //    取代舊的「每條腳本各自比語意向量」：敏感情境(退款/法律…)不會被腳本攔截、相近意圖不會誤觸。
  //    route 會回傳給 caller：沒命中腳本時 tryAiFallback 重用這份分類，不再重複呼叫 LLM。
  if (!matched) {
    // 意圖路由是一次 LLM 呼叫（1~3 秒起跳），先給「輸入中…」即時回饋。
    // 草稿模式下路由可能落到 AI（不回客人），顯示動畫反而誤導，故略過。
    const settings = await getAiSettings(workspaceId).catch(() => null)
    if (settings && settings.replyMode !== 'draft') {
      showLoadingAnimation(lineUserId, workspaceId, 20).catch(() => {})
    }
    const hints = scripts.map(s => ({ id: s.id, name: s.name, hints: triggerHints(s) }))
    const history = getHistory ? await getHistory().catch(() => [] as AiChatTurn[]) : []
    route = await routeMessage(textContent, hints, history).catch((e) => {
      console.error('[script] routeMessage error:', e)
      return null
    })
    if (route) {
      // 路由也是一次 LLM 呼叫，token 要記帳（否則月用量低估）
      recordAiUsage(workspaceId, { inputTokens: route.inputTokens, outputTokens: route.outputTokens })
        .catch(e => console.error('[script] recordAiUsage(route) error:', e))
    }
    const routedScriptId = route?.scriptId ?? null
    if (routedScriptId) matched = scripts.find(s => s.id === routedScriptId) ?? null
  }
  if (!matched) return { handled: false, route }

  const result = await startScript(matched, fsUserDocId, userAttributes)
  invalidateUserDocCache(fsUserDocId)
  const dndReply = await dndScriptHandoffReply(result, workspaceId)
  if (dndReply) await sendScriptReply(dndReply, replyToken, lineUserId, workspaceId)
  else await sendScriptReply(result.replyText, replyToken, lineUserId, workspaceId, result.quickReplies)
  // 腳本問答=機器人真實首接(先前漏記會被誤計未首接)。await:確保先記 bot,
  // 結尾轉真人時 live_agent 才能正確疊成「bot 首接+升級轉真人」而不是搶成 human 首接。
  if (sessionId && result.replyText) {
    await enterModule(sessionId, lineUserId, 'bot_flow', undefined, workspaceId).catch(e =>
      console.error('[script] enterModule error:', e),
    )
  }
  if (result.finished && result.thenHandoff) {
    await triggerHandoff(userAttributes, lineUserId, workspaceId, sessionId, requestOrigin, channelSecret, /*alreadyReplied*/ true)
  }
  return { handled: true, route }
}

async function runScriptAdvance(
  active: ActiveScriptState,
  textContent: string,
  userAttributes: Record<string, string>,
  fsUserDocId: string,
  lineUserId: string,
  replyToken: string | undefined,
  workspaceId: string,
  sessionId: string | null,
  requestOrigin: string,
  channelSecret: string,
): Promise<boolean> {
  const result = await advanceScript(active, textContent, userAttributes, fsUserDocId)
  invalidateUserDocCache(fsUserDocId)
  if (result.escapeToHuman) {
    // 逃生門:腳本進行中喊「找真人」→ 流程已放棄,走標準轉真人(回覆客人+通知值班+標記 session)
    await deliverHandoffReply({
      workspaceId, lineUserId, replyToken, userAttributes, channelSecret,
      sessionId, requestOrigin,
      customerMessage: textContent,
      reason: 'user_request',
    })
    return true
  }
  if (!result.replyText && result.finished) {
    // 過期或狀態壞掉 → 不算處理過，讓主流程往下走（rule / AI）
    return false
  }
  const dndReply = await dndScriptHandoffReply(result, workspaceId)
  if (dndReply) await sendScriptReply(dndReply, replyToken, lineUserId, workspaceId)
  else await sendScriptReply(result.replyText, replyToken, lineUserId, workspaceId, result.quickReplies)
  // 同 runScriptStart:腳本推進的回覆也記機器人首接(涵蓋「session 換新後才接續腳本」的情況)
  if (sessionId && result.replyText) {
    await enterModule(sessionId, lineUserId, 'bot_flow', undefined, workspaceId).catch(e =>
      console.error('[script] enterModule error:', e),
    )
  }
  if (result.finished && result.thenHandoff) {
    await triggerHandoff(userAttributes, lineUserId, workspaceId, sessionId, requestOrigin, channelSecret, true)
  }
  return true
}

/**
 * 腳本結束並要轉真人時,若處於勿擾時段,回傳要改送給客人的勿擾訊息（否則 null = 照常送腳本回覆）。
 * 靜音客服通知由 notifyHandoffToStaff 端統一處理;這裡只負責換掉「客人看到的那則訊息」。
 */
async function dndScriptHandoffReply(
  result: { finished?: boolean; thenHandoff?: boolean },
  workspaceId: string,
): Promise<string | null> {
  if (!(result.finished && result.thenHandoff)) return null
  const settings = await getAiSettings(workspaceId).catch(() => null)
  if (!isServiceHoursDnd(settings?.serviceHours)) return null
  return settings?.serviceHours?.dndReply || DEFAULT_DND_REPLY
}

async function sendScriptReply(
  text: string,
  replyToken: string | undefined,
  lineUserId: string,
  workspaceId: string,
  quickReplies?: string[],
): Promise<void> {
  if (!text || !replyToken) return
  const msg: messagingApi.TextMessage = { type: 'text', text: text.slice(0, 5000) }
  // quickReply 節點：把選項做成 LINE Quick Reply 按鈕（label = 送出文字，供 advanceScript 比對）
  const labels = (quickReplies ?? []).map(l => String(l).trim()).filter(Boolean).slice(0, 13)
  if (labels.length) {
    msg.quickReply = {
      items: labels.map(label => ({
        type: 'action',
        action: { type: 'message', label: label.slice(0, 20), text: label },
      })),
    }
  }
  await replyMessage(replyToken, [msg], workspaceId)
  saveOutgoingConversationMessagesByWorkspace(lineUserId, [msg], workspaceId)
    .catch(e => console.error('[script] save outgoing error:', e))
}

/**
 * 腳本 reply.thenHandoff=true：標記 session 進入 live_agent。
 * 訊息已經由腳本送出，這邊只負責 session state。
 */
async function triggerHandoff(
  userAttributes: Record<string, string>,
  lineUserId: string,
  workspaceId: string,
  sessionId: string | null,
  _requestOrigin: string,
  _channelSecret: string,
  _alreadyReplied: boolean,
): Promise<void> {
  // 通知值班客服（與 session 標記獨立，sessionId 缺失也照樣通知）
  notifyHandoffToStaff({
    workspaceId,
    customerLineUserId: lineUserId,
    customerName: userAttributes.displayName || lineUserId,
    customerMessage: '',
    reason: null,
  }).catch(e => console.error('[script] notifyHandoffToStaff error:', e))

  if (!sessionId) return
  enterModule(sessionId, lineUserId, 'live_agent', SYSTEM_MODULE_IDS.live_agent, workspaceId)
    .catch(e => console.error('[script] enterModule(live_agent) error:', e))
}

// HUMAN_REQUEST_TEXTS 已移到 shared/types/ai-script.ts(AI 層攔截、腳本逃生門、試跑面板共用同一份)

// ── 轉接前的二次確認（「需要幫您轉接專員嗎?」）──────────────────────
// AI 自己「推斷」答不了（信心不足 / 知識庫無依據）時，先問客人要不要轉真人並給按鈕，
// 把 session 留在 bot；客人確認才真的轉接。降低誤判直接占用真人、也避免轉進「無人接」黑洞。
// 敏感詞 / 額度用罄 / LLM 失敗 / 客人明講 不在此列（見呼叫端），維持直接轉接。
// unresolved（客人回報「照做了沒解決」）也走確認——別直接占用真人，但要主動遞出轉接按鈕。
const HANDOFF_CONFIRM_REASONS = new Set<HandoffReason>(['low_confidence', 'no_grounding', 'unresolved', 'product_mismatch'])

/** 二次確認 quick-reply 按鈕送回的文字 */
const HANDOFF_CONFIRM_YES_TEXT = '轉接專員'
const HANDOFF_CONFIRM_NO_TEXT = '我再問問'

// 客人沒按鈕、自己打字回應「需要轉接嗎?」時的口語判斷。先比對否定（「不要」含「要」會誤中肯定）。
// 否定用子字串比對但限短句（長句多半是新問題，「我不需要保固可以退嗎」不該被當拒絕）。
const CONFIRM_NO_RE = /不用|不要|不需要|不必|不轉|先不|沒事|沒關係|算了|自己/
const CONFIRM_NO_MAX_LEN = 12

// 肯定必須「整句就是短肯定」白名單：只比開頭會把接著問的新問題吃掉
// （「請問除濕機多少錢」「可以退貨嗎」「好像壞了」開頭都撞肯定詞 → 問題被丟掉直接轉真人）。
const CONFIRM_YES_TEXTS = new Set([
  '好', '好的', '好啊', '好呀', '好喔', '要', '是', '是的', '對', '對啊',
  '需要', '麻煩', '麻煩了', '麻煩你了', '麻煩您了', '轉接', '轉', '幫我轉',
  '可以', '可以啊', '嗯', '嗯嗯', 'ok', 'okay', 'yes',
])

function isConfirmYesText(raw: string): boolean {
  // 去尾端語氣標點後整句精確比對；帶問號（「可以嗎?」）一律當新問題
  const t = raw.trim().toLowerCase().replace(/[!！。．~〜～\s]+$/g, '')
  return CONFIRM_YES_TEXTS.has(t)
}

// 「需要轉接嗎?」等待回應的時效：超過就不再用口語猜測（客人隔天回來的第一句
// 不該被當成在回答昨天的問題）；quick-reply 按鈕文字不受時效限制（意圖明確）。
const HANDOFF_CONFIRM_TTL_MS = 10 * 60 * 1000

const HANDOFF_CONFIRM_PROMPT = '這個問題我不太確定該怎麼回答 😅 需要幫您轉接專員嗎？'
/** unresolved 專用：客人才剛照做過步驟，說「不確定怎麼回答」會顯得沒在聽 */
const HANDOFF_CONFIRM_PROMPT_UNRESOLVED = '看來這些方法沒有解決您的問題 😥 需要幫您轉接專員進一步協助嗎？'
const HANDOFF_DECLINE_REPLY = '好的～您可以換個方式描述，或直接告訴我想了解什麼，我再幫您看看 😊'

// ── 回答品質 proxy：「AI 答完不久客人又被轉真人」────────────────────
// AI answered 後 30 分鐘內發生 handoff，多半代表那次回答沒解決問題。
// 聚合進 aiUsage.answeredThenHandoffs，給監控頁當品質指標（調門檻的依據）。
const ANSWERED_THEN_HANDOFF_WINDOW_MS = 30 * 60 * 1000

function wasRecentlyAnswered(meta: AiConversationMeta | undefined | null): boolean {
  if (!meta || meta.lastDecision !== 'answered') return false
  const ms = (meta.updatedAt as any)?.toMillis?.() ?? 0
  return ms > 0 && (Date.now() - ms) < ANSWERED_THEN_HANDOFF_WINDOW_MS
}

// ── 等待真人期間的輕量 ack ────────────────────────────────────────
// pending_human 時所有自動回覆都被抑制，客人後續訊息會完全沒回應（已讀不回）。
// 每位客人 30 分鐘最多回一次「已收到」。per-instance in-memory 節流，
// 多實例最壞各回一次，可接受（同 handoff 通知的取捨）。
const WAITING_ACK_THROTTLE_MS = 30 * 60 * 1000
const WAITING_ACK_MAP_MAX_ENTRIES = 5000
const waitingAckSentAt = new Map<string, number>()

/**
 * 「已為您安排專員」也算一次安撫語，要一起吃這個節流——否則客人在一分鐘內先收到
 * 「已為您安排專員，將盡快回覆您」再收到「已收到您的訊息，專員會盡快回覆您」，
 * 兩句話同一個意思、卻讓人以為前一次沒生效（實測就發生過，接著真人 2 小時後才回）。
 */
function markWaitingAckSent(workspaceId: string, lineUserId: string): void {
  waitingAckSentAt.set(`${workspaceId}:${lineUserId}`, Date.now())
  capMapSize(waitingAckSentAt, WAITING_ACK_MAP_MAX_ENTRIES)
}

/**
 * 客人在機器人裡按到「真人客服」模組（moduleType='live_agent'）＝ 一次**真正的**轉真人。
 *
 * 訊息本身由模組自己的文案回覆（呼叫端已送出）、狀態由 enterModule('live_agent') 標記，
 * 但先前這條路少了最重要的一步：**通知值班客服**。實測災情就是這樣——客人收到
 * 「謝謝您！我們的客服人員會很快聯絡您」，而沒有任何客服知道有人在等，客人問到第三次
 * 才因為 AI 的二次確認才真的排進佇列。
 *
 * 通知端自帶節流與 enabled 判斷，所以「按按鈕之後 AI 又轉一次」不會轟兩則。
 */
async function notifyStaffForLiveAgentModule(params: {
  workspaceId: string
  lineUserId: string
  displayName: string
  customerMessage: string
}): Promise<void> {
  // 「客服人員會很快聯絡您」本身就是安撫語 → 讓等待中的 ack 一起吃節流（同 deliverHandoffReply）
  markWaitingAckSent(params.workspaceId, params.lineUserId)
  await notifyHandoffToStaff({
    workspaceId: params.workspaceId,
    customerLineUserId: params.lineUserId,
    customerName: params.displayName || params.lineUserId,
    customerMessage: params.customerMessage,
    reason: 'user_request',
    summary: '',
  }).catch(e => console.error('[live-agent-module] notifyHandoffToStaff error:', e))
}

/** 這個模組是不是「真人客服」系統模組（按到它就要真的轉真人＋通知客服） */
function isLiveAgentModule(flow: { moduleType?: ModuleType | null } | null | undefined): boolean {
  return (flow?.moduleType ?? 'bot_flow') === 'live_agent'
}

// ── 非文字訊息的禮貌回覆 ─────────────────────────────────────────────
// 客人傳圖片/影片/語音/檔案時 AI 讀不懂內容,完全沉默像被已讀不回 → 回一句引導。
// 條件:機器人服務中(真人接手時不插嘴)+ AI 全自動(draft/關閉的工作區不讓機器人開口)。
const NON_TEXT_ACK_THROTTLE_MS = 10 * 60 * 1000
const nonTextAckSentAt = new Map<string, number>()

// 會觸發引導語的非文字類型(貼圖刻意不在內:多半是裝飾/情緒,也不會被引導去找真人)
const NON_TEXT_INBOUND_TYPES = new Set(['image', 'video', 'audio', 'file'])
// 對話列表/監控頁的類型占位標籤(訊息本體沒有文字可顯示)
const NON_TEXT_QUERY_LABELS: Record<string, string> = {
  image: '[圖片]', video: '[影片]', audio: '[語音]', file: '[檔案]',
}
// 圖/影/音/檔進線後,多久內打「找真人」視為「因為傳了 AI 看不懂的內容而被引導語叫來」
const NON_TEXT_HANDOFF_WINDOW_MS = 10 * 60 * 1000

async function maybeAckNonTextMessage(
  sessionId: string | null,
  lineUserId: string,
  replyToken: string,
  workspaceId: string,
): Promise<void> {
  try {
    // 等待真人/真人處理中 → 靜默(等待中的安撫由 waiting-ack 負責文字訊息即可)
    if (await shouldSuppressInboundBotAutomationForSession(sessionId)) return
    const settings = await getAiSettings(workspaceId).catch(() => null)
    if (!settings?.enabled || settings.replyMode !== 'auto') return

    const key = `${workspaceId}:${lineUserId}`
    const now = Date.now()
    if (now - (nonTextAckSentAt.get(key) ?? 0) < NON_TEXT_ACK_THROTTLE_MS) return
    nonTextAckSentAt.set(key, now)
    capMapSize(nonTextAckSentAt, WAITING_ACK_MAP_MAX_ENTRIES)

    const msg: messagingApi.TextMessage = {
      type: 'text',
      text: '收到您傳的內容了！我目前只能閱讀文字，方便用文字描述您的問題嗎？需要專員協助也可以輸入「找真人」🙏',
    }
    try {
      await replyMessage(replyToken, [msg], workspaceId)
    }
    catch (e) {
      nonTextAckSentAt.delete(key)
      throw e
    }
    saveOutgoingConversationMessagesByWorkspace(lineUserId, [msg], workspaceId)
      .catch(e => console.error('[non-text-ack] save outgoing error:', e))
    // 客人傳了圖/影/音/檔（有需求）、機器人真的回了一句 → 記機器人首接。
    // 記 bot_flow 不記 ai：這是寫死的引導語，不是 AI 作答，記 ai 會灌水 AI 答題數。
    // 先前漏記會讓「傳圖後只收到引導語」的會話永遠掛在未首接。
    enterModule(sessionId, lineUserId, 'bot_flow', undefined, workspaceId).catch(e =>
      console.error('[non-text-ack] enterModule error:', e),
    )
  }
  catch (e) {
    console.error('[non-text-ack] failed:', e)
  }
}

async function maybeSendWaitingAck(
  sessionId: string | null,
  lineUserId: string,
  replyToken: string,
  workspaceId: string,
): Promise<void> {
  try {
    // 只在「待真人」ack；真人對話中（human_handling）插話反而干擾
    const status = await getSessionStatusCached(sessionId)
    if (status !== 'pending_human') return

    const key = `${workspaceId}:${lineUserId}`
    const now = Date.now()
    if (now - (waitingAckSentAt.get(key) ?? 0) < WAITING_ACK_THROTTLE_MS) return
    // 先佔位（防並發 webhook 重複 ack），發送失敗再回滾，避免一次失敗讓客人 30 分鐘拿不到 ack
    waitingAckSentAt.set(key, now)
    capMapSize(waitingAckSentAt, WAITING_ACK_MAP_MAX_ENTRIES)

    const msg: messagingApi.TextMessage = {
      type: 'text',
      text: '已收到您的訊息，專員會盡快回覆您 🙏',
    }
    try {
      await replyMessage(replyToken, [msg], workspaceId)
    }
    catch (e) {
      waitingAckSentAt.delete(key)
      throw e
    }
    saveOutgoingConversationMessagesByWorkspace(lineUserId, [msg], workspaceId)
      .catch(e => console.error('[waiting-ack] save outgoing error:', e))
  }
  catch (e) {
    console.error('[waiting-ack] failed:', e)
  }
}

/**
 * 把客人轉真人：回覆本工作區「真人客服」系統模組的訊息（沒設就用預設文字）、標記 session 進入
 * live_agent、通知值班客服。AI handoff 與「找真人」攔截共用。
 */
async function deliverHandoffReply(params: {
  workspaceId: string
  lineUserId: string
  replyToken: string | undefined
  userAttributes: Record<string, string>
  channelSecret: string
  sessionId: string | null
  requestOrigin: string
  /** 觸發 handoff 的客人訊息（給通知用） */
  customerMessage: string
  reason: HandoffReason | null
  /**
   * 轉接訊息**之前**要先送給客人的一句話（目前用於 order_status：AI 從知識庫查到的
   * 一般規則，例「一般 3–5 個工作日出貨」）。先給期待值再說「幫您轉專員查這一筆」，
   * 比只丟一句「幫您轉接」有用得多。空字串 = 不送。
   */
  prefixText?: string
  /**
   * AI 生成的對話摘要（best-effort，可為空）。可傳 Promise——客人回覆會先送出，
   * 摘要在送出後才 await，避免摘要的 LLM 延遲卡住客人的「已安排專員」回覆。
   */
  summary?: string | Promise<string>
}): Promise<void> {
  const { workspaceId, lineUserId, replyToken, userAttributes, channelSecret, sessionId, requestOrigin } = params

  // 勿擾時段:轉真人照常發生（session 仍進 live_agent、staff notify 由 notifyHandoffToStaff 端靜音），
  // 但客人收到的不是「已為您安排專員」而是勿擾訊息（避免承諾「馬上有人」卻整夜沒人）。
  const settings = await getAiSettings(workspaceId).catch(() => null)
  const dnd = isServiceHoursDnd(settings?.serviceHours)

  let handoffMessages: messagingApi.Message[] = []
  if (dnd) {
    handoffMessages = [{ type: 'text', text: settings?.serviceHours?.dndReply || DEFAULT_DND_REPLY } as messagingApi.TextMessage]
  }
  else {
    // ⚠️ 要用「本工作區的系統模組 doc id」查（見 systemModuleId）。
    // 先前傳的是 SYSTEM_MODULE_IDS.live_agent（'sys_live_agent'）——那是模組種類代號、
    // 不是文件 id，永遠查不到 → 店家在後台「真人客服」設的文案從來沒送出去過，
    // 客人一律收到下面那句寫死的預設值。
    const liveAgentFlow = await getFlowByModuleId(systemModuleId(workspaceId, 'live_agent')).catch(() => null)
    if (liveAgentFlow) {
      const hydrated = await hydrateRichMessageRefs(liveAgentFlow.messages as any[])
      handoffMessages = buildLineMessages(hydrated, userAttributes, requestOrigin, lineUserId, channelSecret)
    }
    if (handoffMessages.length === 0) {
      handoffMessages = [{ type: 'text', text: '已為您安排專員，將盡快回覆您 🙇' } as messagingApi.TextMessage]
    }
  }

  // 規則先講、再講「幫您轉專員」。勿擾時段也照講（規則本身仍然有用，只是沒人接手）。
  const prefixText = String(params.prefixText ?? '').trim()
  if (prefixText) {
    handoffMessages = [{ type: 'text', text: prefixText } as messagingApi.TextMessage, ...handoffMessages]
  }

  if (replyToken) {
    // reply 失敗（token 過期 / LINE 5xx）不能讓整個轉接蒸發：客人這則沒收到「已安排專員」,
    // 但 session 標記與值班通知必須照常執行——否則客服不知道有人在等,而統計已計入 handoff。
    try {
      await replyMessage(replyToken, handoffMessages, workspaceId)
      // 客人剛剛才被告知「已安排專員 / 目前非服務時間」→ 讓等待中的 ack 一起吃節流
      markWaitingAckSent(workspaceId, lineUserId)
      saveOutgoingConversationMessagesByWorkspace(lineUserId, handoffMessages, workspaceId)
        .catch(e => console.error('[ai-fallback] save outgoing error:', e))
    }
    catch (e) {
      console.error('[ai-fallback] handoff reply failed, continuing enterModule/notify:', e)
    }
  }

  // 這裡刻意 await：狀態沒寫進去之前，同一批進來的下一則訊息會被判成「機器人還在處理」
  // 而讓 AI 又開口（實測：客人同時打「轉接專員」＋「好」，第二句被當成招呼語回了
  // 「請問有什麼可以為您服務的嗎？」）。客人的回覆上面已經送出，這段不影響回覆速度。
  await enterModule(sessionId, lineUserId, 'live_agent', SYSTEM_MODULE_IDS.live_agent, workspaceId)
    .catch(e => console.error('[ai-fallback] enterModule(live_agent) error:', e))

  // 摘要在客人回覆送出後才 await（summarizeHandoffContext 不會 reject、最壞 4s 逾時回空字串）
  const resolvedSummary = params.summary instanceof Promise ? await params.summary : params.summary

  // 通知值班客服（fire-and-forget，內含節流與 enabled 判斷）
  notifyHandoffToStaff({
    workspaceId,
    customerLineUserId: lineUserId,
    customerName: userAttributes.displayName || lineUserId,
    customerMessage: params.customerMessage,
    reason: params.reason,
    summary: resolvedSummary,
  }).catch(e => console.error('[ai-fallback] notifyHandoffToStaff error:', e))
}

/** tryAiFallback / routeMessage 共用的對話脈絡（一次 Firestore 讀取供兩處使用） */
interface AiConvoContext {
  prevAiMeta: AiConversationMeta | undefined
  /** 最近對話（最舊在前、已排除本次剛存進去的訊息、最多 6 則） */
  history: AiChatTurn[]
}

async function loadAiConvoContext(fsUserDocId: string, textContent: string): Promise<AiConvoContext> {
  // 並行讀：上一輪 aiMeta（followup / disambiguation cooldown 判斷）+ 最近對話（多輪上下文）
  const [convoSnap, historySnap] = await Promise.all([
    getDb().collection('conversations').doc(fsUserDocId).get().catch(() => null),
    getDb().collection('conversations').doc(fsUserDocId)
      .collection('messages').orderBy('timestamp', 'desc').limit(8).get().catch(() => null),
  ])
  const prevAiMeta = (convoSnap?.data() as any)?.aiMeta as AiConversationMeta | undefined

  // 組裝最近對話（最舊在前）；排除剛存進去的本次訊息，最多帶 6 則
  let history: AiChatTurn[] = (historySnap?.docs ?? [])
    .map(d => d.data() as { direction?: string; text?: string })
    .reverse()
    .map(m => ({
      role: m.direction === 'incoming' ? 'user' as const : 'bot' as const,
      text: String(m.text || '').trim(),
    }))
    .filter(t => t.text)
  const lastTurn = history[history.length - 1]
  if (lastTurn && lastTurn.role === 'user' && lastTurn.text === textContent.trim()) {
    history = history.slice(0, -1)
  }
  history = history.slice(-6)

  return { prevAiMeta, history }
}

/**
 * 規則／腳本都沒命中時，呼叫 AI 接手。
 *
 * 由 caller 控制是否啟用 AI 自動回覆（settings.enabled）；playground 試答不受此限。
 * AI 內部仍會判斷 quota / 敏感詞 / grounding / 信心，並回傳：
 *   - answered → 直接以 AI 文字回覆
 *   - handoff  → 觸發 sys_live_agent 流程（或預設文字），標記 session 進入 live_agent
 *   - 其他    → 靜默（例如 query 過短）
 *
 * 一律寫入 conversation.aiMeta，給「真人收件匣」（Phase 4）參考。
 */
async function tryAiFallback(params: {
  workspaceId: string
  lineUserId: string
  textContent: string
  replyToken: string | undefined
  userAttributes: Record<string, string>
  channelSecret: string
  sessionId: string | null
  requestOrigin: string
  /** runScriptStart 的意圖路由結果（沒命中腳本時重用，answerWithAi 不再重複分類；token 已記帳） */
  precomputedIntent?: RouteResult | null
  /** 對話脈絡 lazy loader（與意圖路由共用同一次 Firestore 讀取）；未帶則自行載入 */
  getConvoCtx?: () => Promise<AiConvoContext>
}): Promise<void> {
  const { workspaceId, lineUserId, textContent, replyToken, userAttributes, channelSecret, sessionId, requestOrigin } = params

  const settings = await getAiSettings(workspaceId).catch(() => null)
  if (!settings?.enabled) return

  const fsUserDocId = lineUserFirestoreDocId(lineUserId, workspaceId)

  // 草稿模式：AI 照常答題並寫進收件匣（suggestedReply），但不對客人發任何訊息。
  // 新導入工作區先觀察 AI 答題品質、再切全自動的漸進信任路徑。
  const draftMode = settings.replyMode === 'draft'

  // 客人明確要求真人（「找真人」按鈕或自行輸入）→ 不經 AI 直接轉接。
  // 沒有這個攔截的話，「找真人」會被拿去向量檢索、靠 no_grounding 繞路才轉真人，
  // 多花一次 embed，且若知識庫剛好有相關卡還可能被 AI 誤答。
  if (HUMAN_REQUEST_TEXTS.has(textContent.trim())) {
    // 計入用量統計：列表（aiMeta handoff）與 KPI（handoffs 計數）必須一致
    recordAiUsage(workspaceId, { invocations: 1, handoffs: 1 })
      .catch(e => console.error('[ai-fallback] recordAiUsage(user_request) error:', e))

    // 這一句「找真人」是客人自己想找人,還是剛傳完圖被引導語叫來的?兩者的後續處理
    // 完全不同(補知識 vs. 看那張圖),所以轉接前先讀對話文件回溯起因。
    // 這裡改成 await:原本只有品質指標用得到、可以 fire-and-forget,現在 reason 要靠它決定。
    // 只發生在「找真人」這條罕見路徑,後面本來就要打 LINE API,多這一次讀取不影響體感。
    const convSnap = await getDb().collection('conversations').doc(fsUserDocId).get().catch(() => null)
    const convData = convSnap?.data() as {
      aiMeta?: AiConversationMeta
      lastNonTextInboundAt?: { toMillis?: () => number }
      lastNonTextInboundType?: string
      lastNonTextInboundSummary?: string
    } | undefined
    const nonTextAtMs = convData?.lastNonTextInboundAt?.toMillis?.() ?? 0
    // 圖之後若客人已經改用文字問、AI 也答了(aiMeta 比圖新),那這句「找真人」是對那個
    // 回答不滿意,不是被圖卡住——這時標成傳圖會把人導向錯的處理方式(去看圖而不是補知識)。
    // aiMeta 只有文字互動會動(引導語不是 AI、不寫 aiMeta),所以兩個時間戳比大小就夠。
    const lastAiAtMs = (convData?.aiMeta?.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0
    const nonTextIsLatest = nonTextAtMs > 0
      && nonTextAtMs > lastAiAtMs
      && (Date.now() - nonTextAtMs) <= NON_TEXT_HANDOFF_WINDOW_MS
    const nonTextType = nonTextIsLatest ? String(convData?.lastNonTextInboundType || '') : ''
    const handoffReason: HandoffReason = nonTextType ? 'non_text_content' : 'user_request'
    // 監控頁列出的是「客人問了什麼」,存「找真人」三個字等於沒說；改存內容類型,
    // 一眼看得出這是張圖。AI 有讀出圖片內容時再接上那句描述——
    // 「[圖片] 破掉的馬克杯」對客服的價值遠高於「[圖片]」,不用點進去就知道要準備什麼。
    const nonTextSummary = nonTextType ? String(convData?.lastNonTextInboundSummary || '').trim() : ''
    const nonTextLabel = nonTextType ? (NON_TEXT_QUERY_LABELS[nonTextType] ?? `[${nonTextType}]`) : ''
    const handoffQuery = nonTextType
      ? (nonTextSummary ? `${nonTextLabel} ${nonTextSummary}` : nonTextLabel)
      : textContent

    // 品質指標：剛被 AI 回答完就按「找真人」= 回答沒解決問題（fire-and-forget）。
    // 草稿模式不計——客人根本沒看到那次回答。
    if (!draftMode && wasRecentlyAnswered(convData?.aiMeta)) {
      recordAiUsage(workspaceId, { answeredThenHandoffs: 1 }).catch(() => {})
    }

    // 草稿模式維持「不對客人發話、不鎖 session」的契約，只通知值班客服
    if (draftMode) {
      notifyHandoffToStaff({
        workspaceId,
        customerLineUserId: lineUserId,
        customerName: userAttributes.displayName || lineUserId,
        customerMessage: handoffQuery,
        reason: handoffReason,
      }).catch(e => console.error('[ai-fallback] notifyHandoffToStaff error:', e))
    }
    else {
      await deliverHandoffReply({
        workspaceId, lineUserId, replyToken, userAttributes, channelSecret,
        sessionId, requestOrigin,
        customerMessage: handoffQuery,
        reason: handoffReason,
      })
    }
    await writeAiMeta(fsUserDocId, {
      lastDecision: 'handoff',
      lastHandoffReason: handoffReason,
      lastQuery: handoffQuery,
    })
    return
  }

  // AI 思考最壞 ~10 秒；先顯示「輸入中…」動畫給客人即時回饋（fire-and-forget，失敗不影響主流程）
  // 草稿模式不會回覆客人，顯示「輸入中…」反而誤導。
  if (!draftMode) {
    showLoadingAnimation(lineUserId, workspaceId, 20).catch(() => {})
  }

  // 對話脈絡：runScriptStart 的意圖路由已載入過就重用（同一次 Firestore 讀取），否則自行載入
  const { prevAiMeta, history } = await (params.getConvoCtx?.() ?? loadAiConvoContext(fsUserDocId, textContent))

  // ── 客人對「需要幫您轉接專員嗎?」的回應 ───────────────────────────
  // 上一輪是二次確認；這輪若是肯定 → 執行真正轉接（handoffs 已在 ask 時計過，不重複計）；
  // 否定 → 安撫並把狀態收掉；其他 → 當作新問題往下跑正常 AI。
  if (prevAiMeta?.lastDecision === 'handoff_confirm') {
    const t = textContent.trim()
    // 時效內才做口語猜測；按鈕文字（轉接專員 / 我再問問）永遠有效
    const askedMs = (prevAiMeta.updatedAt as any)?.toMillis?.() ?? 0
    const fresh = askedMs > 0 && (Date.now() - askedMs) <= HANDOFF_CONFIRM_TTL_MS
    const declined = t === HANDOFF_CONFIRM_NO_TEXT
      || (fresh && t.length <= CONFIRM_NO_MAX_LEN && CONFIRM_NO_RE.test(t))
    const confirmed = !declined && (t === HANDOFF_CONFIRM_YES_TEXT || (fresh && isConfirmYesText(t)))
    if (confirmed) {
      const reason = prevAiMeta.lastHandoffReason ?? 'user_request'
      await deliverHandoffReply({
        workspaceId, lineUserId, replyToken, userAttributes, channelSecret,
        sessionId, requestOrigin,
        customerMessage: textContent,
        reason,
      })
      await writeAiMeta(fsUserDocId, {
        lastDecision: 'handoff',
        lastConfidence: prevAiMeta.lastConfidence ?? 0,
        lastHandoffReason: reason,
        lastQuery: prevAiMeta.lastQuery || textContent,
        lastSourceChunkIds: prevAiMeta.lastSourceChunkIds ?? [],
        suggestedReply: prevAiMeta.suggestedReply ?? '',
      })
      return
    }
    if (declined) {
      if (replyToken) {
        const msg: messagingApi.TextMessage = { type: 'text', text: HANDOFF_DECLINE_REPLY }
        await replyMessage(replyToken, [msg], workspaceId)
        saveOutgoingConversationMessagesByWorkspace(lineUserId, [msg], workspaceId)
          .catch(e => console.error('[ai-fallback] save outgoing error:', e))
      }
      // 收掉 pending 狀態（'skipped' 不入轉真人案例列表、也不算 answeredThenHandoff）
      await writeAiMeta(fsUserDocId, { lastDecision: 'skipped', lastQuery: textContent })
      return
    }
    // 既非肯定也非否定 → 客人改問新問題，往下走正常 AI 流程
  }

  const lastDis = prevAiMeta?.lastDisambiguation ?? null

  // Followup：客人剛被反問過，這次訊息正好等於某個 option → 把該 option 當新 query 跑。
  // 同時帶上反問前的原始問題（lastQuery）：只拿選項標題檢索會答非所問
  // （問水箱多大 → 點選項 → 背操作面板），answerWithAi 會用「標題＋原始問題」合成檢索與作答。
  let query = textContent
  let isFollowup = false
  let followupOf: string | undefined
  if (lastDis?.options?.length) {
    const trimmed = textContent.trim()
    // 按鈕送出的 text 已改用短 label（見下方 quick reply 組裝）；label 與 title 都認得，
    // 部署前發出的舊反問（text=title）也仍能比對。
    const match = trimmed
      ? lastDis.options.find(o => o.title === trimmed || (o.label ?? '').trim() === trimmed)
      : undefined
    if (match) {
      query = match.title
      isFollowup = true
      followupOf = prevAiMeta?.lastQuery?.trim() || undefined
    }
  }

  // Cooldown：最近反問過就先別再反問，這輪強制直接答（或走 handoff）
  const cooldownMs = settings.disambiguation.cooldownMinutes * 60 * 1000
  const askedAtMs = (lastDis?.askedAt as any)?.toMillis?.() ?? 0
  const inCooldown = cooldownMs > 0 && askedAtMs > 0 && (Date.now() - askedAtMs) < cooldownMs
  const skipDisambiguation = isFollowup || inCooldown

  // llm_error：Gemini 暴掉。不回客人（丟「已為您安排專員」反而誤導），但**不能靜默**——
  // 客服必須知道有人在等：通知值班 + 寫 aiMeta 讓收件匣看得到這位客人。
  const recordLlmError = async () => {
    notifyHandoffToStaff({
      workspaceId,
      customerLineUserId: lineUserId,
      customerName: userAttributes.displayName || lineUserId,
      customerMessage: textContent,
      reason: 'llm_error',
    }).catch(e => console.error('[ai-fallback] notifyHandoffToStaff error:', e))
    await writeAiMeta(fsUserDocId, {
      lastDecision: 'handoff',
      lastHandoffReason: 'llm_error',
      lastQuery: textContent,
      // 瞬時錯誤不能清掉反問狀態：客人重點同一顆按鈕要仍被視為 followup、cooldown 不重置
      lastDisambiguation: prevAiMeta?.lastDisambiguation ?? null,
      suggestedReply: prevAiMeta?.suggestedReply ?? '',
    })
  }

  let result
  try {
    result = await answerWithAi({
      workspaceId,
      query,
      isFollowup,
      followupOf,
      skipDisambiguation,
      history,
      // 意圖路由已分類過就重用（省一次 flash-lite）;routeMessage 失敗回 null 時仍由內部 classifyIntent 補
      precomputedIntent: params.precomputedIntent ?? undefined,
    })
  }
  catch (e) {
    console.error('[ai-fallback] answerWithAi failed:', e)
    await recordLlmError()
    return
  }

  if (result.decision === 'handoff' && result.handoffReason === 'llm_error') {
    await recordLlmError()
    return
  }

  // 跳過不回客人的情況（維持原本「無人接」行為）：
  //   - skipped：AI 設定上跳過此題
  //   - manual：真的是設定 / 空 query 等流程問題
  if (
    result.decision === 'skipped'
    || (result.decision === 'handoff' && result.handoffReason === 'manual')
  ) {
    return
  }

  // ── A. 答題：回覆文字（草稿模式只進收件匣，不發給客人）──────
  if (result.decision === 'answered' && result.answer.trim()) {
    if (replyToken && !draftMode) {
      const msg: messagingApi.TextMessage = { type: 'text', text: result.answer.slice(0, 5000) }
      await replyMessage(replyToken, [msg], workspaceId)
      saveOutgoingConversationMessagesByWorkspace(lineUserId, [msg], workspaceId, { aiGenerated: true })
        .catch(e => console.error('[ai-fallback] save outgoing error:', e))
      // 登記「AI 首接」：AI 真的自動回覆了客人才算（草稿模式客人沒收到、不算首接）。
      // 非阻塞——與 bot_flow 自動回覆同慣例（先送客人回覆，統計背景補記）。
      enterModule(sessionId, lineUserId, 'ai', undefined, workspaceId).catch(e =>
        console.error('[ai-fallback] enterModule(ai) error:', e),
      )
    }
    await writeAiMeta(fsUserDocId, {
      lastDecision: 'answered',
      lastConfidence: result.confidence,
      lastQuery: textContent,
      lastSourceChunkIds: result.sources.map(s => s.chunkId),
      lastAnswerKind: result.answerKind ?? 'kb',
      suggestedReply: draftMode ? result.answer : '',
    })
    return
  }

  // ── B. Disambiguation：反問澄清 + Quick Reply 按鈕 ─────────
  if (result.decision === 'disambiguate' && result.disambiguation) {
    const dis = result.disambiguation

    // 草稿模式：客人看不到選項按鈕，反問語句當建議回覆給客服參考即可；
    // 不寫 lastDisambiguation（沒有「等客人選」的狀態）。
    if (draftMode) {
      await writeAiMeta(fsUserDocId, {
        lastDecision: 'disambiguate',
        lastConfidence: result.confidence,
        lastQuery: textContent,
        lastSourceChunkIds: result.sources.map(s => s.chunkId),
        suggestedReply: dis.clarification,
      })
      return
    }

    // label 用 LLM 生成的短名稱（≤20 字硬限制是 LINE 規格）。
    // 送出的 text 也用短 label——客人點按鈕後氣泡顯示的就是這個 text，整串卡片標題機器味太重；
    // label 缺失或與其他選項撞名（比對會歧義）時退回完整 title。followup 比對兩者都認得。
    const labelCounts = new Map<string, number>()
    for (const o of dis.options) {
      const l = (o.label || '').trim()
      if (l) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1)
    }
    const quickReplyItems: messagingApi.QuickReplyItem[] = dis.options.map((o) => {
      const l = (o.label || '').trim()
      const sendText = l && labelCounts.get(l) === 1 ? l : o.title
      return {
        type: 'action',
        // 20 字是 LINE 規格上限;切在自然邊界避免「…一級能效 6L/」這種殘句
        action: { type: 'message', label: truncateLabel(l || o.title, 20), text: sendText },
      }
    })
    quickReplyItems.push({
      type: 'action',
      action: { type: 'message', label: '🙋 找真人', text: '找真人' },
    })
    const msg: messagingApi.TextMessage = {
      type: 'text',
      text: dis.clarification.slice(0, 5000),
      quickReply: { items: quickReplyItems },
    }
    if (replyToken) {
      await replyMessage(replyToken, [msg], workspaceId)
      saveOutgoingConversationMessagesByWorkspace(lineUserId, [msg], workspaceId, { aiGenerated: true })
        .catch(e => console.error('[ai-fallback] save outgoing error:', e))
      // 反問澄清也是 AI 對客人的真實回應 → 記 AI 首接(草稿模式已在前面 return,不會到這)
      enterModule(sessionId, lineUserId, 'ai', undefined, workspaceId).catch(e =>
        console.error('[ai-fallback] enterModule(ai) error:', e),
      )
    }
    await writeAiMeta(fsUserDocId, {
      lastDecision: 'disambiguate',
      lastConfidence: result.confidence,
      lastQuery: textContent,
      lastSourceChunkIds: result.sources.map(s => s.chunkId),
      lastDisambiguation: {
        options: dis.options,
        askedAt: FieldValue.serverTimestamp(),
      },
    })
    return
  }

  // ── C. Handoff ──────────────────────────────────────────────
  // C-0. AI 自己推斷答不了（信心不足 / 無依據）→ 先問客人要不要轉接、給按鈕，session 留在 bot。
  //      客人確認（上面的 handoff_confirm 回應分支）才真的轉接。
  //      草稿模式不發問（不對客人發話），照舊只通知客服走下面直接 handoff。
  if (!draftMode && replyToken && result.handoffReason && HANDOFF_CONFIRM_REASONS.has(result.handoffReason)) {
    const quickReplyItems: messagingApi.QuickReplyItem[] = [
      { type: 'action', action: { type: 'message', label: '🙋 轉接專員', text: HANDOFF_CONFIRM_YES_TEXT } },
      { type: 'action', action: { type: 'message', label: '💬 我再問問', text: HANDOFF_CONFIRM_NO_TEXT } },
    ]
    const msg: messagingApi.TextMessage = {
      type: 'text',
      text: result.handoffReason === 'unresolved' ? HANDOFF_CONFIRM_PROMPT_UNRESOLVED : HANDOFF_CONFIRM_PROMPT,
      quickReply: { items: quickReplyItems },
    }
    await replyMessage(replyToken, [msg], workspaceId)
    saveOutgoingConversationMessagesByWorkspace(lineUserId, [msg], workspaceId)
      .catch(e => console.error('[ai-fallback] save outgoing error:', e))
    // 「需要幫您轉接嗎?」也是 AI 對客人的真實回應 → 記 AI 首接(此分支已排除草稿模式)
    enterModule(sessionId, lineUserId, 'ai', undefined, workspaceId).catch(e =>
      console.error('[ai-fallback] enterModule(ai) error:', e),
    )
    // handoffs 已在 answerWithAi 記過；這裡只多送一則確認、不重複計。
    await writeAiMeta(fsUserDocId, {
      lastDecision: 'handoff_confirm',
      lastConfidence: result.confidence,
      lastHandoffReason: result.handoffReason,
      lastQuery: textContent,
      lastSourceChunkIds: result.sources.map(s => s.chunkId),
      suggestedReply: result.decision === 'handoff' && result.answer.trim() ? result.answer : '',
    })
    return
  }

  // C-1. 直接轉接：用 sys_live_agent 的訊息回覆 + 進入 live_agent 模組
  // 品質指標：AI 剛回答完又走到 handoff = 上次回答沒解決問題。
  // 草稿模式不計——上次「answered」客人根本沒看到，計了會讓指標在試用期讀數爆表。
  if (!draftMode && wasRecentlyAnswered(prevAiMeta)) {
    recordAiUsage(workspaceId, { answeredThenHandoffs: 1 })
      .catch(e => console.error('[ai-fallback] record answeredThenHandoffs error:', e))
  }

  // AI 對話摘要：給接手的真人客服快速掌握前因後果。best-effort、≤4s 逾時、失敗回空字串。
  // 不在這裡 await——先把客人的「已安排專員」回覆送出，摘要由下游在送出後才 await，
  // 避免摘要的 LLM 延遲卡住客人回覆（非草稿路徑）。
  const summaryPromise = summarizeHandoffContext(history, textContent, result.handoffReason)

  // 草稿模式不對客人發話、也不鎖 session（沒承諾過客人「安排專員」），但仍通知值班客服。
  if (draftMode) {
    notifyHandoffToStaff({
      workspaceId,
      customerLineUserId: lineUserId,
      customerName: userAttributes.displayName || lineUserId,
      customerMessage: textContent,
      reason: result.handoffReason,
      summary: await summaryPromise,
    }).catch(e => console.error('[ai-fallback] notifyHandoffToStaff error:', e))
  }
  else {
    await deliverHandoffReply({
      workspaceId, lineUserId, replyToken, userAttributes, channelSecret,
      sessionId, requestOrigin,
      customerMessage: textContent,
      reason: result.handoffReason,
      // order_status：AI 查到的一般規則先送給客人，再送轉接訊息（見 answerWithAi 的 orderStatusMode）
      prefixText: result.handoffReason === 'order_status' ? result.answer : '',
      summary: summaryPromise,
    })
  }

  // 答題用的 suggestedReply：handoff 時若 AI 也有生內容（low_confidence 但有 answer），帶給真人客服參考。
  // order_status 例外——那段規則客人剛剛已經收到了（見 prefixText），再放進「AI 建議回覆」
  // 只會讓客服按下「填入回覆框」把同一段話再貼一次。
  const alreadySentToCustomer = result.handoffReason === 'order_status'
  await writeAiMeta(fsUserDocId, {
    lastDecision: 'handoff',
    lastConfidence: result.confidence,
    lastHandoffReason: result.handoffReason,
    lastQuery: textContent,
    lastSourceChunkIds: result.sources.map(s => s.chunkId),
    suggestedReply: !alreadySentToCustomer && result.decision === 'handoff' && result.answer.trim() ? result.answer : '',
    handoffSummary: await summaryPromise,
  })
}

/** writeAiMeta 的預設值：呼叫端只需指定與預設不同的欄位，避免 6 個呼叫點各自展開全部欄位 */
const AI_META_DEFAULTS: Omit<AiConversationMeta, 'updatedAt' | 'lastDecision'> = {
  lastConfidence: 0,
  lastHandoffReason: null,
  lastQuery: '',
  lastSourceChunkIds: [],
  // 預設 'kb'：沒特別標記就是走檢索生成（此時 sources 空才是真的沒依據）
  lastAnswerKind: 'kb',
  intent: '',
  collectedFields: {},
  suggestedReply: '',
  handoffSummary: '',
  lastDisambiguation: null,
}

async function writeAiMeta(
  fsUserDocId: string,
  meta: Partial<Omit<AiConversationMeta, 'updatedAt'>> & Pick<AiConversationMeta, 'lastDecision'>,
): Promise<void> {
  try {
    await getDb().collection('conversations').doc(fsUserDocId).set({
      aiMeta: { ...AI_META_DEFAULTS, ...meta, updatedAt: FieldValue.serverTimestamp() },
    }, { merge: true })
  }
  catch (e) {
    console.error('[ai-fallback] writeAiMeta failed:', e)
  }
}

export async function handlePostbackEvent(
  event: webhook.PostbackEvent,
  options: { requestOrigin?: string; workspaceId: string; dedupClaim?: Promise<boolean> },
): Promise<void> {
  console.log('[handlePostbackEvent] event received:', JSON.stringify(event).slice(0, 300))
  const userId = event.source?.userId
  if (!userId) return
  const workspaceId = String(options.workspaceId || '').trim()
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'workspaceId is required in handlePostbackEvent' })

  const postbackTs = typeof event.timestamp === 'number' ? event.timestamp : undefined
  const data = event.postback.data

  // Parse synchronously upfront so we can preload the right async data in parallel
  const trigger = parseTriggerModuleData(data)
  const messageTrigger = parseTriggerMessageData(data)
  const switchTrigger = parseSwitchMenuData(data)

  /**
   * 純切換圖文選單（不觸發模組、不送文字）＝ 客人在操作介面，不是在跟店家說話。
   * 這種事件**完全不動會話**：不建立／不喚醒 session、不寫任何對話紀錄。
   *
   * 為什麼不能像以前那樣「建 session + 記一筆 system_notice 把它移出待處理」：
   *   1. 客人只是點了一下選單，卻在對話紀錄上長出一行系統事件（客服看了也不知道要幹嘛）。
   *   2. 上次互動隔超過 24 小時時，這一下點擊會關掉舊會話、開一場空的新會話，
   *      整場只有「新會話開始」一行、狀態掛在待處理——客服完全看不出客人做了什麼。
   *   3. 那個「移出待處理」的寫入還是 fire-and-forget，Lambda 回應後容器凍結就被砍掉，
   *      等於兩頭落空：紀錄多了噪音、狀態又沒真的改到。
   * 已讀推定用的 lastPeerActivityAt 照樣更新（客人確實在線上動作）。
   *
   * 三種 postback data 前綴（triggerModule= / triggerMessage= / switchMenu=）互斥，
   * 所以「是切換選單」就等於「不是觸發模組、也不是送文字」。
   */
  const isPureMenuSwitch = Boolean(switchTrigger.targetMenuId)

  // Run all independent work in parallel upfront:
  // - credentials, session, user (always needed)
  // - module trigger: fetch flow then immediately chain hydrateRichMessageRefs
  // - message trigger: warm the auto-reply rules cache
  const flowHydrateTask: Promise<{ flow: FlowDoc | null; hydrated: any[] }> = trigger.moduleId
    ? getFlowByModuleId(trigger.moduleId).then(async (f) =>
        f
          ? { flow: f, hydrated: await hydrateRichMessageRefs(f.messages as any[]) }
          : { flow: null, hydrated: [] },
      )
    : messageTrigger.text
      ? loadActiveAutoReplyRules(workspaceId).then(() => ({ flow: null, hydrated: [] }))
      : Promise.resolve({ flow: null, hydrated: [] })

  // Dedup claim（Firestore 寫入）與預載並行；預載皆為讀取／冪等，redelivery 重跑無害。
  // 貼標／回覆等副作用都在 claim 確認之後才會發生。
  const [{ channelSecret }, sessionId, preloadedUserData, { flow: preloadedFlow, hydrated: preloadedHydrated }, isFirstDelivery] = await Promise.all([
    getLineWorkspaceCredentials(workspaceId),
    isPureMenuSwitch
      ? Promise.resolve(null)
      : ensureConversationSession(userId, workspaceId, { inboundAtMs: postbackTs }).catch((e) => {
          console.error('[session] postback session error:', e)
          return null
        }),
    ensureUser(userId, undefined, workspaceId).catch(e => {
      console.error('[ensureUser] Error:', e)
      return null
    }),
    flowHydrateTask,
    options.dedupClaim ?? Promise.resolve(true),
  ])
  if (!isFirstDelivery) {
    console.log('[webhook] duplicate postback event skipped')
    return
  }

  // 「對方最後活動」時間（供推定已讀）在確認非重送後才更新，避免 redelivery 重寫
  bumpConversationPeerActivity(userId, postbackTs, workspaceId).catch(e =>
    console.error('[conv] bump lastPeerActivityAt (postback):', e),
  )

  // shouldSuppress is a near-instant cache hit after ensureConversationSession syncs sessionStatusById
  const suppressBotAutomationPostback = sessionId
    ? await shouldSuppressInboundBotAutomationForSession(sessionId)
    : false
  if (messageTrigger.text) {
    if (messageTrigger.tagIds.length > 0) {
      addTagsToUser(lineUserFirestoreDocId(userId, workspaceId), messageTrigger.tagIds, 'system', 'postback:message', workspaceId)
        .catch(e => console.error('[tagging] message postback tagging failed:', e))
    }
    await handleIncomingText(
      userId,
      messageTrigger.text,
      event.replyToken,
      { ...options, allowAnyText: false },
      preloadedUserData,
      sessionId,
      workspaceId,
    )
    return
  }

  // Handle Switch Menu command（switchTrigger 已在最上方解析，供 isPureMenuSwitch 判斷用）
  if (switchTrigger.targetMenuId) {
    if (switchTrigger.tagIds.length > 0) {
      addTagsToUser(lineUserFirestoreDocId(userId, workspaceId), switchTrigger.tagIds, 'system', `switchMenu:${switchTrigger.targetMenuId}`, workspaceId)
        .catch(e => console.error('[tagging] switch menu tagging failed:', e))
    }
    // 切選單刻意不寫任何對話紀錄、也不動會話狀態（見上方 isPureMenuSwitch 的說明）：
    // 客人在操作介面，不是在跟店家說話。
    // 檢查是否為 LINE 原生瞬間切換（richmenuswitch）觸發的事件
    // @ts-ignore: LINE Node SDK's Event type might not perfectly reflect params yet
    const params = (event.postback as any).params
    const isRichMenuSwitch = params && params.newRichMenuAliasId

    if (isRichMenuSwitch) {
      // 若為瞬間切換，LINE App 端已自動更新選單完成，
      // 若伺服器再重複打一次 link API 反而會造成選單「閃屏重新載入」一次。
      // 所以此處直接 return 略過即可。
      console.log('[switchMenu] Handled by native richmenuswitch instantly, skipping redundant link API.')
      return
    }

    // 針對舊版 postback (沒有 aliasId) 的相容性回退處理
    const targetFirestoreId = switchTrigger.targetMenuId
    console.log('[switchMenu] Fallback to server link API, targetId:', targetFirestoreId, 'userId:', userId)
    const db = getDb()
    const targetDoc = await db.collection('richmenus').doc(targetFirestoreId).get()

    if (targetDoc.exists && targetDoc.data()?.richMenuId) {
      const lineRichMenuId = targetDoc.data()!.richMenuId
      try {
        await linkRichMenuIdToUser(userId, lineRichMenuId, workspaceId)
        console.log('[switchMenu] Fallback linkRichMenuIdToUser success')
      } catch (e) {
        console.error('[webhook] 連結圖文選單失敗:', e)
      }
    } else {
      console.warn('[switchMenu] doc not found or missing richMenuId')
    }
    return // Stop further processing
  }
  // Handle direct module trigger (flow + hydrated messages already fetched in parallel above)
  if (trigger.moduleId && !suppressBotAutomationPostback) {
    const moduleId = trigger.moduleId
    // 圖文選單觸發模組：回覆組裝／送出期間先顯示「輸入中…」給即時回饋（fire-and-forget，
    // 送出訊息即自動消失）。冷啟動的等待發生在本 handler 執行之前，動畫無法遮蓋；
    // 這裡遮的是暖實例下讀取／組裝／LINE 送出的那段延遲。
    if (event.replyToken) showLoadingAnimation(userId, workspaceId, 10).catch(() => {})
    if (trigger.tagIds.length > 0) {
      addTagsToUser(lineUserFirestoreDocId(userId, workspaceId), trigger.tagIds, 'system', `postback:${moduleId}`, workspaceId)
        .catch(e => console.error('[tagging] module postback tagging failed:', e))
    }
    const flow = preloadedFlow ?? await getFlowByModuleId(moduleId)

    if (flow) {
      if (event.replyToken) {
        const userAttributes = buildAttributeContext(preloadedUserData)
        // Use preloaded hydrated messages (fetched in parallel with session/user above)
        const hydratedMessages = preloadedFlow
          ? preloadedHydrated
          : await hydrateRichMessageRefs(flow.messages as any[])
        const lineMessages = buildLineMessages(
          hydratedMessages,
          userAttributes,
          options.requestOrigin || '',
          userId,
          channelSecret,
        )
        await replyMessage(event.replyToken, lineMessages, workspaceId)
        dispatchPostReplyActions(userId, flow.messages, workspaceId).catch(e => console.error('[postReply] dispatchPostReplyActions failed:', e))
        saveOutgoingConversationMessagesByWorkspace(userId, lineMessages, workspaceId).catch(e => console.error('[conv] save error:', e))
        enterModule(sessionId, userId, flow.moduleType ?? 'bot_flow', moduleId, workspaceId).catch(e =>
          console.error('[session] enterModule error:', e),
        )
        if (isLiveAgentModule(flow)) {
          await notifyStaffForLiveAgentModule({
            workspaceId, lineUserId: userId,
            displayName: userAttributes.displayName || '',
            customerMessage: `（客人按了「${flow.name || '真人客服'}」）`,
          })
        }
      }
    } else {
      console.warn('[webhook] triggerModule target not found or inactive:', moduleId)
      // 空按鈕：客人按了、一則訊息都沒送出。postback 不會存成訊息，沒有這筆的話
      // 客服只會看到一筆空的待處理，完全不知道發生什麼事（會話刻意留在待處理，
      // 因為客人真的什麼都沒收到；根因另有「按鈕按下去沒反應」的紅點警報）
      recordPostbackNoReply(sessionId, userId, moduleId)
    }
    return
  }

  if (trigger.moduleId && suppressBotAutomationPostback) {
    return
  }

  // Fallback: Match legacy postback data to an auto-reply keyword (if any)
  const rule = !suppressBotAutomationPostback
    ? await matchAutoReplyRule(data, workspaceId, { allowAnyText: false })
    : null
  if (rule && event.replyToken) {
    const userAttributes = buildAttributeContext(preloadedUserData)
    if (rule.action.type === 'module') {
      const flow = await getFlowByModuleId(rule.action.moduleId)
      if (flow) {
        const hydratedMessages = await hydrateRichMessageRefs(flow.messages as any[])
        const lineMessages = buildLineMessages(
          hydratedMessages,
          userAttributes,
          options.requestOrigin || '',
          userId,
          channelSecret,
        )
        await replyMessage(event.replyToken, lineMessages, workspaceId)
        dispatchPostReplyActions(userId, flow.messages, workspaceId).catch(e => console.error('[postReply] dispatchPostReplyActions failed:', e))
        saveOutgoingConversationMessagesByWorkspace(userId, lineMessages, workspaceId).catch(e => console.error('[conv] save error:', e))
        enterModule(sessionId, userId, flow.moduleType ?? 'bot_flow', rule.action.moduleId, workspaceId).catch(e =>
          console.error('[session] enterModule (fallback) error:', e),
        )
        if (isLiveAgentModule(flow)) {
          await notifyStaffForLiveAgentModule({
            workspaceId, lineUserId: userId,
            displayName: userAttributes.displayName || '',
            customerMessage: `（客人按了「${flow.name || '真人客服'}」）`,
          })
        }
      }
    } else {
      const actionMessages = buildAutoReplyActionMessages(rule.action, userAttributes)
      if (actionMessages.length > 0) {
        await replyMessage(event.replyToken, actionMessages, workspaceId)
        saveOutgoingConversationMessagesByWorkspace(userId, actionMessages, workspaceId).catch(e => console.error('[conv] save error:', e))
        // 純文字/網址回覆也是機器人真實首接（與上面的模組分支同等；先前只有模組分支有記，
        // 這條漏記會讓「按按鈕→收到一段文字」的會話誤掛在未首接）
        enterModule(sessionId, userId, 'bot_flow', undefined, workspaceId).catch(e =>
          console.error('[session] enterModule (fallback action) error:', e),
        )
      }
    }
    return
  }

  // 走到這裡＝客人按了按鈕、但沒有任何規則命中，一則訊息都沒送出。
  // 被暫停自動回覆（真人處理中）不算異常，那是刻意讓真人接手，不留這筆。
  if (!suppressBotAutomationPostback) {
    recordPostbackNoReply(sessionId, userId)
  }
}

/**
 * 記一筆「客人點了按鈕但沒有回覆送出」到時間軸。
 *
 * 為什麼需要：postback 不會像文字訊息一樣存成一則 incoming（見 handleMessageEvent），
 * 所以按鈕點擊在對話畫面上完全沒有痕跡。缺這筆時客服看到的是一筆空的待處理，
 * 無從判斷客人想幹什麼——不可行動的東西留在工作佇列只會稀釋訊號。
 *
 * sessionId 缺失就不記：這筆是給人看的線索，掛不到任何會話上就沒有意義。
 */
function recordPostbackNoReply(
  sessionId: string | null,
  userId: string,
  moduleId?: string,
): void {
  if (!sessionId) return
  recordConversationEvent(sessionId, userId, 'postback_no_reply', moduleId ? { moduleId } : undefined)
    .catch(e => console.error('[session] recordPostbackNoReply error:', e))
}

