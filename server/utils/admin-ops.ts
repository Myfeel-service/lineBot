/**
 * 小幫手「代你操作」的操作模組表（`C-31` Phase 2）。
 *
 * 一個 op 走四段：**收斂參數 → 預覽（讀，不寫）→ 人按確定 → 執行一次**。
 *
 * 鐵律（沿用一鍵修 `alert-fix-ops.ts` 與評估報告 §3.4，踩過的坑不再踩）：
 * - 模型只提議、永遠不執行：執行發生在第二個請求，而且要帶得出簽章憑證。
 * - 模型不生 ID：參數只收「人講得出來的東西」（流程名字、時間），
 *   名字 → 文件 id 的比對在後端做；對不到就列出可選清單讓它反問，⛔不猜最接近的那個。
 * - 收斂（normalize）與驗證分離，錯誤訊息是給人看的白話——它會被原樣講給使用者聽。
 * - 執行是冪等的單次動作：失敗不自動重試、不把錯誤餵回模型讓它再寫一次。
 * - 只動該動的那一格（⛔整包覆蓋是這個 repo 出過事的寫法）。
 * - 每次執行寫 `auditLogs`，`actor='agent'`——這是「AI 動過手」唯一查得到的地方。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { serviceHoursSentence, type ServiceHoursLike } from '~~/shared/time'
import {
  previewScriptToggleImpact,
  toReachabilityScriptsWithDisabled,
} from '~~/shared/types/ai-script-reachability'
import type { Capability } from '~~/shared/permissions'
import {
  ADMIN_OP_LABELS,
  ADMIN_OP_RISK,
  adminOpAuditAction,
  type AdminOpId,
  type AdminOpPreview,
  type AdminOpResult,
} from '~~/shared/types/admin-ops'
import { Timestamp } from 'firebase-admin/firestore'
import { describeScriptSteps } from '~~/shared/script-plain-summary'
import { writeAuditLog } from './audit-log'
import { getAiSettings, setAiSettings } from './ai-settings'
import { SCRIPTS_COLLECTION } from './ai-scripts'
import { invalidateScriptHealthCache } from './script-health'
import { AI_FEEDBACK_EVENTS_COLLECTION } from './ai-feedback-events'
import { getCurrentMonthUsageCounts, recordAiUsage } from './ai-usage'
import { generateScriptDraft } from './ai-script-generate'

export interface AdminOpCtx {
  db: Firestore
  workspaceId: string
  uid: string
  /**
   * 呼叫者的 Authorization header：要走既有端點的 op 用（權限與驗證由那支端點自己把關，
   * 口徑零第二份）。與 `alert-fix-ops` 同一招。
   */
  authHeader?: string
}

/**
 * 參數不合格／東西找不到時丟這個：訊息會**原樣**回給模型，讓它照著反問使用者。
 * ⛔ 所以訊息一律寫成「人看得懂、且指得出下一步」的句子，不要寫 stack 或欄位名。
 */
export class AdminOpUserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdminOpUserError'
  }
}

