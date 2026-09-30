/**
 * 小幫手代辦・第二批（`D-109`，2026-09-29 老闆「照建議執行」＝第七節第 2 題）。
 *
 * 從 `admin-ops.ts` 分出來放：那支已經一千行、七個操作；這一批八個是同一種形狀的延伸——
 *   ① AI 設定剩下會改變客人收到什麼的四格：總開關、自動交還、自動結束、語氣範本
 *   ② 建一個標籤
 *   ③ 補一張知識卡（⛔ 只放進「等你看過」，不直接上線）
 *   ④ 改一條自動回應的關鍵字／回覆字
 *
 * 鐵律全部沿用 `admin-ops.ts` 檔頭那幾條（提議→預覽→人按確定→執行一次；模型不生 ID；
 * 只動該動的那一格；每次執行寫 `auditLogs`、actor='agent'），這裡不重抄。
 * 另外兩條是這一批才有的：
 * - ⛔ **改別的資料一律轉呼叫既有端點**（標籤、知識卡、自動回應）：驗證、方案閘門、
 *   「加好友流程只能一條」這些檢查都跟著端點走，這裡一行都不重寫（`G-100` 同一個口徑）。
 * - ⛔ 模型提議之後、人按確定之前，那筆資料可能被人在頁面上改過——`fingerprint` 一律把
 *   **要改的那一格的現值**算進去，變了就不執行（整份送回 PUT 的操作尤其要這樣，否則會蓋掉別人剛改的）。
 */
import { createHash } from 'node:crypto'
import { adminOpAuditAction } from '~~/shared/types/admin-ops'
import { AI_TONE_TEMPLATES, isAiToneTemplateKey, type AiToneTemplateKey } from '~~/shared/ai-tone-templates'
import { suggestTagCode, isValidTagCode } from '~~/shared/tag-code-suggest'
import { planAllowsScripting } from '~~/shared/billing/plans'
import {
  DEFAULT_GROUNDING_SIMILARITY_THRESHOLD,
  MAX_HUMAN_SESSION_MAX_IDLE_HOURS,
  MIN_HUMAN_SESSION_MAX_IDLE_HOURS,
} from '~~/shared/types/ai-knowledge'
import { MAX_TRIGGER_KEYWORDS, scriptTriggerEvent } from '~~/shared/types/ai-script'
// ⛔ 從 admin-op-def 拿、不從 admin-ops 拿：admin-ops 的註冊表 import 這支，反過來就是循環相依
import { AdminOpUserError, resolveScriptDoc, type AdminOpCtx, type AdminOpDef } from './admin-op-def'
import { getAiSettings, setAiSettings } from './ai-settings'
import { writeAuditLog } from './audit-log'
import { KNOWLEDGE_CHUNKS_COLLECTION, searchSimilarChunksWithDrafts } from './ai-knowledge-chunks'
import { embedQuery, estimateTokens } from './gemini'
import { recordAiUsage } from './ai-usage'
import { getWorkspacePlan } from './billing'

/** 轉呼叫既有端點：權限與驗證由那一支自己把關（呼叫者憑證原樣帶過去） */
function callApi<T>(ctx: AdminOpCtx, url: string, opts: { method: 'GET' | 'POST' | 'PUT', body?: unknown }): Promise<T> {
  // 網址是字串變數，Nitro 推不出是哪一支路由的回傳型別——在這裡收斂成呼叫端要的型別
  // （admin-ops 那幾支寫死字面網址的不需要這一步）
  const fetchAny = $fetch as unknown as (u: string, o: Record<string, unknown>) => Promise<unknown>
  return fetchAny(url, {
    method: opts.method,
    query: { workspaceId: ctx.workspaceId },
    headers: ctx.authHeader ? { authorization: ctx.authHeader } : undefined,
    ...(opts.body !== undefined ? { body: opts.body as Record<string, unknown> } : {}),
  }) as Promise<T>
}

/** 端點丟回來的錯誤訊息（給人看的那句） */
function apiErrorText(e: any): string {
  return String(e?.data?.statusMessage || e?.statusMessage || e?.message || '').slice(0, 200)
}

// ── ① AI 設定：總開關 ──────────────────────────────────────────────
//
// ⚠️ 跟「直接回／只給草稿」（`D-80`）同一級的影響面：打開＝AI 開始接客人的訊息。
//    所以確認卡要講清楚**打開之後是直接回還是只給草稿**，確認鈕把後果寫在按鈕上。

interface AiEnabledArgs { enabled: boolean }

