/**
 * AI 工作區設定（aiSettings）讀寫 + 60 秒 in-memory 快取。
 *
 * Doc path: aiSettings/{workspaceId}
 *   - 走 top-level + workspaceId 作 doc ID（單例）
 *   - 與 conversations、autoReplies 等其他集合的隔離模式一致
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import {
  AI_SETTINGS_DOC_ID as _AI_SETTINGS_DOC_ID_UNUSED, // 既有常數但這裡採 workspaceId 作為 ID；保留 import 避免 dead import 警告
  buildDefaultAiSettings,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_DISAMBIGUATION_COOLDOWN_MINUTES,
  DEFAULT_DISAMBIGUATION_ENABLED,
  DEFAULT_DISAMBIGUATION_MAX_OPTIONS,
  DEFAULT_DISAMBIGUATION_MAX_SPREAD,
  DEFAULT_DISAMBIGUATION_TOP1_MAX,
  DEFAULT_DISAMBIGUATION_TOP1_MIN,
  DEFAULT_DIGEST_HOUR,
  DEFAULT_DND_REPLY,
  DEFAULT_GROUNDING_SIMILARITY_THRESHOLD,
  DEFAULT_HANDBACK_IDLE_MINUTES,
  DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS,
  MIN_HUMAN_SESSION_MAX_IDLE_HOURS,
  MAX_HUMAN_SESSION_MAX_IDLE_HOURS,
  DEFAULT_MONTHLY_TOKEN_CAP,
  DEFAULT_REPLY_MAX_LEN,
  DEFAULT_SENSITIVE_TOPICS,
  DEFAULT_SLA_REMIND_MINUTES,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_INACTIVE_TAG_DAYS,
  MIN_INACTIVE_TAG_DAYS,
  MAX_INACTIVE_TAG_DAYS,
} from '~~/shared/types/ai-knowledge'
import type {
  AiSettingsDoc,
  AiAnswerModel,
  AiEmbeddingModel,
  QuotaExceedStrategy,
} from '~~/shared/types/ai-knowledge'

void _AI_SETTINGS_DOC_ID_UNUSED // 避免 unused import 警告（保留型別匯出符號的可發現性）

export const AI_SETTINGS_COLLECTION = 'aiSettings'

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { value: AiSettingsDoc; expiresAt: number }>()

export function invalidateAiSettingsCache(workspaceId: string) {
  cache.delete(workspaceId)
}

const ANSWER_MODELS: AiAnswerModel[] = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
const EMBEDDING_MODELS: AiEmbeddingModel[] = ['gemini-embedding-001']
const QUOTA_STRATEGIES: QuotaExceedStrategy[] = ['handoff_all', 'downgrade_model']

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// 名單比對（純函式）住在 shared（`C-271`⑭），這裡轉出給既有的 import。
// ⚠️ 用相對路徑：Nitro 自動匯入掃 server/utils 時解析不了 `~~` 的轉出（會警告 skip scanning）
import { normalizeLineUserId } from '../../shared/line-notify-list'

export { normalizeLineUserId, notifyListHas } from '../../shared/line-notify-list'

/**
 * 取得工作區設定。若 doc 不存在則回傳預設值（不寫入）。
 */
export async function getAiSettings(workspaceId: string, db: Firestore = getDb()): Promise<AiSettingsDoc> {
  const cached = cache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const ref = db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId)
  const snap = await ref.get()
  const defaults = buildDefaultAiSettings()
  const settings: AiSettingsDoc = snap.exists
    ? normalizeAiSettings({ ...defaults, ...(snap.data() as Partial<AiSettingsDoc>) })
    : { ...defaults, updatedAt: FieldValue.serverTimestamp() }

  cache.set(workspaceId, { value: settings, expiresAt: Date.now() + CACHE_TTL_MS })
  return settings
}

/**
 * 把外部來的 input 收斂成乾淨的 AiSettingsDoc（不含 timestamp）。
 * 任何不合法的欄位都會被預設值取代。
 */