export interface AdminOpDef {
  /** 執行門檻：掛既有 capability 表，⛔不在這裡另外訂一套角色 */
  capability: Capability
  /** 給模型的參數說明（會灌進 prompt，所以要寫得像講給人聽的） */
  argsHint: string
  /**
   * 哪些參數是**自由文字**（會變成客人看得到的內容、或變成設定的內容）。
   *
   * 這些欄位會被檢查來源：一字不差地出現在「剛查到的資料」裡、卻不在使用者自己講的話裡
   * → 擋下來。⛔ 這是機制，不是 prompt 的請求——查到的資料是別人寫的，
   * 裡面塞一句話就讓小幫手照抄出去，是這條路上唯一會真的傷到客人的攻擊。
   */
  freeTextFields?: string[]
  /** 收斂＋驗證：吐出正規化後的參數，或一句要使用者補充的話 */
  normalize: (raw: Record<string, unknown>) => Record<string, unknown>
  /**
   * 選填：提議前先把「要做的東西」準備好，**回傳的參數就是之後真的會執行的那一份**。
   *
   * 為什麼需要：AI 生出來的內容（例如一整條客服流程）每次生都不一樣。
   * 如果執行時才重生，使用者按確定同意的，跟系統實際建出來的就是兩份東西——
   * 那樣確認流等於沒有。所以生成只發生一次，結果跟著憑證走。
   */
  prepare?: (ctx: AdminOpCtx, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** 現況指紋：提議當下與按下確定前各算一次，不同就代表世界變了 */
  fingerprint: (ctx: AdminOpCtx, args: Record<string, unknown>) => Promise<string>
  preview: (ctx: AdminOpCtx, args: Record<string, unknown>) => Promise<AdminOpPreview>
  execute: (ctx: AdminOpCtx, args: Record<string, unknown>) => Promise<AdminOpResult>
}

// ── 共用小工具 ──────────────────────────────────────────────────

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

function hhmm(raw: unknown, what: string): string {
  const v = String(raw ?? '').trim()
  if (!HHMM_RE.test(v))
    throw new AdminOpUserError(`${what}要寫成 24 小時制的「時:分」，例如 09:00 或 22:30。`)
  // "9:00" → "09:00"：跟設定畫面顯示的一致
  const [h, m] = v.split(':')
  return `${String(h).padStart(2, '0')}:${m}`
}

/** 服務時間 → 勿擾時段的白話（兩者是補集，講給人聽時要一起講，免得對不上） */
function dndSentence(sh: ServiceHoursLike): string {
  if (!sh.enabled) return '目前沒有勿擾時段（任何時間找真人都會通知）'
  const weekend = sh.weekendOff ? '，以及週六、週日整天' : ''
  return `${sh.end}–${sh.start}${weekend}`
}

function serviceSentence(sh: ServiceHoursLike): string {
  return serviceHoursSentence(sh) ?? '沒有設定（全天都算服務中）'
}

// ── op①：服務時間／勿擾時段 ─────────────────────────────────────

interface ServiceHoursArgs {
  enabled: boolean
  start?: string
  end?: string
  weekendOff?: boolean
}

const aiSettingsServiceHours: AdminOpDef = {
  capability: 'ai.settings.write',
  argsHint: '參數：{"mode":"service"|"dnd","start":"HH:mm","end":"HH:mm","weekendOff":true|false} '
    + '或關掉整個功能用 {"enabled":false}。'
    + '⛔ mode 一定要照使用者的原話選：他講「服務時間 9 點到 6 點」→ mode="service"；'
    + '講「晚上 10 點到早上 8 點不要吵我」→ mode="dnd"。'
    + '⛔ 你不要自己換算兩者，系統會換（換錯會把上下班時間顛倒）。'
    + 'weekendOff 只有使用者明確提到週末時才帶。',

  normalize(raw) {
    if (raw?.enabled === false) return { enabled: false } satisfies ServiceHoursArgs

    const mode = String(raw?.mode ?? '').trim()
    if (mode !== 'service' && mode !== 'dnd') {
      throw new AdminOpUserError(
        '要先確認他講的是「服務時間」（這段時間內找真人會通知）還是「勿擾時段」（這段時間不要被打擾），請問清楚再說一次。',
      )
    }
    const a = hhmm(raw?.start, '開始時間')
    const b = hhmm(raw?.end, '結束時間')
    if (a === b)
      throw new AdminOpUserError('開始和結束是同一個時間，這樣看不出來要服務多久——請確認正確的起迄時間。')

    // 勿擾時段 → 服務時間是「補集」：不要求模型換算（它會顛倒），在這裡算。
    const start = mode === 'dnd' ? b : a
    const end = mode === 'dnd' ? a : b

    const args: ServiceHoursArgs = { enabled: true, start, end }
    if (typeof raw?.weekendOff === 'boolean') args.weekendOff = raw.weekendOff
    return args as unknown as Record<string, unknown>
  },

  async fingerprint(ctx) {
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    return JSON.stringify(s.serviceHours ?? null)
  },

  async preview(ctx, raw) {
    const args = raw as unknown as ServiceHoursArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = s.serviceHours as ServiceHoursLike

    if (!args.enabled) {
      if (!before?.enabled) {
        return {
          opId: 'ai-settings-service-hours',
          summary: '勿擾時段本來就是關的，不用改。',
          items: [],
          confirmLabel: '知道了',
          noop: true,
        }
      }
      return {
        opId: 'ai-settings-service-hours',
        summary: '我會把勿擾時段整個關掉：以後不分時間，客人要找真人都會立刻通知你們。',
        items: [{ label: serviceSentence(before), note: '現在的服務時間' }],
        warning: '關掉之後，半夜有人找真人也會通知——確定要全天候接嗎？',
        confirmLabel: '確定關掉',
      }
    }

    const after: ServiceHoursLike = {
      enabled: true,
      start: args.start!,
      end: args.end!,
      weekendOff: args.weekendOff ?? before?.weekendOff ?? true,
    }
    return {
      opId: 'ai-settings-service-hours',
      summary: '我會把服務時間改成下面這樣（勿擾時段就是服務時間以外的那段）。',
      items: [
        { label: serviceSentence(before), note: `現在（勿擾：${dndSentence(before)}）` },
        { label: serviceSentence(after), note: `改成（勿擾：${dndSentence(after)}）` },
      ],
      // 老闆最在意的是「客人會怎樣」：這裡講清楚它只管找真人這條路
      warning: '這只影響「客人要找真人」的時候——勿擾時段內他會先收到一句稍後回覆的訊息，你們不會被叫醒。AI 該回答的問題照常回答。',
      confirmLabel: '確定改時間',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as ServiceHoursArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = s.serviceHours as ServiceHoursLike

    if (!args.enabled && !before?.enabled)
      return { ok: true, message: '勿擾時段本來就是關的，沒有動任何設定。' }

    const after: ServiceHoursLike = args.enabled
      ? {
          enabled: true,
          start: args.start!,
          end: args.end!,
          weekendOff: args.weekendOff ?? before?.weekendOff ?? true,
        }
      : { ...before, enabled: false }

    // 只帶這一格：setAiSettings 是「讀現值再深合併」，其他設定原封不動
    await setAiSettings(ctx.workspaceId, { serviceHours: after } as never, ctx.db)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('ai-settings-service-hours'),
      before: { serviceHours: before },
      after: { serviceHours: after },
    }, ctx.db)

    return {
      ok: true,
      message: after.enabled
        ? `改好了：服務時間 ${serviceSentence(after)}；勿擾時段是 ${dndSentence(after)}。`
        : '已經把勿擾時段關掉，現在任何時間客人找真人都會通知。',
    }
  },
}

// ── op②：自動回應上架／下架 ─────────────────────────────────────

interface ScriptEnabledArgs { name: string, enabled: boolean }