export const aiSettingsEnabled: AdminOpDef = {
  capability: 'ai.settings.write',
  argsHint: '參數：{"enabled":true}＝打開 AI 自動回覆；{"enabled":false}＝關掉（AI 一句都不回，自動回應照常運作）。'
    + '⛔ 他沒講清楚要開還是關就先問。',

  normalize(raw) {
    if (typeof raw?.enabled !== 'boolean')
      throw new AdminOpUserError('要問清楚是要「打開」還是「關掉」AI 自動回覆。')
    return { enabled: raw.enabled } satisfies AiEnabledArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx) {
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    // 回覆模式也算進去：提議時卡上講「打開之後只給草稿」，按下去之前被人改成直接回＝卡上那句已經不是真的
    return `${s.enabled === true}:${s.replyMode ?? 'draft'}`
  },

  async preview(ctx, raw) {
    const args = raw as unknown as AiEnabledArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = s.enabled === true
    const base = { opId: 'ai-settings-enabled' as const }
    const say = (on: boolean) => (on ? 'AI 自動回覆：開' : 'AI 自動回覆：關')

    if (before === args.enabled)
      return { ...base, summary: `現在就是「${say(before)}」，不用改。`, items: [], confirmLabel: '知道了', noop: true }

    if (!args.enabled) {
      return {
        ...base,
        summary: '我會把 AI 自動回覆**關掉**。',
        items: [{ label: say(true), note: '現在' }, { label: say(false), note: '改成' }],
        warning: '關掉之後 AI 一句都不會回，客人的訊息改由真人處理。自動回應不受影響，照常運作。',
        confirmLabel: '確定關掉 AI',
      }
    }

    const auto = (s.replyMode ?? 'draft') === 'auto'
    return {
      ...base,
      summary: '我會把 AI 自動回覆**打開**。',
      items: [
        { label: say(false), note: '現在' },
        { label: say(true), note: '改成' },
        { label: auto ? 'AI 直接回客人' : 'AI 只給客服草稿（客人收不到）', note: '打開之後的回覆模式（沒有要改它）' },
      ],
      warning: auto
        ? '⚠️ 目前的回覆模式是「直接回客人」：打開之後，客人傳來的訊息 AI 會直接回覆，你不會先看到。想先看看它怎麼答，可以先叫我改成「只給草稿」。'
        : '打開之後 AI 會替每則訊息擬一份草稿給客服參考，客人不會直接收到。',
      confirmLabel: auto ? '確定打開（AI 會直接回客人）' : '確定打開（只給客服草稿）',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as AiEnabledArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = s.enabled === true
    if (before === args.enabled)
      return { ok: true, message: '本來就是這樣，沒有動任何設定。' }

    await setAiSettings(ctx.workspaceId, { enabled: args.enabled } as never, ctx.db)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('ai-settings-enabled'),
      before: { enabled: before },
      after: { enabled: args.enabled },
    }, ctx.db)

    return {
      ok: true,
      message: args.enabled
        ? ((s.replyMode ?? 'draft') === 'auto'
            ? '打開了：AI 現在會直接回覆客人。想先讓它只給草稿，跟我說「改成只給草稿」。'
            : '打開了：AI 現在會替每則訊息擬草稿給客服參考，客人不會直接收到。')
        : '關掉了：AI 不會再回任何客人（自動回應照常運作）。',
    }
  },
}

// ── ① AI 設定：客服忘了交還時，閒置幾分鐘自動交還機器人 ─────────────

interface HandbackArgs { minutes: number }

export const aiSettingsHandbackIdle: AdminOpDef = {
  capability: 'ai.settings.write',
  needsUserNumber: true,
  // 「關掉自動交還」一個數字都不會講，那是合理的要求——不可以因為沒數字就擋
  numberOptional: raw => raw?.off === true,
  argsHint: '參數：{"minutes":30}＝客服按了「我接手」之後，超過幾分鐘沒再回覆就自動交還給機器人；'
    + '{"off":true}＝不自動交還（只有他明講「關掉／不要」時才用）。⛔ 他沒講數字又不是要關，就先問幾分鐘。',

  normalize(raw) {
    if (raw?.off === true) return { minutes: 0 } satisfies HandbackArgs as unknown as Record<string, unknown>
    const n = Number(raw?.minutes)
    if (!Number.isFinite(n))
      throw new AdminOpUserError('要先問清楚客服閒置「幾分鐘」之後要自動交還（或說不要自動交還）。')
    const minutes = Math.round(n)
    if (minutes < 1 || minutes > 1440)
      throw new AdminOpUserError('自動交還的時間只能設 1 到 1440 分鐘（一天以內）；要關掉的話講「不要自動交還」。')
    return { minutes } satisfies HandbackArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx) {
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    return String(s.handbackIdleMinutes ?? 0)
  },

  async preview(ctx, raw) {
    const args = raw as unknown as HandbackArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = Number(s.handbackIdleMinutes ?? 0)
    const say = (m: number) => (m > 0 ? `客服接手後閒置 ${m} 分鐘，自動交還給機器人` : '不自動交還（客服要自己按「交還機器人」）')
    const base = { opId: 'ai-settings-handback-idle' as const }

    if (before === args.minutes)
      return { ...base, summary: `現在就是「${say(before)}」，不用改。`, items: [], confirmLabel: '知道了', noop: true }

    return {
      ...base,
      summary: '我會改「客服接手之後，忘了交還時要不要自動交還給機器人」。',
      items: [{ label: say(before), note: '現在' }, { label: say(args.minutes), note: '改成' }],
      warning: args.minutes > 0
        ? '客服按了「我接手」之後，超過這段時間沒有再回覆，這位客人就會交回給機器人和 AI 接著回。'
        : '⚠️ 關掉之後，客服接手後忘了按「交還機器人」，這位客人就不會再被 AI 回答。',
      confirmLabel: args.minutes > 0 ? '確定改自動交還' : '確定不自動交還',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as HandbackArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = Number(s.handbackIdleMinutes ?? 0)
    if (before === args.minutes)
      return { ok: true, message: '本來就是這個設定，沒有動任何東西。' }

    await setAiSettings(ctx.workspaceId, { handbackIdleMinutes: args.minutes } as never, ctx.db)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('ai-settings-handback-idle'),
      before: { handbackIdleMinutes: before },
      after: { handbackIdleMinutes: args.minutes },
    }, ctx.db)

    return {
      ok: true,
      message: args.minutes > 0
        ? `改好了：客服接手後閒置 ${args.minutes} 分鐘，就會自動交還給機器人。`
        : '改好了：不再自動交還，客服要自己按「交還機器人」。',
    }
  },
}

// ── ① AI 設定：真人接手的對話太久沒動靜就自動結束 ─────────────────

interface AutoCloseArgs { hours: number }