export function normalizeAiSettings(raw: any): AiSettingsDoc {
  const answerModel = ANSWER_MODELS.includes(raw?.answerModel) ? raw.answerModel : 'gemini-2.5-flash'
  const embeddingModel = EMBEDDING_MODELS.includes(raw?.embeddingModel) ? raw.embeddingModel : 'gemini-embedding-001'
  const quotaStrategy = QUOTA_STRATEGIES.includes(raw?.quota?.onExceed) ? raw.quota.onExceed : 'handoff_all'
  const sensitiveTopics = Array.isArray(raw?.sensitiveTopics)
    ? raw.sensitiveTopics.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 200)
    : [...DEFAULT_SENSITIVE_TOPICS]

  return {
    enabled: raw?.enabled === true,
    replyMode: raw?.replyMode === 'draft' ? 'draft' : 'auto',
    answerModel,
    embeddingModel,
    confidenceThreshold: clampNumber(raw?.confidenceThreshold, 0, 1, DEFAULT_CONFIDENCE_THRESHOLD),
    groundingThreshold: clampNumber(raw?.groundingThreshold, 0, 1, DEFAULT_GROUNDING_SIMILARITY_THRESHOLD),
    systemPrompt: String(raw?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT).slice(0, 4000),
    // 這個值會被 AI 原樣發給客人（「最新價格請見 …」），沒協定的字串在 LINE 上點不開。
    // 長得像網域的自動補 https://（**不能直接清空**——normalize 在讀取時也會跑,
    // 舊租戶存過的無協定網址會被靜默歸零,下次存檔還永久落地）;完全不像網址的才存空。
    shopUrl: (() => {
      const u = String(raw?.shopUrl ?? '').trim().slice(0, 500)
      if (!u) return ''
      if (/^https?:\/\//i.test(u)) return u
      if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(u)) return `https://${u}`
      return ''
    })(),
    replyMaxLen: clampNumber(raw?.replyMaxLen, 50, 1000, DEFAULT_REPLY_MAX_LEN),
    sensitiveTopics,
    quota: {
      monthlyTokenCap: clampNumber(raw?.quota?.monthlyTokenCap, 0, 100_000_000, DEFAULT_MONTHLY_TOKEN_CAP),
      onExceed: quotaStrategy,
    },
    handoffNotify: (() => {
      /*
       * 2026-09-27 `C-270` 拿掉總開關（名單有人＝開）；`C-271`⑮ 把「舊資料怎麼讀」收在**這一處**：
       * 存著 enabled=false 的舊名單＝那些人從來沒收到過（原本每個讀的地方都先看 enabled），
       * 讀出來一律當成空名單，enabled 改成「名單有沒有人」推出來。
       * 之後讀名單的地方只看 lineUserIds 就對，⛔ 不要再各自判 enabled。
       * （寫入端 setAiSettings 不寫這三格；名單只經 member-line-bind 的交易寫。）
       */
      const listOn = raw?.handoffNotify?.enabled === true
      // 保留原字串是為了 displayNames 還查得到（舊前端可能以 doc id 當 key）
      const rawIds: string[] = listOn && Array.isArray(raw?.handoffNotify?.lineUserIds)
        ? raw.handoffNotify.lineUserIds.map((v: unknown) => String(v ?? '').trim()).filter(Boolean).slice(0, 10)
        : []
      const pairs = rawIds
        .map(original => ({ original, id: normalizeLineUserId(original) }))
        .filter(p => Boolean(p.id))
      const lineUserIds = [...new Set(pairs.map(p => p.id))]

      // 顯示名稱快取只保留還在名單上的 user,避免 doc 越長越肥
      const displayNames: Record<string, string> = {}
      const rawNames = raw?.handoffNotify?.displayNames
      if (rawNames && typeof rawNames === 'object') {
        for (const { original, id } of pairs) {
          if (displayNames[id]) continue
          const name = String(rawNames[id] ?? rawNames[original] ?? '').trim()
          if (name) displayNames[id] = name.slice(0, 100)
        }
      }
      const mode = raw?.handoffNotify?.mode === 'missed_only' ? 'missed_only' as const : 'always' as const
      let slaRemindMinutes = Math.round(clampNumber(raw?.handoffNotify?.slaRemindMinutes, 0, 1440, DEFAULT_SLA_REMIND_MINUTES))
      // missed_only 模式下超時提醒是唯一的通知路徑,設 0 等於整個靜音——強制回預設值
      if (mode === 'missed_only' && slaRemindMinutes === 0) slaRemindMinutes = DEFAULT_SLA_REMIND_MINUTES
      return {
        enabled: lineUserIds.length > 0,
        lineUserIds,
        displayNames,
        mode,
        slaRemindMinutes,
        digestHour: Math.round(clampNumber(raw?.handoffNotify?.digestHour, 0, 23, DEFAULT_DIGEST_HOUR)),
        // 舊工作區沒有這個欄位 → 視為開啟（與 imageAnswer 相反：那是「AI 會不會跟客人
        // 說話」的行為改變所以預設關，這裡只是多一段給店家自己看的提醒，漏掉才是損失）
        festivalTips: raw?.handoffNotify?.festivalTips !== false,
        // 同 festivalTips 口徑：週一的「本週顧客觀察」段落，舊工作區視為開
        weeklyInsights: raw?.handoffNotify?.weeklyInsights !== false,
        // 同 festivalTips：沒存過這個欄位的舊工作區一律視為「開」，前後端同口徑
        criticalAlertPush: raw?.handoffNotify?.criticalAlertPush !== false,
      }
    })(),
    handbackIdleMinutes: Math.round(clampNumber(raw?.handbackIdleMinutes, 0, 1440, DEFAULT_HANDBACK_IDLE_MINUTES)),
    /**
     * 0 ＝ 關閉（預設，見 DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS）：真人接手的對話只有真人
     * 自己按「結束會話」／「交還機器人」才結束。開啟時才吃 6～336 小時的範圍——
     * ⛔ 不可以把 0 一起丟進 clampNumber，那會被夾成 6 小時＝「關閉」反而變成最積極的收尾。
     */
    humanSessionMaxIdleHours: (() => {
      const raw0 = Number(raw?.humanSessionMaxIdleHours)
      if (raw0 === 0) return 0
      return Math.round(clampNumber(
        raw?.humanSessionMaxIdleHours,
        MIN_HUMAN_SESSION_MAX_IDLE_HOURS,
        MAX_HUMAN_SESSION_MAX_IDLE_HOURS,
        DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS,
      ))
    })(),
    disambiguation: (() => {
      let top1Min = clampNumber(raw?.disambiguation?.top1Min, 0, 1, DEFAULT_DISAMBIGUATION_TOP1_MIN)
      let top1Max = clampNumber(raw?.disambiguation?.top1Max, 0, 1, DEFAULT_DISAMBIGUATION_TOP1_MAX)
      // 防呆：若使用者把 min/max 設反了，自動交換，避免條件 `min <= x < max` 永遠不成立
      if (top1Min > top1Max) [top1Min, top1Max] = [top1Max, top1Min]
      return {
        enabled: typeof raw?.disambiguation?.enabled === 'boolean' ? raw.disambiguation.enabled : DEFAULT_DISAMBIGUATION_ENABLED,
        top1Min,
        top1Max,
        // 上限 0.3 與前端 slider 一致：spread 是「前兩張卡分數差」，>0.3 沒有實務意義
        maxSpread: clampNumber(raw?.disambiguation?.maxSpread, 0, 0.3, DEFAULT_DISAMBIGUATION_MAX_SPREAD),
        // 上限 10：對齊 LINE Quick Reply 慣例（MAX_QUICK_REPLY_OPTIONS；反問另加 1 顆「找真人」仍 ≤ 13 硬限）
        maxOptions: Math.round(clampNumber(raw?.disambiguation?.maxOptions, 2, 10, DEFAULT_DISAMBIGUATION_MAX_OPTIONS)),
        cooldownMinutes: Math.round(clampNumber(raw?.disambiguation?.cooldownMinutes, 0, 1440, DEFAULT_DISAMBIGUATION_COOLDOWN_MINUTES)),
      }
    })(),
    // 舊工作區沒有這個欄位 → 一律視為關閉（不能讓「升級後 AI 突然開始跟客人談照片」發生）
    imageAnswer: { enabled: raw?.imageAnswer?.enabled === true },
    serviceHours: (() => {
      const sh = raw?.serviceHours
      // "HH:mm" 驗證：格式不合就退回預設,避免壞值讓 isServiceHoursDnd 判錯
      const validHHmm = (v: unknown, fallback: string) =>
        (typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim())) ? v.trim() : fallback
      const reply = typeof sh?.dndReply === 'string' && sh.dndReply.trim() ? sh.dndReply.trim().slice(0, 500) : DEFAULT_DND_REPLY
      return {
        enabled: sh?.enabled === true,
        start: validHHmm(sh?.start, '09:00'),
        end: validHHmm(sh?.end, '18:00'),
        weekendOff: typeof sh?.weekendOff === 'boolean' ? sh.weekendOff : true,
        dndReply: reply,
      }
    })(),
    // 舊工作區沒有這個欄位 → 視為開啟（同 festivalTips 的口徑：它不對客人說話，
    // 只是後台自動貼一個分眾標籤，漏掉才是損失；判斷欄位 08-19 起才有＝天生漸進）
    inactiveTag: {
      enabled: raw?.inactiveTag?.enabled !== false,
      days: Math.round(clampNumber(raw?.inactiveTag?.days, MIN_INACTIVE_TAG_DAYS, MAX_INACTIVE_TAG_DAYS, DEFAULT_INACTIVE_TAG_DAYS)),
    },
    // 舊工作區沒有這個欄位 → 一律視為關閉（每場對話一次 LLM 費用，同 imageAnswer 口徑）
    autoTagSuggest: { enabled: raw?.autoTagSuggest?.enabled === true },
    updatedAt: raw?.updatedAt ?? FieldValue.serverTimestamp(),
  }
}