interface ScriptRow {
  id: string
  name: string
  enabled: boolean
  keywords: string[]
  matchMode: string
}

function readScriptRow(id: string, data: Record<string, any>): ScriptRow {
  const nodes: any[] = Array.isArray(data.nodes) ? data.nodes : []
  const trigger = nodes.find(n => n?.id === data.rootNodeId) ?? nodes.find(n => n?.type === 'trigger')
  return {
    id,
    name: String(data.name || '(未命名流程)'),
    enabled: data.enabled === true,
    keywords: Array.isArray(trigger?.keywords) ? trigger.keywords.map(String) : [],
    matchMode: String(trigger?.matchMode ?? 'keyword'),
  }
}

/** 撈這個工作區全部的流程（含停用的——上下架預覽要拿它算影響） */
async function listScriptDocs(ctx: AdminOpCtx): Promise<Record<string, any>[]> {
  const snap = await ctx.db.collection(SCRIPTS_COLLECTION)
    .where('workspaceId', '==', ctx.workspaceId)
    .get()
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Record<string, any>) }))
}

/**
 * 名字 → 流程。⛔ 模型不生 ID，也⛔不猜「最接近的那一條」：
 * 對不到就把現有名字列出來讓它反問，撞名就要求講得更清楚。
 */
async function resolveScript(ctx: AdminOpCtx, name: string, docs?: Record<string, any>[]): Promise<ScriptRow> {
  const raw = docs ?? await listScriptDocs(ctx)
  const rows = raw.map(d => readScriptRow(String(d.id), d))
  const want = name.trim().toLowerCase()
  const hits = rows.filter(r => r.name.trim().toLowerCase() === want)

  if (hits.length === 1) return hits[0]!
  if (hits.length > 1)
    throw new AdminOpUserError(`有 ${hits.length} 條自動回應都叫「${name}」，我沒辦法確定是哪一條——請他到自動回應頁改掉其中一個名字，或直接在頁面上操作。`)

  const names = rows.map(r => `「${r.name}」`).slice(0, 8).join('、')
  throw new AdminOpUserError(
    rows.length
      ? `找不到叫「${name}」的自動回應。目前有：${names}${rows.length > 8 ? ` 等 ${rows.length} 條` : ''}。請確認是哪一條。`
      : '這個工作區還沒有任何自動回應可以上下架。',
  )
}

const scriptSetEnabled: AdminOpDef = {
  capability: 'scripts.write',
  argsHint: '參數：{"name":"自動回應的名字","enabled":true|false}。'
    + 'name 必須是清單上**一字不差**的名字（先用 list_auto_responses 或 list_scripts 查，⛔不要自己拼）；'
    + 'enabled=true 是上架（開始生效）、false 是下架（停用）。',

  normalize(raw) {
    const name = String(raw?.name ?? '').trim().slice(0, 100)
    if (!name)
      throw new AdminOpUserError('要先問清楚是哪一條自動回應（可以先列出清單讓他挑）。')
    if (typeof raw?.enabled !== 'boolean')
      throw new AdminOpUserError('要問清楚是要「開始使用」還是「停用」這條自動回應。')
    return { name, enabled: raw.enabled } satisfies ScriptEnabledArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx, raw) {
    const args = raw as unknown as ScriptEnabledArgs
    const row = await resolveScript(ctx, args.name)
    return `${row.id}:${row.enabled}`
  },

  async preview(ctx, raw) {
    const args = raw as unknown as ScriptEnabledArgs
    const docs = await listScriptDocs(ctx)
    const row = await resolveScript(ctx, args.name, docs)
    const base = { opId: 'script-set-enabled' as const }

    if (row.enabled === args.enabled) {
      return {
        ...base,
        summary: `「${row.name}」現在已經是${args.enabled ? '啟用中' : '停用'}的狀態了，不用改。`,
        items: [],
        confirmLabel: '知道了',
        noop: true,
      }
    }

    const trigger = row.keywords.length
      ? `客人打「${row.keywords.slice(0, 6).join('、')}」${row.keywords.length > 6 ? ' 等字' : ''}會走這條`
      : row.matchMode === 'anyText'
        ? '客人不管打什麼都會走這條'
        : '（這條沒有設定觸發字）'

    // 真正的影響常常不在這條身上，在**別條**身上：新開的這條可能把另一條的觸發詞整個包住。
    // 拿異常中心同一支分析器跑「改之前／改之後」比出來，⛔不另寫一套判定。
    const settings = await getAiSettings(ctx.workspaceId, ctx.db).catch(() => null)
    const impact = previewScriptToggleImpact(
      toReachabilityScriptsWithDisabled(docs),
      { id: row.id, enabled: args.enabled },
      { sensitiveTopics: settings?.sensitiveTopics ?? [] },
    )

    const items = [
      { label: row.name, note: row.enabled ? '現在：啟用中' : '現在：已停用' },
      { label: trigger, note: '觸發方式' },
      // 「開了等於沒開」比任何影響都該先講
      ...(impact.selfStillBlocked ? [{ label: '⚠️ 開了也還是輪不到', note: impact.selfStillBlocked.detail }] : []),
      ...impact.newlyBlocked.map(i => ({ label: `「${i.scriptName}」會被蓋掉`, note: i.detail })),
      ...impact.newlyFreed.map(i => ({ label: `「${i.scriptName}」會恢復作用`, note: i.detail })),
    ]

    return {
      ...base,
      summary: args.enabled
        ? `我會把「${row.name}」上架，之後它就會開始接客人的訊息。`
        : `我會把「${row.name}」下架，它就不再接客人的訊息（內容都留著，隨時可以再開回來）。`,
      items,
      warning: args.enabled
        ? '上架之後，打中這些字的客人會走這條流程，AI 不會再回答那幾句話。'
        : '下架之後，這條原本回覆的內容客人就收不到了；那些訊息會改由 AI 或其他設定接手。',
      confirmLabel: args.enabled ? '確定上架' : '確定下架',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as ScriptEnabledArgs
    const row = await resolveScript(ctx, args.name)
    if (row.enabled === args.enabled)
      return { ok: true, message: `「${row.name}」本來就是${args.enabled ? '啟用中' : '停用'}，沒有動任何設定。` }

    // ⛔ 只動 enabled 這一格：整份覆寫會把別人剛編輯的步驟洗掉（這個 repo 出過事）
    await ctx.db.collection(SCRIPTS_COLLECTION).doc(row.id).update({
      enabled: args.enabled,
      updatedAt: FieldValue.serverTimestamp(),
    })
    // 健康狀態有 5 分鐘快取，不戳掉的話畫面會有一段時間顯示改之前的世界
    invalidateScriptHealthCache(ctx.workspaceId)

    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('script-set-enabled'),
      targetId: row.id,
      before: { enabled: row.enabled },
      after: { enabled: args.enabled },
      note: `「${row.name}」${args.enabled ? '上架' : '下架'}`,
    }, ctx.db)

    return {
      ok: true,
      message: args.enabled
        ? `「${row.name}」已經上架，開始生效了。`
        : `「${row.name}」已經下架，客人不會再走到它（內容都還在）。`,
    }
  },
}