export const aiSettingsAutoClose: AdminOpDef = {
  capability: 'ai.settings.write',
  needsUserNumber: true,
  numberOptional: raw => raw?.off === true,
  argsHint: `參數：{"hours":48}＝真人接手的對話超過幾小時沒動靜就自動結束（${MIN_HUMAN_SESSION_MAX_IDLE_HOURS}～${MAX_HUMAN_SESSION_MAX_IDLE_HOURS} 小時；「兩天」就是 48）；`
    + '{"off":true}＝不自動結束（只有他明講「關掉／不要」時才用）。⛔ 他沒講多久又不是要關，就先問。',

  normalize(raw) {
    if (raw?.off === true) return { hours: 0 } satisfies AutoCloseArgs as unknown as Record<string, unknown>
    const n = Number(raw?.hours)
    if (!Number.isFinite(n))
      throw new AdminOpUserError('要先問清楚「幾小時」沒動靜就自動結束（或說不要自動結束）。')
    const hours = Math.round(n)
    if (hours < MIN_HUMAN_SESSION_MAX_IDLE_HOURS || hours > MAX_HUMAN_SESSION_MAX_IDLE_HOURS) {
      throw new AdminOpUserError(
        `自動結束只能設 ${MIN_HUMAN_SESSION_MAX_IDLE_HOURS} 到 ${MAX_HUMAN_SESSION_MAX_IDLE_HOURS} 小時（最多兩週）；要關掉的話講「不要自動結束」。`,
      )
    }
    return { hours } satisfies AutoCloseArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx) {
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    return String(s.humanSessionMaxIdleHours ?? 0)
  },

  async preview(ctx, raw) {
    const args = raw as unknown as AutoCloseArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = Number(s.humanSessionMaxIdleHours ?? 0)
    const say = (h: number) => (h > 0 ? `真人接手的對話 ${h} 小時沒動靜就自動結束` : '不自動結束（要有人按「結束會話」）')
    const base = { opId: 'ai-settings-auto-close' as const }

    if (before === args.hours)
      return { ...base, summary: `現在就是「${say(before)}」，不用改。`, items: [], confirmLabel: '知道了', noop: true }

    return {
      ...base,
      summary: '我會改「真人接手的對話，太久沒動靜要不要自動結束」。',
      items: [{ label: say(before), note: '現在' }, { label: say(args.hours), note: '改成' }],
      warning: args.hours > 0
        ? '只影響「真人接手中」的對話：太久沒人說話就把那一場結掉，客人下次傳訊息會從頭開始（先由機器人或 AI 接）。'
        : '關掉之後，真人接手的對話要有人按「結束會話」才會結束。',
      confirmLabel: args.hours > 0 ? '確定改自動結束' : '確定不自動結束',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as AutoCloseArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = Number(s.humanSessionMaxIdleHours ?? 0)
    if (before === args.hours)
      return { ok: true, message: '本來就是這個設定，沒有動任何東西。' }

    await setAiSettings(ctx.workspaceId, { humanSessionMaxIdleHours: args.hours } as never, ctx.db)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('ai-settings-auto-close'),
      before: { humanSessionMaxIdleHours: before },
      after: { humanSessionMaxIdleHours: args.hours },
    }, ctx.db)

    return {
      ok: true,
      message: args.hours > 0
        ? `改好了：真人接手的對話 ${args.hours} 小時沒動靜就會自動結束。`
        : '改好了：真人接手的對話不再自動結束。',
    }
  },
}

// ── ① AI 設定：語氣範本（整段換掉「給 AI 的指示」）──────────────────
//
// ⛔ 只能換成三個現成範本之一，不收自由文字：「給 AI 的指示」是整個 AI 的行為規則，
//    讓模型自己寫一段塞進去＝它可以把「不要承諾退費」這種禁則悄悄拿掉。

interface ToneArgs { template: AiToneTemplateKey }

/** 目前那段指示的開頭（確認卡用；太長只給看一行） */
function promptHead(text: string): string {
  const first = String(text ?? '').trim().split('\n')[0] ?? ''
  return first.length > 40 ? `${first.slice(0, 40)}…` : (first || '（目前是空的）')
}

export const aiSettingsToneTemplate: AdminOpDef = {
  capability: 'ai.settings.write',
  argsHint: '參數：{"template":"friendly"|"professional"|"warm"}＝把「給 AI 的指示」整段換成現成範本：'
    + 'friendly＝親切活潑、professional＝專業簡潔、warm＝溫暖體貼。'
    + '⛔ 只能挑這三個，不能自己寫一段；他要的語氣對不上任何一個就請他到 AI 設定頁自己改。',

  normalize(raw) {
    const t = String(raw?.template ?? '').trim()
    if (!isAiToneTemplateKey(t)) {
      throw new AdminOpUserError(
        `語氣範本只有三種：${Object.values(AI_TONE_TEMPLATES).map(v => `「${v.label}」`).join('、')}。要問他挑哪一種；三種都不像的話，請他到 AI 設定頁自己改那段指示。`,
      )
    }
    return { template: t } satisfies ToneArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx) {
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    // 壓成雜湊：指紋會原樣進確認憑證，整段指示最長四千字
    return createHash('sha256').update(String(s.systemPrompt ?? '')).digest('base64url')
  },

  async preview(ctx, raw) {
    const args = raw as unknown as ToneArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const current = String(s.systemPrompt ?? '').trim()
    const tpl = AI_TONE_TEMPLATES[args.template]
    const base = { opId: 'ai-settings-tone-template' as const }

    if (current === tpl.text.trim())
      return { ...base, summary: `現在用的就是「${tpl.label}」範本，不用改。`, items: [], confirmLabel: '知道了', noop: true }

    const currentIsTemplate = Object.values(AI_TONE_TEMPLATES).find(v => v.text.trim() === current)
    return {
      ...base,
      summary: `我會把「給 AI 的指示」換成「${tpl.label}」範本。`,
      items: [
        { label: currentIsTemplate ? `「${currentIsTemplate.label}」範本` : promptHead(current), note: '現在' },
        { label: promptHead(tpl.text), note: `改成「${tpl.label}」` },
      ],
      // 自己寫過的內容會整段不見——這件事要在按下去之前講
      warning: currentIsTemplate
        ? 'AI 之後回客人的口吻會照新的範本。隨時可以到 AI 設定頁再改。'
        : '⚠️ 會把你現在寫的指示**整段換掉**（不是加在後面），裡面自己寫的規則會跟著不見。之後可以到 AI 設定頁再改。',
      confirmLabel: `確定換成「${tpl.label}」`,
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as ToneArgs
    const s = await getAiSettings(ctx.workspaceId, ctx.db)
    const before = String(s.systemPrompt ?? '')
    const tpl = AI_TONE_TEMPLATES[args.template]
    if (before.trim() === tpl.text.trim())
      return { ok: true, message: `本來就是「${tpl.label}」範本，沒有動任何設定。` }

    await setAiSettings(ctx.workspaceId, { systemPrompt: tpl.text } as never, ctx.db)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('ai-settings-tone-template'),
      before: { systemPrompt: before },
      after: { systemPrompt: tpl.text },
      note: `換成「${tpl.label}」範本`,
    }, ctx.db)

    return { ok: true, message: `換好了：「給 AI 的指示」現在是「${tpl.label}」範本。` }
  },
}

