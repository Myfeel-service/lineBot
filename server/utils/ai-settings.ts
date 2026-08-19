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

/**
 * 收斂成純 LINE userId。
 * users 的 Firestore doc id 是 {workspaceId}_{lineUserId}，若整串被存進通知名單，
 * pushMessage 會被 LINE 判成無效 userId 而靜默失敗——通知永遠不會到。
 * 純 LINE userId 不含底線，因此可安全地取最後一段來自我修正。
 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i

function normalizeLineUserId(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!s.includes('_')) return s
  const tail = s.slice(s.lastIndexOf('_') + 1)
  return LINE_USER_ID_RE.test(tail) ? tail : s
}

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
      // 保留原字串是為了 displayNames 還查得到（舊前端可能以 doc id 當 key）
      const rawIds: string[] = Array.isArray(raw?.handoffNotify?.lineUserIds)
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
        enabled: raw?.handoffNotify?.enabled === true,
        lineUserIds,
        displayNames,
        mode,
        slaRemindMinutes,
        digestHour: Math.round(clampNumber(raw?.handoffNotify?.digestHour, 0, 23, DEFAULT_DIGEST_HOUR)),
      }
    })(),
    handbackIdleMinutes: Math.round(clampNumber(raw?.handbackIdleMinutes, 0, 1440, DEFAULT_HANDBACK_IDLE_MINUTES)),
    // 下界不是 0：這是真人接手會話**唯一**的自動收尾機制，允許關閉等於放回殭屍會話那個坑
    humanSessionMaxIdleHours: Math.round(clampNumber(
      raw?.humanSessionMaxIdleHours,
      MIN_HUMAN_SESSION_MAX_IDLE_HOURS,
      MAX_HUMAN_SESSION_MAX_IDLE_HOURS,
      DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS,
    )),
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
    updatedAt: raw?.updatedAt ?? FieldValue.serverTimestamp(),
  }
}

/**
 * 更新工作區設定。會 invalidate 快取。
 */
export async function setAiSettings(
  workspaceId: string,
  partial: Partial<AiSettingsDoc>,
  db: Firestore = getDb(),
): Promise<AiSettingsDoc> {
  const current = await getAiSettings(workspaceId, db)
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
  })
  await db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId).set({
    ...merged,
    updatedAt: FieldValue.serverTimestamp(),
  })
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