// ── op③：客人等太久的提醒時間 ───────────────────────────────────

interface HandoffSlaArgs { minutes: number }

const aiSettingsHandoffSla: AdminOpDef = {
  capability: 'ai.settings.write',
  argsHint: '參數：{"minutes":30}＝客人被轉給真人後等超過幾分鐘要提醒客服；'
    + '{"minutes":0}＝不要提醒。⛔ 使用者沒講數字就先問，不要自己填一個。',

  normalize(raw) {
    const n = Number(raw?.minutes)
    if (!Number.isFinite(n))
      throw new AdminOpUserError('要先問清楚「等幾分鐘」要提醒（或說不用提醒）。')
    const minutes = Math.round(n)
    if (minutes < 0 || minutes > 1440)
      throw new AdminOpUserError('提醒時間只能設 0 到 1440 分鐘（也就是一天以內）；0 代表不提醒。')
    return { minutes } satisfies HandoffSlaArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx) {
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    return String(s.handoffNotify?.slaRemindMinutes ?? 0)
  },

  async preview(ctx, raw) {
    const args = raw as unknown as HandoffSlaArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = Number(s.handoffNotify?.slaRemindMinutes ?? 0)
    const say = (m: number) => (m > 0 ? `等超過 ${m} 分鐘就提醒` : '不提醒')
    const base = { opId: 'ai-settings-handoff-sla' as const }

    if (before === args.minutes) {
      return { ...base, summary: `現在就是「${say(before)}」，不用改。`, items: [], confirmLabel: '知道了', noop: true }
    }
    return {
      ...base,
      summary: '我會改「客人被轉給真人之後，等多久還沒人回就提醒客服」。',
      items: [
        { label: say(before), note: '現在' },
        { label: say(args.minutes), note: '改成' },
      ],
      // 通知本身沒開的話，改這個數字不會有任何效果——這種「改了也沒用」要當場講
      warning: s.handoffNotify?.enabled === true
        ? '這只影響你們這邊收到的提醒，客人不會收到任何東西。'
        : '⚠️ 目前「轉真人通知」是關的，所以改了這個數字也不會有人被提醒——要先把通知打開。',
      confirmLabel: '確定改提醒時間',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as HandoffSlaArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = Number(s.handoffNotify?.slaRemindMinutes ?? 0)
    if (before === args.minutes)
      return { ok: true, message: `本來就是這個設定，沒有動任何東西。` }

    // 只帶這一格：handoffNotify 是深合併，收件人名單與開關原封不動
    await setAiSettings(ctx.workspaceId, { handoffNotify: { slaRemindMinutes: args.minutes } } as never, ctx.db)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('ai-settings-handoff-sla'),
      before: { slaRemindMinutes: before },
      after: { slaRemindMinutes: args.minutes },
    }, ctx.db)

    return {
      ok: true,
      message: args.minutes > 0
        ? `改好了：客人等超過 ${args.minutes} 分鐘還沒人回，就會提醒客服。`
        : '改好了：不再發等太久的提醒。',
    }
  },
}

// ── op④：一提到就轉真人的字 ─────────────────────────────────────

interface SensitiveTopicArgs { action: 'add' | 'remove', word: string }