// ── ② 建一個標籤 ──────────────────────────────────────────────────

interface TagCreateArgs {
  name: string
  color?: string
  /** prepare 算好的英文代號（⛔ 模型不生；照名字自動取、撞號自動換） */
  code?: string
}

const DEFAULT_TAG_COLOR = '#6B7280'
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

async function listTagRows(ctx: AdminOpCtx): Promise<{ id: string, name: string, code: string }[]> {
  const snap = await ctx.db.collection('tags').where('workspaceId', '==', ctx.workspaceId).get()
  return snap.docs
    .map(d => ({ id: d.id, data: d.data() as Record<string, any> }))
    // 查詢已經擋掉了，這是第二層防線（同 admin-ops 的 resolveScript）
    .filter(d => d.data.workspaceId === ctx.workspaceId)
    .map(d => ({ id: d.id, name: String(d.data.name ?? ''), code: String(d.data.code ?? '') }))
}

export const tagCreate: AdminOpDef = {
  capability: 'tags.write',
  targetField: 'name',
  freeTextFields: ['name'],
  argsHint: '參數：{"name":"標籤的顯示名稱","color":"#RRGGBB（選填）"}。英文代號系統會自己取，⛔不要問他。'
    + '⛔ 一次只建一個；他要建好幾個就先建第一個，其餘的等這個確認完再提議。',

  normalize(raw) {
    const name = String(raw?.name ?? '').trim().slice(0, 30)
    if (!name) throw new AdminOpUserError('要先問清楚標籤叫什麼名字。')
    const color = String(raw?.color ?? '').trim()
    return { name, ...(HEX_COLOR_RE.test(color) ? { color } : {}) } satisfies TagCreateArgs as unknown as Record<string, unknown>
  },

  async prepare(ctx, raw) {
    const args = raw as unknown as TagCreateArgs
    const rows = await listTagRows(ctx)
    const same = rows.find(r => r.name.trim().toLowerCase() === args.name.toLowerCase())
    // ⛔ 同名的不建第二顆：同一個名字兩顆標籤，推播挑名單時分不出是哪一顆
    if (same) throw new AdminOpUserError(`已經有一個叫「${same.name}」的標籤了，不用再建一個。（請照實告訴他。）`)
    const code = suggestTagCode(args.name, rows.map(r => r.code))
    return { ...args, code } satisfies TagCreateArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx, raw) {
    const args = raw as unknown as TagCreateArgs
    const rows = await listTagRows(ctx)
    // 這段期間有人建了同名的 → 不執行（避免兩顆一樣的）
    return String(rows.some(r => r.name.trim().toLowerCase() === args.name.toLowerCase()))
  },

  async preview(_ctx, raw) {
    const args = raw as unknown as TagCreateArgs
    return {
      opId: 'tag-create',
      summary: `我會建一個叫「${args.name}」的標籤。`,
      items: [
        { label: args.name, note: '顯示名稱（客人看不到）' },
        { label: args.code ?? '', note: '英文代號（系統自動取，建好就不能改）' },
      ],
      warning: '建好之後是空的，不會自動貼到任何人身上——要在對話、好友頁或自動回應裡貼，或到標籤管理打開「讓 AI 判斷」。',
      confirmLabel: '確定建立標籤',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as TagCreateArgs
    const taken = (await listTagRows(ctx)).map(r => r.code)
    let code = args.code && isValidTagCode(args.code) ? args.code : suggestTagCode(args.name, taken)
    let created: { id: string } | null = null
    let lastError = ''

    // 撞號自己換一組重試（同 AdminTagPicker 的就地建標籤）：代號是系統取的，⛔不能叫他換一個代號
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      try {
        created = await callApi<{ id: string }>(ctx, '/api/tag/create', {
          method: 'POST',
          body: { code, name: args.name, category: 'custom', color: args.color ?? DEFAULT_TAG_COLOR, status: 'active' },
        })
      }
      catch (e: any) {
        if (Number(e?.statusCode ?? e?.status) !== 409) {
          lastError = apiErrorText(e)
          break
        }
        taken.push(code)
        code = suggestTagCode(args.name, taken)
      }
    }
    if (!created)
      return { ok: false, message: `標籤沒有建成功${lastError ? `：${lastError}` : '（代號一直撞到現有的標籤）'}。沒有動任何資料，可以到標籤管理自己建。` }

    // 確認卡上把代號寫成「建好就不能改」：真的建出來的跟卡上不一樣時，⛔ 不可以安靜帶過
    const codeChanged = !!args.code && code !== args.code
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('tag-create'),
      targetId: created.id,
      after: { name: args.name, code },
      note: codeChanged
        ? `建立標籤「${args.name}」（確認卡上的代號 ${args.code} 剛好被別的標籤用走，改用 ${code}）`
        : `建立標籤「${args.name}」`,
    }, ctx.db)

    return {
      ok: true,
      message: codeChanged
        ? `標籤「${args.name}」建好了（目前還沒有貼在任何人身上）。⚠️ 英文代號改成了「${code}」：確認卡上的「${args.code}」剛好在這段時間被別的標籤用走了。`
        : `標籤「${args.name}」建好了（目前還沒有貼在任何人身上）。`,
    }
  },
}