/**
 * 讀**不經快取**的設定（不動共用快取）。
 * 快取是每台機器各一份、60 秒：拿它來「讀現值→合併→寫回」會把別台剛寫進去的東西蓋掉；
 * 拿它來輪詢又會一直是舊的。⛔ 這支也不清快取——清了等於讓這台的送訊息熱路徑每次都重讀
 * （`C-271`⑫：掃 QR 等待時每 2.5 秒問一次，原本每問一次就清一次）。
 */
export async function readAiSettingsFresh(workspaceId: string, db: Firestore = getDb()): Promise<AiSettingsDoc> {
  const snap = await db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId).get()
  const defaults = buildDefaultAiSettings()
  // 跟 getAiSettings 同一個形狀（沒有文件＝出廠預設）
  return snap.exists
    ? normalizeAiSettings({ ...defaults, ...(snap.data() as Partial<AiSettingsDoc>) })
    : { ...defaults, updatedAt: FieldValue.serverTimestamp() }
}

/**
 * 更新工作區設定。會 invalidate 快取。
 *
 * ⚠️ 2026-09-27 `C-271`① 兩處改法：
 * - 現值改讀**不經快取**的那一份（原本讀這台機器 60 秒快取裡的舊設定，整份寫回）
 * - ⛔ **LINE 通知名單三格（lineUserIds／displayNames／enabled）不從這裡寫**，而且改用 merge：
 *   名單只經 `member-line-bind` 的交易進出（掃 QR 綁定是 webhook 在另一台機器寫的）。
 *   原本整份 set，管理員剛好在另一台按「儲存 AI 設定」（或小幫手改提醒分鐘、操作紀錄「還原」），
 *   就把剛綁好的人洗掉，而他手機已經收到「好了 ✓」。
 */