const aiSettingsSensitiveTopic: AdminOpDef = {
  capability: 'ai.settings.write',
  freeTextFields: ['word'],
  argsHint: '參數：{"action":"add"|"remove","word":"退款"}。'
    + 'add＝客人一提到這個字就直接轉真人（AI 不回答）；remove＝把這個字拿掉。'
    + '⛔ 一次只處理一個字；使用者一次講好幾個就分次提議。',

  normalize(raw) {
    const action = String(raw?.action ?? '').trim()
    if (action !== 'add' && action !== 'remove')
      throw new AdminOpUserError('要問清楚是要「加一個字」還是「拿掉一個字」。')
    const word = String(raw?.word ?? '').trim().slice(0, 30)
    if (!word)
      throw new AdminOpUserError('要問清楚是哪一個字或詞。')
    return { action, word } satisfies SensitiveTopicArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx) {
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    return JSON.stringify(s.sensitiveTopics ?? [])
  },

  async preview(ctx, raw) {
    const args = raw as unknown as SensitiveTopicArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const list = (s.sensitiveTopics ?? []).map(String)
    const has = list.some(w => w.trim().toLowerCase() === args.word.toLowerCase())
    const base = { opId: 'ai-settings-sensitive-topic' as const }

    if (args.action === 'add' && has)
      return { ...base, summary: `「${args.word}」已經在清單裡了，不用再加。`, items: [], confirmLabel: '知道了', noop: true }
    if (args.action === 'remove' && !has)
      return { ...base, summary: `清單裡沒有「${args.word}」，沒有東西要拿掉。`, items: [], confirmLabel: '知道了', noop: true }

    return {
      ...base,
      summary: args.action === 'add'
        ? `我會把「${args.word}」加進「一提到就轉真人」的清單。`
        : `我會把「${args.word}」從「一提到就轉真人」的清單拿掉。`,
      items: [
        { label: list.length ? list.join('、') : '（目前是空的）', note: '現在的清單' },
        { label: `共 ${list.length} 個字`, note: args.action === 'add' ? `加完會變成 ${list.length + 1} 個` : `拿掉會變成 ${list.length - 1} 個` },
      ],
      // 加字是往保守的方向動、拿掉字是放寬——兩者的後果完全不同，⛔不能用同一句話帶過
      warning: args.action === 'add'
        ? `加了之後，客人只要講到「${args.word}」就會直接轉給真人，AI 不會先回答（連問清楚都不會）。`
        : `⚠️ 拿掉之後，客人講到「${args.word}」時 AI 會自己回答，不再自動轉給真人。`,
      confirmLabel: args.action === 'add' ? '確定加進去' : '確定拿掉',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as SensitiveTopicArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const list = (s.sensitiveTopics ?? []).map(String)
    const has = list.some(w => w.trim().toLowerCase() === args.word.toLowerCase())

    if (args.action === 'add' && has) return { ok: true, message: `「${args.word}」本來就在清單裡，沒有動任何設定。` }
    if (args.action === 'remove' && !has) return { ok: true, message: `清單裡本來就沒有「${args.word}」，沒有動任何設定。` }

    // 陣列是整份取代（不是深合併）：先讀現值再寫回完整清單，⛔不可以只丟一個新字進去
    const after = args.action === 'add'
      ? [...list, args.word]
      : list.filter(w => w.trim().toLowerCase() !== args.word.toLowerCase())

    await setAiSettings(ctx.workspaceId, { sensitiveTopics: after } as never, ctx.db)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('ai-settings-sensitive-topic'),
      before: { sensitiveTopics: list },
      after: { sensitiveTopics: after },
      note: `${args.action === 'add' ? '加入' : '移除'}「${args.word}」`,
    }, ctx.db)

    return {
      ok: true,
      message: args.action === 'add'
        ? `加好了：客人提到「${args.word}」就會直接轉給真人。`
        : `拿掉了：客人提到「${args.word}」時，AI 會照常回答。`,
    }
  },
}

// ── op⑤：AI 直接回客人／只給草稿 ────────────────────────────────
//
// ⚠️ 這一格是整個產品裡一按下去影響最大的設定：改成自動之後，**所有**客人的訊息
//    AI 會直接回，人不會先看到。2026-08-14 的紅線是「對客人說話，最後一顆按鈕永遠留給人」，
//    而這裡的最後一顆按鈕仍然是人按的（提議 → 確認卡 → 人按確定），所以不牴觸。
// ⭐ 2026-09-16 老闆拍板（`D-80` 選 C）：兩個方向都開放，但確認卡必須先秀出 AI 最近的表現，
//    確認鈕字樣要把後果寫在按鈕上。⛔ 這是老闆拍的，工程不得自行擴大到別的設定。

interface ReplyModeArgs { mode: 'auto' | 'draft' }