// ── ③ 補一張知識卡：⛔ 只放進「等你看過」，採用才上線 ─────────────────
//
// 為什麼不直接上線：小幫手寫的卡是照他一句話擬的，裡面可能少了條件、寫錯價格——
// 跟「一句話建自動回應」建好是停用的同一個道理，要人看過才對客人生效。
// 「等你看過」本來就是這個用途（`C-250`③）：LINE 上不用、測試對話讀得到、採用前不算額度。

interface KnowledgeDraftArgs {
  question: string
  answer: string
  title?: string
  /** prepare 查到的相近卡（只給確認卡看）：客人這樣問時 AI 會拿去回答的卡 */
  similar?: string[]
  /**
   * 相近的卡有沒有**真的查過**。⛔ 查不成（算向量失敗）跟「查了、沒有」是兩件事：
   * 前者確認卡要講「這次沒查成」，不可以安靜地當成沒有重複。
   */
  similarChecked?: boolean
}

/**
 * 客人這樣問時，AI 會拿哪幾張卡來回答（含「等你看過」的）——就是「會不會重複」要看的那幾張。
 *
 * ⛔ 不用 `/api/ai/knowledge/search`：那支是**整串字**的子字串比對，拿客人一整句問題去查
 *    （「請問你們有沒有停車位可以停」），現成的「停車資訊」永遠比不到（2026-09-30 code review）。
 *    改用答題同一套的向量搜尋、同一個「夠像才拿來答」門檻（`groundingThreshold`）。
 */
async function findSimilarCards(ctx: AdminOpCtx, question: string): Promise<{ titles: string[], checked: boolean }> {
  try {
    const [vector, settings] = await Promise.all([
      embedQuery(question),
      getAiSettings(ctx.workspaceId, ctx.db).catch(() => null),
    ])
    // 後台自用那一桶（同小幫手聊天的 test*）：不算進「回答客人」的成本
    recordAiUsage(ctx.workspaceId, { testEmbeddingTokens: estimateTokens(question) }, ctx.db)
      .catch(e => console.error('[admin-ops] recordAiUsage error:', e))
    const floor = Number(settings?.groundingThreshold ?? DEFAULT_GROUNDING_SIMILARITY_THRESHOLD)
    const hits = await searchSimilarChunksWithDrafts(ctx.db, ctx.workspaceId, vector, 3)
    return {
      titles: hits.filter(h => h.similarity >= floor).map(h => h.title.trim()).filter(Boolean),
      checked: true,
    }
  }
  catch (e) {
    // 查不到就照實講「沒查成」，不擋補知識這件事
    console.warn('[admin-ops] knowledge-draft 查相近的卡失敗：', (e as Error)?.message)
    return { titles: [], checked: false }
  }
}

/**
 * 知識庫裡是不是已經有**一模一樣**的一張（標題、內容、那句問法都一樣，不在回收桶）。
 *
 * 兩個用途：①確認碼的指紋——建好之後它會從 false 變 true，同一張確認碼再送一次就擋得下來
 * （以前指紋寫死 'new'，十分鐘內送幾次就建幾張）；②提議當下就已經有了＝不用再放一次。
 * ⚠️ 兩個等值條件，吃單欄位索引就查得動（同 `resolveScriptDoc`）。
 */
async function identicalCardExists(ctx: AdminOpCtx, args: KnowledgeDraftArgs): Promise<boolean> {
  const snap = await ctx.db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', ctx.workspaceId)
    .where('title', '==', args.title ?? args.question)
    .limit(20)
    .get()
  return snap.docs.some((d) => {
    const c = d.data() as { workspaceId?: string, content?: string, questions?: unknown[], deletedAt?: unknown }
    return c.workspaceId === ctx.workspaceId
      && c.deletedAt == null
      && String(c.content ?? '') === args.answer
      && (c.questions ?? []).map(String).includes(args.question)
  })
}