export async function setAiSettings(
  workspaceId: string,
  partial: Partial<AiSettingsDoc>,
  db: Firestore = getDb(),
): Promise<AiSettingsDoc> {
  const current = await readAiSettingsFresh(workspaceId, db)
  const merged = normalizeAiSettings({
    ...current,
    ...partial,
    quota: { ...current.quota, ...(partial.quota ?? {}) },
    handoffNotify: { ...current.handoffNotify, ...(partial.handoffNotify ?? {}) },
    // 深合併：partial 只帶部分子欄位（如 { enabled }）時，其餘門檻要保留工作區現值,
    // 否則 normalize 會把缺欄位重設回出廠預設（top1Min 0.65 事故的同型結構）
    disambiguation: { ...current.disambiguation, ...(partial.disambiguation ?? {}) },
    imageAnswer: { ...current.imageAnswer, ...(partial.imageAnswer ?? {}) },
    serviceHours: { ...current.serviceHours, ...(partial.serviceHours ?? {}) },
    inactiveTag: { ...current.inactiveTag, ...(partial.inactiveTag ?? {}) },
    autoTagSuggest: { ...current.autoTagSuggest, ...(partial.autoTagSuggest ?? {}) },
  })
  const { lineUserIds: _ids, displayNames: _names, enabled: _enabled, ...notifyTiming } = merged.handoffNotify
  await db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId).set({
    ...merged,
    handoffNotify: notifyTiming,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
  invalidateAiSettingsCache(workspaceId)
  return getAiSettings(workspaceId, db)
}

/**
 * Grounding threshold：優先用 settings.groundingThreshold；沒傳 settings 時回退到全域常數。
 * 留著 0-arg 形式以保留現有 caller 行為，但建議在有 settings 的地方直接讀 settings.groundingThreshold。
 */
export function getGroundingThreshold(settings?: Pick<AiSettingsDoc, 'groundingThreshold'>): number {
  if (settings && Number.isFinite(settings.groundingThreshold)) {
    return Math.min(1, Math.max(0, settings.groundingThreshold))
  }
  return DEFAULT_GROUNDING_SIMILARITY_THRESHOLD
}