/** AI 最近表現：給確認卡用的一句話（拿既有的月用量桶，⛔不另算一把尺） */
async function recentAiPerformance(ctx: AdminOpCtx): Promise<string> {
  const counts = await getCurrentMonthUsageCounts(ctx.workspaceId, ctx.db).catch(() => null)
  if (!counts) return '這次查不到 AI 最近的表現（查不到不代表沒問題）'

  // 最近 7 天被客服標「答錯」的次數：吃既有索引（workspaceId＋createdAt），
  // 上限 100 筆；超過上限要說「至少」，⛔不可以報一個看起來很精確的假數字
  const since = Timestamp.fromMillis(Date.now() - 7 * 86400_000)
  let wrong = 0
  let truncated = false
  try {
    const snap = await ctx.db.collection(AI_FEEDBACK_EVENTS_COLLECTION)
      .where('workspaceId', '==', ctx.workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get()
    truncated = snap.size >= 100
    for (const d of snap.docs) {
      const data = d.data() as { type?: string, createdAt?: { toMillis?: () => number } }
      if (data.type !== 'wrong_answer') continue
      const ms = data.createdAt?.toMillis?.() ?? 0
      if (ms >= since.toMillis()) wrong++
    }
  }
  catch {
    return `這個月 AI 被叫了 ${counts.invocations} 次、自己答完 ${counts.answered} 次（答錯標記這次查不到）`
  }

  const wrongText = wrong === 0
    ? '最近 7 天沒有人標過它答錯'
    : `最近 7 天有${truncated ? '至少 ' : ' '}${wrong} 次被客服標「答錯」`
  return `這個月 AI 被叫了 ${counts.invocations} 次、自己答完 ${counts.answered} 次；${wrongText}`
}

const aiSettingsReplyMode: AdminOpDef = {
  capability: 'ai.settings.write',
  argsHint: '參數：{"mode":"auto"}＝AI 直接回客人；{"mode":"draft"}＝AI 只給客服建議草稿、客人收不到。'
    + '⛔ 使用者沒講清楚要哪一種就先問，這一格改錯所有客人都會受影響。',

  normalize(raw) {
    const mode = String(raw?.mode ?? '').trim()
    if (mode !== 'auto' && mode !== 'draft')
      throw new AdminOpUserError('要問清楚是要「AI 直接回客人」還是「只給客服草稿、不回客人」。')
    return { mode } satisfies ReplyModeArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx) {
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    return String(s.replyMode ?? 'draft')
  },

  async preview(ctx, raw) {
    const args = raw as unknown as ReplyModeArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = String(s.replyMode ?? 'draft')
    const say = (m: string) => (m === 'auto' ? 'AI 直接回客人' : 'AI 只給客服草稿（客人收不到）')
    const base = { opId: 'ai-settings-reply-mode' as const }

    if (before === args.mode)
      return { ...base, summary: `現在就是「${say(before)}」，不用改。`, items: [], confirmLabel: '知道了', noop: true }

    const perf = await recentAiPerformance(ctx)
    return {
      ...base,
      summary: args.mode === 'auto'
        ? '我會把 AI 改成**直接回客人**。這是影響最大的一個設定，先看一下它最近的表現再決定。'
        : '我會把 AI 改回**只給草稿**：之後客人的訊息一律等真人回，AI 只在旁邊給建議。',
      items: [
        { label: say(before), note: '現在' },
        { label: say(args.mode), note: '改成' },
        { label: perf, note: 'AI 最近的表現' },
        ...(s.enabled === false ? [{ label: 'AI 目前整個是關的', note: '改了這一格也不會有動作，要先把 AI 打開' }] : []),
      ],
      warning: args.mode === 'auto'
        ? '⚠️ 按下去之後，客人傳來的訊息 AI 會直接回覆，你不會先看到——包括它答錯的那些。隨時可以再改回草稿。'
        : '改回草稿之後，客人要等真人回覆；沒人看訊息的時段客人會等比較久。',
      // 後果寫在按鈕上（老闆拍板 D-80 C 案的守門方式）
      confirmLabel: args.mode === 'auto' ? '確定讓 AI 直接回客人' : '確定改回只給草稿',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as ReplyModeArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = String(s.replyMode ?? 'draft')
    if (before === args.mode)
      return { ok: true, message: '本來就是這個模式，沒有動任何設定。' }

    await setAiSettings(ctx.workspaceId, { replyMode: args.mode } as never, ctx.db)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('ai-settings-reply-mode'),
      before: { replyMode: before },
      after: { replyMode: args.mode },
    }, ctx.db)

    return {
      ok: true,
      message: args.mode === 'auto'
        ? '改好了：AI 現在會直接回覆客人。想收回來隨時跟我說「改回草稿」。'
        : '改好了：AI 只會給客服草稿，不會再直接回客人。',
    }
  },
}

// ── op⑥：用一句話建一條客服流程 ─────────────────────────────────
//
// ⭐ 2026-09-16 老闆拍板（`D-58`② 選 A）。這是小幫手第一個「建立」類的能力。
// ⛔ 建好一律**停用**：AI 生的流程會有錯（16 案實測出過占位符沒填、觸發詞打架），
//    要人到流程頁看過才上架。這條不能為了「一句話就搞定」而省掉。

interface CreateScriptArgs {
  description: string
  /** prepare 階段生好的草稿：**執行時原樣建立**，⛔不重生（重生＝跟他看過的不是同一份） */
  draft?: { name: string, nodes: unknown[], rootNodeId: string }
}