export const knowledgeDraftCreate: AdminOpDef = {
  capability: 'knowledge.write',
  targetField: 'question',
  freeTextFields: ['question', 'answer', 'title'],
  argsHint: '參數：{"question":"客人會怎麼問","answer":"要回答的內容","title":"（選填）卡片標題"}。'
    + '⛔ answer 只能用他講的內容，不可以自己補價格、時間、規則；他沒講答案就先問。'
    + '建好會放在知識庫的「等你看過」，要他按採用才會拿來回答客人。'
    // 2026-09-29 實走：模型的提議句寫成「當客人問到停車位時，AI 會回答…」——講得像馬上就會答，
    // 確認卡講的卻是「還不會」。那句話會跟確認卡並排出現，兩句講反比沒講更糟
    + '⛔ 提議那句話**不可以**說「AI 會回答…」「客人問就會…」——它還不會，要說「我會先放進等你看過，你採用之後才會拿來回答」。',

  normalize(raw) {
    const question = String(raw?.question ?? '').trim().slice(0, 200)
    const answer = String(raw?.answer ?? '').trim().slice(0, 2000)
    if (question.length < 2) throw new AdminOpUserError('要先問清楚客人會怎麼問這一題。')
    if (answer.length < 2) throw new AdminOpUserError('要先問清楚這一題要怎麼回答（⛔ 不要自己編答案）。')
    const title = String(raw?.title ?? '').trim().slice(0, 100) || question.slice(0, 100)
    return { question, answer, title } satisfies KnowledgeDraftArgs as unknown as Record<string, unknown>
  },

  async prepare(ctx, raw) {
    const args = raw as unknown as KnowledgeDraftArgs
    // 有現成的就先講：改既有的比新建一條重複的好
    const { titles, checked } = await findSimilarCards(ctx, args.question)
    return { ...args, similar: titles, similarChecked: checked } satisfies KnowledgeDraftArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx, raw) {
    // 建好之後會從 false 變 true：確認端點靠「指紋變了」擋下同一張確認碼的第二次（見 identicalCardExists）
    return String(await identicalCardExists(ctx, raw as unknown as KnowledgeDraftArgs))
  },

  async preview(ctx, raw) {
    const args = raw as unknown as KnowledgeDraftArgs
    const base = { opId: 'knowledge-draft-create' as const }
    // ⚠️ 這個 noop 也是確認端點判斷「這張剛剛已經執行過了」的依據——一定要跟指紋講同一件事
    if (await identicalCardExists(ctx, args))
      return { ...base, summary: '知識庫裡已經有一張一模一樣的卡了（同一句問法、同樣的回答），不用再放一次。', items: [], confirmLabel: '知道了', noop: true }

    const similarItem = args.similar?.length
      ? [{ label: args.similar.map(t => `「${t}」`).join('、'), note: '⚠️ 客人這樣問時，AI 現在會拿這幾張卡來回答——採用前先看一下會不會重複' }]
      : args.similarChecked === false
        ? [{ label: '這次沒查成', note: '⚠️ 沒辦法先確認知識庫裡有沒有講同一件事的卡，採用前自己看一下' }]
        : []
    return {
      ...base,
      summary: '我會把這張知識卡放進知識庫的「等你看過」：',
      items: [
        { label: args.question, note: '客人會這樣問' },
        { label: args.answer.length > 120 ? `${args.answer.slice(0, 120)}…` : args.answer, note: '要回答的內容' },
        ...similarItem,
      ],
      warning: '放進去之後**還不會**拿來回答客人：到知識庫的「等你看過」按「採用」才會上線（採用時才算知識卡額度）。測試對話裡可以先試問看看。',
      confirmLabel: '確定放進「等你看過」',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as KnowledgeDraftArgs
    let res: { id: string, status?: string, failureReason?: string }
    try {
      res = await callApi<{ id: string, status?: string, failureReason?: string }>(ctx, '/api/ai/knowledge/create', {
        method: 'POST',
        body: { title: args.title, content: args.answer, questions: [args.question], tags: [], draft: true },
      })
    }
    catch (e: any) {
      return { ok: false, message: `知識卡沒有建成功：${apiErrorText(e) || '請稍後再試'}。沒有動任何資料。` }
    }
    // ⛔ 端點若沒吃到 draft（例如舊版），卡片會直接上線——那跟確認卡講的完全相反，要照實講
    if (res.status && res.status !== 'draft') {
      // 卡片確實建出來了：這一筆也要記（建卡端點自己那筆在代辦境域裡不寫，漏了這裡就完全查不到）
      await writeAuditLog({
        workspaceId: ctx.workspaceId,
        uid: ctx.uid,
        actor: 'agent',
        action: adminOpAuditAction('knowledge-draft-create'),
        targetId: res.id,
        after: { title: args.title, status: res.status },
        note: `補一張知識卡「${args.title}」——⚠️ 沒有放進「等你看過」，直接上線了`,
      }, ctx.db)
      return { ok: false, message: '⚠️ 卡片建好了，但**沒有**放進「等你看過」，而是直接上線了。請到知識庫把它停用或刪掉。' }
    }

    // 卡建好了、但搜尋用的向量沒算成（例如 Gemini 一時 429）：沒有向量的卡**誰都搜不到**，
    // 確認卡上那句「測試對話裡可以先試問」這時是假的——要照實講。採用時會再算一次（`adoptDrafts`）。
    const failure = String(res.failureReason ?? '').trim()

    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('knowledge-draft-create'),
      targetId: res.id,
      after: { title: args.title, status: 'draft' },
      note: failure
        ? `補一張知識卡「${args.title}」（放在「等你看過」，還沒上線；這次沒學成功：${failure}）`
        : `補一張知識卡「${args.title}」（放在「等你看過」，還沒上線）`,
    }, ctx.db)

    if (failure) {
      return {
        ok: true,
        message: `放好了：「${args.title}」在知識庫的「等你看過」。⚠️ 但這張卡這次沒學成功（${failure}），`
          + '所以**測試對話暫時問不到它**；按「採用」時系統會再學一次，採用之後才會拿來回答客人。',
      }
    }
    return { ok: true, message: `放好了：「${args.title}」在知識庫的「等你看過」，按「採用」之後才會拿來回答客人。` }
  },
}

// ── ④ 改一條自動回應的關鍵字／回覆字 ─────────────────────────────────
//
// ⛔ 整份流程轉呼叫 `PUT /api/ai/scripts/:id`（方案閘門、加好友衝突、格式驗證都跟著端點走）。
//    因為是整份送回，指紋一定要涵蓋整份步驟——提議到按下去之間有人在頁面上改了別的步驟，
//    照舊資料送回去就會把他剛改的洗掉。

interface ScriptDocRow {
  id: string
  name: string
  enabled: boolean
  priority: number
  rootNodeId: string
  nodes: Record<string, any>[]
}

/** 查找與「找不到／撞名」的講法跟上下架同一支（`resolveScriptDoc`），這裡只把要送回 PUT 的幾格挑出來 */
async function findScriptByName(ctx: AdminOpCtx, name: string): Promise<ScriptDocRow> {
  const d = await resolveScriptDoc(ctx, name)
  return {
    id: String(d.id),
    name: String(d.name ?? ''),
    enabled: d.enabled === true,
    priority: Number(d.priority ?? 0),
    rootNodeId: String(d.rootNodeId ?? ''),
    nodes: Array.isArray(d.nodes) ? d.nodes : [],
  }
}

/** 方案不含腳本就不出確認卡（端點也會擋，但卡上先寫「我會改」、按下去才說不行＝先講了一句假話） */
async function assertScriptingPlan(ctx: AdminOpCtx): Promise<void> {
  const plan = await getWorkspacePlan(ctx.workspaceId, ctx.db)
  if (plan && !planAllowsScripting(plan))
    throw new AdminOpUserError('這個帳號目前的方案不含自動回應流程（腳本）功能，所以沒辦法改——要先升級方案。（請照實告訴他。）')
}

function triggerOf(row: ScriptDocRow): Record<string, any> | undefined {
  return row.nodes.find(n => n?.id === row.rootNodeId) ?? row.nodes.find(n => n?.type === 'trigger')
}

/**
 * 整份流程的指紋。⛔ 要壓成雜湊：指紋會**原樣**放進確認憑證（`admin-op-token` 的 `g`），
 * 看意思那種流程的步驟裡帶著範例句向量（每句 768 個數字），直接放進去憑證會大到好幾百 KB。
 */
function scriptFingerprint(row: ScriptDocRow): string {
  return createHash('sha256').update(JSON.stringify([row.id, row.enabled, row.priority, row.rootNodeId, row.nodes])).digest('base64url')
}

/** 送回 PUT 的那一份：⛔ 除了要改的那一格，其他照資料庫現值原樣帶回 */
function scriptPutBody(row: ScriptDocRow, nodes: Record<string, any>[]) {
  return { name: row.name, enabled: row.enabled, priority: row.priority, rootNodeId: row.rootNodeId, nodes }
}

interface ScriptKeywordArgs { name: string, action: 'add' | 'remove', keyword: string }

export const scriptUpdateKeyword: AdminOpDef = {
  capability: 'scripts.write',
  targetField: 'name',
  freeTextFields: ['keyword'],
  argsHint: '參數：{"name":"自動回應的名字","action":"add"|"remove","keyword":"要加或拿掉的那個詞"}。'
    + 'name 要照 list_auto_responses 清單一字不差；⛔ 一次只動一個詞。'
    + '只適用「用關鍵字啟動」的那種；看意思判斷的、加好友時啟動的要請他到自動回應頁改。',

  normalize(raw) {
    const name = String(raw?.name ?? '').trim().slice(0, 100)
    const action = String(raw?.action ?? '').trim()
    const keyword = String(raw?.keyword ?? '').trim().slice(0, 30)
    if (!name) throw new AdminOpUserError('要先問清楚是哪一條自動回應（可以先列出清單讓他挑）。')
    if (action !== 'add' && action !== 'remove') throw new AdminOpUserError('要問清楚是要「加一個關鍵字」還是「拿掉一個關鍵字」。')
    if (!keyword) throw new AdminOpUserError('要問清楚是哪一個詞。')
    return { name, action, keyword } satisfies ScriptKeywordArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx, raw) {
    return scriptFingerprint(await findScriptByName(ctx, (raw as unknown as ScriptKeywordArgs).name))
  },

  async preview(ctx, raw) {
    const args = raw as unknown as ScriptKeywordArgs
    await assertScriptingPlan(ctx)
    const row = await findScriptByName(ctx, args.name)
    const trig = triggerOf(row)
    const base = { opId: 'script-update-keyword' as const }

    if (!trig || scriptTriggerEvent({ nodes: row.nodes as never, rootNodeId: row.rootNodeId }) === 'follow')
      throw new AdminOpUserError(`「${row.name}」是客人加好友時啟動的，沒有關鍵字可以改。（請照實告訴他。）`)
    if ((trig.matchMode ?? 'keyword') !== 'keyword')
      throw new AdminOpUserError(`「${row.name}」是「看意思」判斷的，要改的是範例句不是關鍵字——請他到自動回應頁改。`)
    if (trig.keywordMatch === 'anyText')
      throw new AdminOpUserError(`「${row.name}」設的是「客人輸入任何內容」都會啟動，沒有關鍵字可以改——請他到自動回應頁看。`)

    const list: string[] = Array.isArray(trig.keywords) ? trig.keywords.map(String) : []
    const has = list.some(k => k.trim().toLowerCase() === args.keyword.toLowerCase())
    if (args.action === 'add' && has)
      return { ...base, summary: `「${row.name}」本來就有「${args.keyword}」這個關鍵字，不用再加。`, items: [], confirmLabel: '知道了', noop: true }
    if (args.action === 'remove' && !has)
      return { ...base, summary: `「${row.name}」沒有「${args.keyword}」這個關鍵字，沒有東西要拿掉。`, items: [], confirmLabel: '知道了', noop: true }
    if (args.action === 'remove' && list.length === 1)
      throw new AdminOpUserError(`「${args.keyword}」是「${row.name}」唯一的關鍵字，拿掉之後這條永遠不會啟動——要停用的話請他叫我「下架」。`)
    // ⛔ 存檔端點超過上限會**直接截掉**最後面的（新加的就排在最後）——不先擋，卡上寫「加好了」、客人打那個詞卻永遠走不到
    if (args.action === 'add' && list.length >= MAX_TRIGGER_KEYWORDS)
      throw new AdminOpUserError(`「${row.name}」已經有 ${list.length} 個關鍵字，一條最多 ${MAX_TRIGGER_KEYWORDS} 個，加不進去了——要先拿掉一個（可以叫我拿掉），或到自動回應頁另開一條。（請照實告訴他。）`)

    const after = args.action === 'add' ? [...list, args.keyword] : list.filter(k => k.trim().toLowerCase() !== args.keyword.toLowerCase())
    return {
      ...base,
      summary: args.action === 'add'
        ? `我會在「${row.name}」加上關鍵字「${args.keyword}」。`
        : `我會把「${args.keyword}」從「${row.name}」的關鍵字拿掉。`,
      items: [
        { label: list.join('、'), note: '現在的關鍵字' },
        { label: after.join('、'), note: '改成' },
        ...(row.enabled ? [] : [{ label: '這條目前是停用的', note: '改完也不會生效，要上架才會' }]),
      ],
      warning: args.action === 'add'
        ? (args.keyword.length <= 1
            ? `⚠️「${args.keyword}」只有一個字，客人很多句話裡都會出現它，這條可能會被誤觸。`
            : `之後客人講到「${args.keyword}」就會走這條，AI 不會再回答那幾句話。`)
        : `之後客人講「${args.keyword}」不會再走這條，改由 AI 或其他設定接手。`,
      confirmLabel: args.action === 'add' ? '確定加關鍵字' : '確定拿掉關鍵字',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as ScriptKeywordArgs
    const row = await findScriptByName(ctx, args.name)
    const trig = triggerOf(row)
    if (!trig) return { ok: false, message: `「${row.name}」找不到啟動條件，沒有動任何設定。` }
    const list: string[] = Array.isArray(trig.keywords) ? trig.keywords.map(String) : []
    const after = args.action === 'add'
      ? (list.some(k => k.trim().toLowerCase() === args.keyword.toLowerCase()) ? list : [...list, args.keyword])
      : list.filter(k => k.trim().toLowerCase() !== args.keyword.toLowerCase())
    if (after.length === list.length && after.every((k, i) => k === list[i]))
      return { ok: true, message: '本來就是這樣，沒有動任何設定。' }
    // 提議到按下去之間有人在頁面上加滿了：照送的話新詞會被存檔端點截掉（見 preview 那一道）
    if (after.length > MAX_TRIGGER_KEYWORDS)
      return { ok: false, message: `「${row.name}」現在已經有 ${list.length} 個關鍵字（上限 ${MAX_TRIGGER_KEYWORDS} 個），「${args.keyword}」加不進去，沒有動任何設定。要先拿掉一個再加。` }

    const nodes = row.nodes.map(n => (n === trig ? { ...n, keywords: after } : n))
    try {
      await callApi(ctx, `/api/ai/scripts/${encodeURIComponent(row.id)}`, { method: 'PUT', body: scriptPutBody(row, nodes) })
    }
    catch (e: any) {
      return { ok: false, message: `沒有改成功：${apiErrorText(e) || '請稍後再試'}。沒有動任何設定。` }
    }

    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('script-update-keyword'),
      targetId: row.id,
      before: { keywords: list },
      after: { keywords: after },
      note: `「${row.name}」${args.action === 'add' ? '加上' : '拿掉'}關鍵字「${args.keyword}」`,
    }, ctx.db)

    return {
      ok: true,
      message: args.action === 'add'
        ? `改好了：「${row.name}」多了關鍵字「${args.keyword}」。`
        : `改好了：「${row.name}」拿掉了關鍵字「${args.keyword}」。`,
    }
  },
}