const scriptCreateFromDescription: AdminOpDef = {
  capability: 'scripts.write',
  freeTextFields: ['description'],
  argsHint: '參數：{"description":"整句描述這條流程要做什麼"}。'
    + '把使用者的原話盡量完整帶進去（要問客人什麼、依序問幾題、最後回什麼）；'
    + '⛔ 描述太籠統（例如「建一個流程」）就先問清楚用途再提議。',

  normalize(raw) {
    const description = String(raw?.description ?? '').trim().slice(0, 500)
    if (description.length < 6)
      throw new AdminOpUserError('要先問清楚這條流程要做什麼：客人講什麼的時候啟動、要問他哪幾件事、最後回覆什麼。')
    return { description } satisfies CreateScriptArgs as unknown as Record<string, unknown>
  },

  async prepare(ctx, raw) {
    const args = raw as unknown as CreateScriptArgs
    const settings = await getAiSettings(ctx.workspaceId, ctx.db).catch(() => null)
    const draft = await generateScriptDraft(args.description, { sensitiveTopics: settings?.sensitiveTopics ?? [] })
    // 生成屬後台內部操作 → 記進後台自用桶（與 scripts/generate 端點同一個慣例）
    recordAiUsage(ctx.workspaceId, {
      testInputTokens: draft.inputTokens,
      testOutputTokens: draft.outputTokens,
      testInvocations: 1,
    }, ctx.db).catch(e => console.error('[admin-ops] recordAiUsage error:', e))

    return {
      description: args.description,
      draft: { name: draft.name, nodes: draft.nodes, rootNodeId: draft.rootNodeId },
    } satisfies CreateScriptArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx, raw) {
    // 同名的流程在這段期間被別人建出來 → 執行前擋下（避免建出兩條一樣的）
    const args = raw as unknown as CreateScriptArgs
    const name = args.draft?.name ?? ''
    const docs = await listScriptDocs(ctx)
    return String(docs.some(d => String(d.name ?? '').trim() === name.trim()))
  },

  async preview(ctx, raw) {
    const args = raw as unknown as CreateScriptArgs
    const draft = args.draft
    const base = { opId: 'script-create-from-description' as const }
    if (!draft) throw new AdminOpUserError('這次沒有生出流程草稿，請再說一次要做什麼。')

    const { steps, unreachable } = describeScriptSteps(draft.nodes as never, draft.rootNodeId)
    return {
      ...base,
      summary: `我照你說的擬了一條「${draft.name}」。下面是客人實際會經歷的過程，看一下對不對：`,
      items: [
        ...steps.slice(0, 10).map((s, i) => ({ label: `${i + 1}. ${s}` })),
        ...(steps.length > 10 ? [{ label: `…另外還有 ${steps.length - 10} 步`, note: '完整內容在流程頁看得到' }] : []),
        ...(unreachable.length ? [{ label: `⚠️ 有 ${unreachable.length} 個步驟目前沒有人走得到`, note: '建好之後可以到流程頁調整' }] : []),
      ],
      // 「建好是關著的」是這個 op 最重要的一句話：AI 擬的東西一定要有人看過才對客人生效
      warning: '建好之後是**關著**的，客人還不會走到它。你到「自動回應」頁看過、覺得沒問題再上架。',
      confirmLabel: '確定建立（先不上架）',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as CreateScriptArgs
    const draft = args.draft
    if (!draft) return { ok: false, message: '沒有可以建立的草稿，請再說一次要做什麼。' }

    // 走既有的建立端點（轉發呼叫者憑證）：名稱／節點／方案權益的驗證全部沿用那一支，
    // ⛔ agent 這邊一行驗證邏輯都不重寫
    const res = await $fetch<{ id: string }>('/api/ai/scripts/create', {
      method: 'POST',
      query: { workspaceId: ctx.workspaceId },
      headers: ctx.authHeader ? { authorization: ctx.authHeader } : undefined,
      body: { name: draft.name, nodes: draft.nodes, rootNodeId: draft.rootNodeId, enabled: false },
    })

    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('script-create-from-description'),
      after: { name: draft.name, enabled: false, stepCount: (draft.nodes ?? []).length },
      note: `依描述建立「${draft.name}」（建好是停用的）`,
    }, ctx.db)

    return {
      ok: true,
      message: `「${draft.name}」建好了，目前是**停用**狀態。到「自動回應」頁看過內容、確認沒問題再把它打開。`,
      details: [`流程代號：${res.id}`],
    }
  },
}

// ── op⑦：建一則推播草稿（⛔只建草稿，發送永遠留人按）────────────

interface BroadcastDraftArgs {
  name: string
  text: string
  /** 只發給貼這個標籤的人；沒帶＝全部好友 */
  tagName?: string
  /** prepare 解析出來的標籤 id（模型不生 ID） */
  tagId?: string
  /** prepare 當下試算的人數（預覽用；⚠️真正發送時會重算） */
  estimated?: number | null
}

const broadcastDraftCreate: AdminOpDef = {
  capability: 'broadcast.write',
  freeTextFields: ['name', 'text'],
  argsHint: '參數：{"name":"這則推播的名稱（給你們自己看的）","text":"要發給客人的內容","tagName":"（選填）只發給貼這個標籤的人"}。'
    + '⛔ 只會建**草稿**，不會發送——發送一定要人到推播頁自己按。'
    + '⛔ 內容要照使用者說的寫，不要自己加促銷詞或表情符號。',

  normalize(raw) {
    const name = String(raw?.name ?? '').trim().slice(0, 60)
    const text = String(raw?.text ?? '').trim().slice(0, 1000)
    if (!name) throw new AdminOpUserError('要先問清楚這則推播叫什麼名字（這個名字只有你們後台看得到）。')
    if (text.length < 2) throw new AdminOpUserError('要先問清楚要發什麼內容給客人。')
    const tagName = String(raw?.tagName ?? '').trim().slice(0, 40)
    return { name, text, ...(tagName ? { tagName } : {}) } satisfies BroadcastDraftArgs as unknown as Record<string, unknown>
  },

  async prepare(ctx, raw) {
    const args = raw as unknown as BroadcastDraftArgs
    let tagId: string | undefined
    if (args.tagName) {
      // 名字 → 標籤：⛔模型不生 ID，對不到就列出現有的讓它反問
      const snap = await ctx.db.collection('tags').where('workspaceId', '==', ctx.workspaceId).get()
      const rows = snap.docs.map(d => ({ id: d.id, name: String((d.data() as any).name ?? '') }))
      const hits = rows.filter(r => r.name.trim().toLowerCase() === args.tagName!.toLowerCase())
      if (hits.length !== 1) {
        const names = rows.map(r => `「${r.name}」`).slice(0, 10).join('、')
        throw new AdminOpUserError(
          hits.length > 1
            ? `有不只一個標籤叫「${args.tagName}」，請他講得更明確，或直接到推播頁挑。`
            : `找不到叫「${args.tagName}」的標籤。目前有：${names || '（還沒有標籤）'}。`,
        )
      }
      tagId = hits[0]!.id
    }

    // 試算人數（唯讀）：讓確認卡講得出「大概會發給幾個人」
    let estimated: number | null = null
    try {
      const res = await $fetch<{ estimatedCount: number }>('/api/audience/estimate', {
        method: 'POST',
        query: { workspaceId: ctx.workspaceId },
        headers: ctx.authHeader ? { authorization: ctx.authHeader } : undefined,
        body: {
          filter: {
            conditions: tagId ? [{ type: 'includeAny', tagIds: [tagId] }] : [],
            joinedAfter: null,
            joinedBefore: null,
            isBlocked: null,
          },
        },
      })
      estimated = Number(res?.estimatedCount ?? 0)
    }
    catch {
      // ⛔ 試算失敗不擋建立，但也不可以假裝算得出來——預覽會說「這次算不出來」
      estimated = null
    }

    return { ...args, ...(tagId ? { tagId } : {}), estimated } as unknown as Record<string, unknown>
  },

  async fingerprint(ctx, raw) {
    // 同名草稿已經存在 → 執行前擋下（避免重複建）
    const args = raw as unknown as BroadcastDraftArgs
    const snap = await ctx.db.collection('broadcasts')
      .where('workspaceId', '==', ctx.workspaceId)
      .get()
      .catch(() => null)
    const exists = !!snap?.docs.some(d => String((d.data() as any).name ?? '').trim() === args.name)
    return String(exists)
  },

  async preview(_ctx, raw) {
    const args = raw as unknown as BroadcastDraftArgs
    return {
      opId: 'broadcast-draft-create',
      summary: `我會建一則推播草稿「${args.name}」。⛔ 只是草稿，**不會發出去**。`,
      items: [
        { label: args.text.slice(0, 120) + (args.text.length > 120 ? '…' : ''), note: '客人會看到的內容' },
        {
          label: args.tagName ? `只發給貼了「${args.tagName}」的人` : '全部好友',
          note: args.estimated === null
            ? '這次算不出大概幾個人（不影響建立）'
            : `目前大約 ${args.estimated} 人${args.tagName ? '' : '（全部好友）'}`,
        },
      ],
      warning: '要不要真的發、什麼時候發，都要你到推播頁自己按——我不會幫你送出去。發送當下人數會重新計算。',
      confirmLabel: '確定建草稿',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as BroadcastDraftArgs
    // 走既有的建立端點（轉發呼叫者憑證）：欄位驗證與方案權益沿用那一支
    const res = await $fetch<{ id: string }>('/api/broadcast/create', {
      method: 'POST',
      query: { workspaceId: ctx.workspaceId },
      headers: ctx.authHeader ? { authorization: ctx.authHeader } : undefined,
      body: {
        name: args.name,
        audienceSource: args.tagId ? { type: 'tags', tagIds: [args.tagId] } : { type: 'all' },
        messages: [{ type: 'text', text: args.text }],
      },
    })

    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('broadcast-draft-create'),
      after: { name: args.name, audience: args.tagName ?? '全部好友' },
      note: `建立推播草稿「${args.name}」（未發送）`,
    }, ctx.db)

    return {
      ok: true,
      message: `草稿「${args.name}」建好了，**還沒有發送**。到推播頁確認內容與對象，要發的時候自己按發送。`,
      details: [`推播代號：${res.id}`],
    }
  },
}

// ── 註冊表 ──────────────────────────────────────────────────────

export const ADMIN_OPS: Record<AdminOpId, AdminOpDef> = {
  'ai-settings-service-hours': aiSettingsServiceHours,
  'script-set-enabled': scriptSetEnabled,
  'ai-settings-handoff-sla': aiSettingsHandoffSla,
  'ai-settings-sensitive-topic': aiSettingsSensitiveTopic,
  'ai-settings-reply-mode': aiSettingsReplyMode,
  'script-create-from-description': scriptCreateFromDescription,
  'broadcast-draft-create': broadcastDraftCreate,
}

/** 端點／迴圈用：不認得的 op 一律擋下（⛔不做「最接近的那個」） */
export function getAdminOp(opId: string): { opId: AdminOpId, op: AdminOpDef } {
  if (!Object.prototype.hasOwnProperty.call(ADMIN_OPS, opId))
    throw new AdminOpUserError(`沒有「${String(opId).slice(0, 40)}」這個操作，只能做：${Object.values(ADMIN_OP_LABELS).join('、')}。`)
  return { opId: opId as AdminOpId, op: ADMIN_OPS[opId as AdminOpId] }
}

/** 給 prompt 用的操作清單（含參數說明與風險級別） */
export function adminOpCatalogueForPrompt(): string {
  return (Object.keys(ADMIN_OPS) as AdminOpId[])
    .map(id => `- ${id}（${ADMIN_OP_LABELS[id]}，風險${ADMIN_OP_RISK[id] === 'medium' ? '中' : '低'}）：${ADMIN_OPS[id].argsHint}`)
    .join('\n')
}