interface ScriptReplyArgs { name: string, text: string }

export const scriptUpdateReply: AdminOpDef = {
  capability: 'scripts.write',
  targetField: 'name',
  freeTextFields: ['text'],
  argsHint: '參數：{"name":"自動回應的名字","text":"新的回覆內容（整段）"}。name 要照清單一字不差。'
    + '⛔ text 要照他講的寫，不要自己加促銷詞或表情符號。只適用「只有一段回覆」的那種；多步驟的請他到自動回應頁改。',

  normalize(raw) {
    const name = String(raw?.name ?? '').trim().slice(0, 100)
    const text = String(raw?.text ?? '').trim().slice(0, 2000)
    if (!name) throw new AdminOpUserError('要先問清楚是哪一條自動回應（可以先列出清單讓他挑）。')
    if (text.length < 2) throw new AdminOpUserError('要先問清楚要改成回什麼。')
    return { name, text } satisfies ScriptReplyArgs as unknown as Record<string, unknown>
  },

  async fingerprint(ctx, raw) {
    return scriptFingerprint(await findScriptByName(ctx, (raw as unknown as ScriptReplyArgs).name))
  },

  async preview(ctx, raw) {
    const args = raw as unknown as ScriptReplyArgs
    await assertScriptingPlan(ctx)
    const row = await findScriptByName(ctx, args.name)
    const replies = row.nodes.filter(n => n?.type === 'reply')
    const base = { opId: 'script-update-reply' as const }

    if (replies.length !== 1) {
      throw new AdminOpUserError(
        replies.length
          ? `「${row.name}」有 ${replies.length} 段回覆，我沒辦法確定要改哪一段——請他到自動回應頁改。`
          : `「${row.name}」沒有回覆文字（可能是直接送模組），請他到自動回應頁改。`,
      )
    }
    const before = String(replies[0]!.text ?? '')
    if (before.trim() === args.text.trim())
      return { ...base, summary: `「${row.name}」回的本來就是這段話，不用改。`, items: [], confirmLabel: '知道了', noop: true }

    return {
      ...base,
      summary: `我會把「${row.name}」回給客人的話改成下面這段。`,
      items: [
        { label: before || '（空的）', note: '現在' },
        { label: args.text, note: '改成' },
        ...(row.enabled ? [] : [{ label: '這條目前是停用的', note: '改完也不會生效，要上架才會' }]),
      ],
      warning: '客人下次打中這條，收到的就是新的這段話。',
      confirmLabel: '確定改回覆內容',
    }
  },

  async execute(ctx, raw) {
    const args = raw as unknown as ScriptReplyArgs
    const row = await findScriptByName(ctx, args.name)
    const replies = row.nodes.filter(n => n?.type === 'reply')
    if (replies.length !== 1) return { ok: false, message: `「${row.name}」的回覆段數變了，沒有動任何設定——請到自動回應頁看。` }
    const target = replies[0]!
    const before = String(target.text ?? '')
    if (before.trim() === args.text.trim()) return { ok: true, message: '本來就是這段話，沒有動任何設定。' }

    const nodes = row.nodes.map(n => (n === target ? { ...n, text: args.text } : n))
    try {
      await callApi(ctx, `/api/ai/scripts/${encodeURIComponent(row.id)}`, { method: 'PUT', body: scriptPutBody(row, nodes) })
    }
    catch (e: any) {
      return { ok: false, message: `沒有改成功：${apiErrorText(e) || '請稍後再試'}。沒有動任何設定。` }
    }

    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'agent',
      action: adminOpAuditAction('script-update-reply'),
      targetId: row.id,
      before: { replyText: before },
      after: { replyText: args.text },
      note: `改了「${row.name}」回給客人的話`,
    }, ctx.db)

    return { ok: true, message: `改好了：「${row.name}」現在會回新的那段話。` }
  },
}
