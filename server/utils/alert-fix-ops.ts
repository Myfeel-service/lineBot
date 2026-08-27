/**
 * 異常「一鍵幫我修」的操作模組表（`D-34`，2026-08-27 老闆拍板；`C-31` Phase 2 的首批寫入出口）。
 *
 * 每個 op 兩段：
 *   preview() —— 當下查實況，回「會動哪幾筆、做什麼、有什麼風險」。popup 的每一句都從這裡來，
 *                ⛔前端不寫死動作說明（講的跟做的必須出自同一次查詢）。
 *   execute() —— 冪等、可重按；每次寫 auditLogs（actor='human'：是人按的確定）。
 *
 * 鐵律：
 *   - 全部是確定性動作、**零 LLM**——模型不參與、不生 ID、不重生內容。
 *   - 訊號口徑不開第二份：查「哪幾筆壞」一律吃 workspace-alerts 匯出的同一個查法／同一扇窗，
 *     probe 說「就是這幾筆」、一鍵修動的就是同幾筆。
 *   - 修復動作能走既有端點的走既有端點（內部 $fetch 轉發呼叫者憑證，權限由該端點把關，
 *     與 ai-admin-agent 工具同一招）；直接寫 DB 的只有腳本兩個 op（沒有現成端點）。
 *   - 紅線（08-14 拍板）：這裡沒有任何 op 會發訊息給客人、動錢、動憑證內容、刪東西——
 *     推播 op 只重設回草稿（發送留人）；webhook op 改的是「訊息送到哪」，preview 必列前後對照。
 *   - 執行完「修好了沒」由前端 refresh({force:true}) 重跑同一份異常訊號判定，這裡不自行宣告。
 *
 * 加一個 op：shared/types/alert-fix.ts 加 id → 這裡加一筆 → useWorkspaceAlerts 註冊表掛 fixOpId
 * （useWorkspaceAlerts.test.ts 會釘住三處一致）。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import type { AlertFixExecuteResult, AlertFixOpId, AlertFixPreview } from '~~/shared/types/alert-fix'
import type { WorkspaceAlertId } from '~~/shared/types/alerts'
import {
  addSkipExitsToCollects,
  DEFAULT_SKIP_EXIT_LABEL,
  findStuckCollects,
  type ScriptNode,
} from '~~/shared/types/ai-script'
import { writeAuditLog } from './audit-log'
import { SCRIPTS_COLLECTION } from './ai-scripts'
import { invalidateScriptHealthCache } from './script-health'
import {
  BROADCAST_FAILED_WINDOW_MS,
  findAnyTextBlockingScripts,
  invalidateWebhookProbe,
  KNOWLEDGE_PENDING_STUCK_MS,
} from './workspace-alerts'
import { KNOWLEDGE_SOURCES_COLLECTION } from './ai-knowledge-sources'
import { buildEmbeddingText, KNOWLEDGE_CHUNKS_COLLECTION, runIndexOnChunk } from './ai-knowledge-chunks'
import { recordAiUsage } from './ai-usage'
import { getLineWorkspaceCredentials } from './line-workspace-credentials'
import { fetchLineWebhookEndpoint, normalizeWebhookCompareUrl, putLineWebhookEndpoint } from './line-webhook-remote'

export interface AlertFixCtx {
  db: Firestore
  workspaceId: string
  uid: string
  /** 呼叫者的 Authorization header：轉發給自家 API 的 op 用，權限由該端點自行把關 */
  authHeader?: string
}

export interface AlertFixOpDef {
  /** 這個 op 修的是哪顆異常（前端註冊表 fixOpId 的反向；測試釘住一致） */
  alertId: WorkspaceAlertId
  /** 執行門檻：與異常註冊表同一把尺（operate=agent、settings=admin） */
  minRole: Extract<WorkspaceMemberRole, 'agent' | 'admin'>
  preview: (ctx: AlertFixCtx) => Promise<AlertFixPreview>
  execute: (ctx: AlertFixCtx) => Promise<AlertFixExecuteResult>
}

/** 一次最多處理幾筆：一鍵修是「把現在壞的修掉」不是批次工具，上限防極端資料拖垮請求 */
const FIX_SCAN_LIMIT = 10
/** 重學知識卡的單次上限（100 × ~300ms / 併發 5 ≈ 6s，留在請求時限內；沒修完可再按一次） */
const REINDEX_LIMIT = 100
const EMBED_CONCURRENCY = 5

/** 從 $fetch / createError 的失敗物件裡撈一句人看得懂的原因 */
function errMessage(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }; statusMessage?: string; message?: string }
  return String(err?.data?.statusMessage || err?.statusMessage || err?.message || '未知錯誤').slice(0, 160)
}

/** 內部轉發共用的 fetch 選項：帶呼叫者憑證與 workspaceId（目標端點自己驗權限） */
function forwardOpts(ctx: AlertFixCtx, body?: Record<string, unknown>) {
  return {
    method: 'POST' as const,
    query: { workspaceId: ctx.workspaceId },
    headers: ctx.authHeader ? { authorization: ctx.authHeader } : undefined,
    ...(body ? { body } : {}),
  }
}

// ── LINE 收訊網址 ───────────────────────────────────────────────

/** webhook op 的共用分診：查一次 LINE，回「能不能修、怎麼修」 */
async function diagnoseWebhookFix(ctx: AlertFixCtx): Promise<
  | { kind: 'blocked'; summary: string }
  | { kind: 'clear'; summary: string }
  | { kind: 'fixable'; current: string; target: string; active: boolean; token: string }
> {
  // 正確答案＝對外正式網址（與 probe 同一把尺）；沒設或本機網址就給不出正確答案，別亂改
  const canonical = String(useRuntimeConfig().appBaseUrl || '').trim().replace(/\/$/, '')
  if (!canonical || /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(canonical))
    return { kind: 'blocked', summary: '系統這邊還沒設定對外正式網址，我給不出要填的收訊網址——請聯絡我們處理。' }

  const { channelAccessToken } = await getLineWorkspaceCredentials(ctx.workspaceId)
  const token = channelAccessToken.trim()
  if (!token)
    return { kind: 'blocked', summary: '這個工作區還沒存 LINE 的鑰匙（Channel Access Token），要先完成 LINE 連接才談得到收訊網址。' }

  const target = `${canonical}/webhook`
  const res = await fetchLineWebhookEndpoint(token)
  if (!res.ok) {
    if (res.status === 401)
      return { kind: 'blocked', summary: 'LINE 不認得目前的鑰匙（Token 失效，多半是被重發過）——網址改不動。請按「用聊天帶我修」，我教你重發鑰匙。' }
    if (res.status === 404)
      // LINE 後台連網址都還沒填：一樣用 PUT 直接填上（跟「填錯」是同一支寫入 API）
      return { kind: 'fixable', current: '', target, active: true, token }
    return { kind: 'blocked', summary: '這次問不到 LINE 那邊的設定（不代表壞掉），等幾分鐘再試一次。' }
  }
  const current = res.data.endpoint
  if (normalizeWebhookCompareUrl(current) === normalizeWebhookCompareUrl(target)) {
    if (res.data.active === false)
      return { kind: 'blocked', summary: '網址已經是正式網址了，問題出在「Use webhook」開關沒開——那個開關沒有 API 能代開，請按「用聊天帶我修」，我指給你看在哪裡開。' }
    return { kind: 'clear', summary: '再查了一次，LINE 上填的已經是正式網址、開關也是開的。' }
  }
  return { kind: 'fixable', current, target, active: res.data.active, token }
}

const lineWebhookSetUrl: AlertFixOpDef = {
  alertId: 'lineWebhookUrlMismatch',
  minRole: 'admin',
  async preview(ctx) {
    const d = await diagnoseWebhookFix(ctx)
    const base = { opId: 'line-webhook-set-url' as const, alertId: this.alertId }
    if (d.kind !== 'fixable')
      return { ...base, state: d.kind, summary: d.summary, items: [] }
    const items = [
      ...(d.current ? [{ label: d.current, note: '現在 LINE 上填的' }] : [{ label: '（空白）', note: '現在 LINE 上還沒填收訊網址' }]),
      { label: d.target, note: '會換成這串（這套系統的正式網址）' },
    ]
    return {
      ...base,
      state: 'fixable',
      summary: d.current
        ? '我會把 LINE 上登記的收訊網址換成這套系統的正式網址（用 LINE 官方 API 代改，改完當場再驗一次）。'
        : 'LINE 後台還沒填收訊網址，我會直接把正式網址填上去（用 LINE 官方 API 代填，填完當場再驗一次）。',
      items,
      warning: [
        d.current ? '若舊網址還接著另一套在用的系統，換完之後客人訊息會改送進這裡、那套系統就收不到了。確定這個官方帳號要用這套系統再按。' : '',
        d.active === false ? '另外「Use webhook」開關目前是關的——網址換好後還要到 LINE 後台把開關打開，訊息才會真的進來。' : '',
      ].filter(Boolean).join(' '),
      confirmLabel: d.current ? '確定換網址' : '確定填上網址',
    }
  },
  async execute(ctx) {
    const d = await diagnoseWebhookFix(ctx)
    if (d.kind === 'clear') return { ok: true, message: d.summary }
    if (d.kind === 'blocked') return { ok: false, message: d.summary }
    const put = await putLineWebhookEndpoint(d.token, d.target)
    if (!put.ok)
      return { ok: false, message: `LINE 不接受這次修改（HTTP ${put.status}），沒有動到任何設定。等幾分鐘再試，一直失敗請聯絡我們。` }
    // 快取要當場戳掉，否則接下來 5 分鐘的驗證都會拿到改之前的答案
    invalidateWebhookProbe(ctx.workspaceId)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'human',
      action: 'alert-fix/line-webhook-set-url',
      before: { endpoint: d.current || '(未設定)' },
      after: { endpoint: d.target },
    }, ctx.db)
    return {
      ok: true,
      message: d.active === false
        ? '網址已經換好了。⚠️「Use webhook」開關還是關的——要到 LINE 後台打開它，訊息才會真的進來（按「用聊天帶我修」我指給你看）。'
        : '已把 LINE 上的收訊網址換成正式網址。',
    }
  },
}

// ── 知識來源：同步失敗再試一次 ──────────────────────────────────

interface FailedSourceRow { id: string; name: string; type: string }

/** 與 knowledgeSyncFailed probe 同一個查法：status=='failed' 的來源 */
async function listFailedSources(ctx: AlertFixCtx): Promise<FailedSourceRow[]> {
  const snap = await ctx.db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('workspaceId', '==', ctx.workspaceId)
    .where('status', '==', 'failed')
    .select('name', 'type', 'url')
    .limit(FIX_SCAN_LIMIT)
    .get()
  return snap.docs.map(d => ({
    id: d.id,
    name: String((d.data() as Record<string, unknown>).name ?? '(未命名來源)'),
    type: String((d.data() as Record<string, unknown>).type ?? ''),
  }))
}

const knowledgeRefetchSources: AlertFixOpDef = {
  alertId: 'knowledgeSyncFailed',
  minRole: 'agent',
  async preview(ctx) {
    const failed = await listFailedSources(ctx)
    const base = { opId: 'knowledge-refetch-sources' as const, alertId: this.alertId }
    if (!failed.length)
      return { ...base, state: 'clear', summary: '再查了一次，已經沒有同步失敗的資料（可能剛剛自己恢復了）。', items: [] }
    return {
      ...base,
      state: 'fixable',
      summary: `我會對這 ${failed.length} 份同步失敗的資料各再試一次：現在就去抓最新內容，抓成功就解除失敗。還是抓不到的會列出原因（那通常要先處理來源本身，例如試算表沒分享）。`,
      items: failed.map(s => ({
        label: s.name,
        note: s.type === 'url'
          ? '會現在去抓一次網頁'
          : s.type === 'gsheet'
            ? '會立即同步一次試算表'
            : '檔案類無法自動重抓，要重新匯入',
      })),
      confirmLabel: '確定再試一次',
    }
  },
  async execute(ctx) {
    const failed = await listFailedSources(ctx)
    if (!failed.length) return { ok: true, message: '再查了一次，已經沒有同步失敗的資料。' }
    const details: string[] = []
    let healed = 0
    for (const s of failed) {
      try {
        if (s.type === 'url') {
          // 走既有的重新同步端點：抓取成功它自己會清失敗標記（買一送一的復原路徑）
          const r = await $fetch<{ status?: string; jobId?: string }>(`/api/ai/sources/${s.id}/resync-jobs`, forwardOpts(ctx, {}))
          healed++
          details.push(r.status === 'unchanged'
            ? `「${s.name}」已恢復（內容沒有變）`
            : `「${s.name}」抓到了；內容有變，到知識庫按「前往比對」逐份確認要不要更新`)
        }
        else if (s.type === 'gsheet') {
          const r = await $fetch<{ outcome?: string }>(`/api/ai/sources/${s.id}/gsheet-sync`, forwardOpts(ctx, {}))
          if (r.outcome === 'blocked_mass_deletion') {
            // 大量刪除的確認要留給人（刪除紅線）：這裡不代按同意
            details.push(`「${s.name}」同步會刪掉大量卡片，需要人工確認——請到知識庫按「立即同步」走確認流程`)
          }
          else {
            healed++
            details.push(`「${s.name}」已同步`)
          }
        }
        else {
          details.push(`「${s.name}」是檔案類，無法自動重抓——請重新匯入檔案`)
        }
      }
      catch (e) {
        details.push(`「${s.name}」還是失敗：${errMessage(e)}`)
      }
    }
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'human',
      action: 'alert-fix/knowledge-refetch-sources',
      note: `重試 ${failed.length} 份，成功 ${healed} 份`,
    }, ctx.db)
    return {
      ok: healed > 0,
      message: healed === failed.length
        ? `這 ${failed.length} 份都重試成功了。`
        : `${healed} / ${failed.length} 份重試成功，其餘的原因列在下面——那些通常要先處理來源本身。`,
      details,
    }
  },
}

// ── 知識卡：重試學習（失敗／卡住共用同一個工人） ────────────────

async function reindexChunks(
  ctx: AlertFixCtx,
  docs: { id: string; data: Record<string, unknown> }[],
): Promise<{ indexed: number; failed: number; failures: string[] }> {
  let indexed = 0
  const failures: string[] = []
  let embeddingTokens = 0
  let cursor = 0
  async function worker() {
    while (cursor < docs.length) {
      const doc = docs[cursor++]!
      const r = await runIndexOnChunk(
        ctx.db,
        doc.id,
        buildEmbeddingText(
          String(doc.data.title ?? ''),
          String(doc.data.content ?? ''),
          Array.isArray(doc.data.questions) ? doc.data.questions.map(String) : [],
        ),
      )
      if (r.status === 'indexed') {
        indexed++
        embeddingTokens += r.embeddingTokens
      }
      else {
        failures.push(`「${String(doc.data.title ?? doc.id).slice(0, 30)}」：${String(r.failureReason ?? '未知原因').slice(0, 80)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, docs.length) }, worker))
  // 逐卡記帳會對同一份月用量文件連打被節流：累計、最後記一次（與 reindex 端點同款）
  if (embeddingTokens > 0) await recordAiUsage(ctx.workspaceId, { buildEmbeddingTokens: embeddingTokens }, ctx.db)
  return { indexed, failed: failures.length, failures }
}

/** status=='failed' 的卡（與 knowledgeIndexFailed probe 同一個等值查詢） */
async function listFailedChunks(ctx: AlertFixCtx) {
  const snap = await ctx.db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', ctx.workspaceId)
    .where('status', '==', 'failed')
    .select('title', 'content', 'questions')
    .limit(REINDEX_LIMIT)
    .get()
  return snap.docs
    .filter(d => String((d.data() as Record<string, unknown>).content ?? '').trim())
    .map(d => ({ id: d.id, data: d.data() as Record<string, unknown> }))
}

/** pending 超過一小時的卡（與 knowledgeIndexStuck probe 同一扇「多久算卡住」的窗） */
async function listStuckChunks(ctx: AlertFixCtx) {
  const snap = await ctx.db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', ctx.workspaceId)
    .where('status', '==', 'pending')
    .select('title', 'content', 'questions', 'updatedAt')
    .limit(REINDEX_LIMIT)
    .get()
  const cutoff = Date.now() - KNOWLEDGE_PENDING_STUCK_MS
  return snap.docs
    .filter((d) => {
      const raw = (d.data() as Record<string, unknown>).updatedAt as { toMillis?: () => number } | undefined
      const ms = typeof raw?.toMillis === 'function' ? raw.toMillis() : 0
      return ms > 0 && ms < cutoff && String((d.data() as Record<string, unknown>).content ?? '').trim()
    })
    .map(d => ({ id: d.id, data: d.data() as Record<string, unknown> }))
}

function reindexPreview(
  opId: AlertFixOpId,
  alertId: WorkspaceAlertId,
  rows: { data: Record<string, unknown> }[],
  what: string,
): AlertFixPreview {
  if (!rows.length)
    return { opId, alertId, state: 'clear', summary: `再查了一次，已經沒有${what}的知識卡。`, items: [] }
  const names = rows.slice(0, 5).map(r => ({ label: String(r.data.title ?? '(未命名知識卡)').slice(0, 40) }))
  if (rows.length > names.length) names.push({ label: `…共 ${rows.length} 張` })
  return {
    opId,
    alertId,
    state: 'fixable',
    summary: `我會把${what}的 ${rows.length} 張知識卡重新學一次（重算 AI 索引，內容不會被改動）。學不起來的會列出原因。`,
    items: names,
    confirmLabel: '確定重新學習',
  }
}

async function reindexExecute(
  ctx: AlertFixCtx,
  action: string,
  rows: { id: string; data: Record<string, unknown> }[],
): Promise<AlertFixExecuteResult> {
  if (!rows.length) return { ok: true, message: '再查了一次，已經沒有要重學的知識卡。' }
  const r = await reindexChunks(ctx, rows)
  await writeAuditLog({
    workspaceId: ctx.workspaceId,
    uid: ctx.uid,
    actor: 'human',
    action,
    note: `重學 ${rows.length} 張：成功 ${r.indexed}、失敗 ${r.failed}`,
  }, ctx.db)
  return {
    ok: r.indexed > 0 || r.failed === 0,
    message: r.failed === 0
      ? `這 ${rows.length} 張都重新學好了，AI 現在讀得到它們。`
      : `${r.indexed} / ${rows.length} 張重學成功；還學不起來的列在下面，一直失敗請聯絡我們。`,
    details: r.failures,
  }
}

const knowledgeRetryIndex: AlertFixOpDef = {
  alertId: 'knowledgeIndexFailed',
  minRole: 'agent',
  async preview(ctx) {
    return reindexPreview('knowledge-retry-index', this.alertId, await listFailedChunks(ctx), '學習失敗')
  },
  async execute(ctx) {
    return reindexExecute(ctx, 'alert-fix/knowledge-retry-index', await listFailedChunks(ctx))
  },
}

const knowledgeRetryIndexStuck: AlertFixOpDef = {
  alertId: 'knowledgeIndexStuck',
  minRole: 'agent',
  async preview(ctx) {
    return reindexPreview('knowledge-retry-index-stuck', this.alertId, await listStuckChunks(ctx), '卡住沒學完')
  },
  async execute(ctx) {
    return reindexExecute(ctx, 'alert-fix/knowledge-retry-index-stuck', await listStuckChunks(ctx))
  },
}

// ── 腳本：停用「輸入任何內容」的攔截 ────────────────────────────

const scriptDisableAnyText: AlertFixOpDef = {
  alertId: 'anyTextBlocking',
  minRole: 'agent',
  async preview(ctx) {
    const hits = await findAnyTextBlockingScripts(ctx.db, ctx.workspaceId)
    const base = { opId: 'script-disable-anytext' as const, alertId: this.alertId }
    if (!hits.length)
      return { ...base, state: 'clear', summary: '再查了一次，已經沒有「輸入任何內容」就攔截的設定。', items: [] }
    return {
      ...base,
      state: 'fixable',
      summary: `我會停用下面這 ${hits.length} 條「客人輸入任何內容」就攔截的設定。停用之後客人的訊息才輪得到 AI 與其他設定；隨時可以到客服流程頁再開回來。`,
      items: hits.map(h => ({ label: h.name, note: '會停用（不會刪除，內容都留著）' })),
      warning: '這條設定原本回覆的內容，停用後客人就不會再收到。想保留它的話，改成關鍵字觸發就不會攔到全部訊息——那要到客服流程頁改。',
      confirmLabel: '確定停用',
    }
  },
  async execute(ctx) {
    const hits = await findAnyTextBlockingScripts(ctx.db, ctx.workspaceId)
    if (!hits.length) return { ok: true, message: '再查了一次，已經沒有攔截全部訊息的設定。' }
    for (const h of hits) {
      // 只動 enabled 這一格（⛔不整包覆蓋文件），設定本體原封不動、可隨時開回來
      await ctx.db.collection(SCRIPTS_COLLECTION).doc(h.id).update({
        enabled: false,
        updatedAt: FieldValue.serverTimestamp(),
      })
      await writeAuditLog({
        workspaceId: ctx.workspaceId,
        uid: ctx.uid,
        actor: 'human',
        action: 'alert-fix/script-disable-anytext',
        before: { enabled: true },
        after: { enabled: false },
        note: `停用「${h.name}」（輸入任何內容的攔截）`,
      }, ctx.db)
    }
    // 腳本健康的 5 分鐘快取要戳掉，驗證才看得到停用後的世界
    invalidateScriptHealthCache(ctx.workspaceId)
    return {
      ok: true,
      message: `已停用${hits.map(h => `「${h.name}」`).join('、')}。客人的訊息現在輪得到 AI 了；想改成關鍵字觸發再開回來，到客服流程頁處理。`,
    }
  },
}

// ── 腳本：卡死的收集題補跳過出口 ────────────────────────────────

interface StuckScriptRow {
  id: string
  name: string
  nodes: ScriptNode[]
  stuck: { nodeId: string; question: string; nextLabel: string }[]
}

/** 與 scriptDeadEnd probe 同一個判定（findStuckCollects），只是這裡連 nodes 一起帶回來好動手修 */
async function listStuckScripts(ctx: AlertFixCtx): Promise<StuckScriptRow[]> {
  const snap = await ctx.db.collection(SCRIPTS_COLLECTION)
    .where('workspaceId', '==', ctx.workspaceId)
    .where('enabled', '==', true)
    .get()
  const out: StuckScriptRow[] = []
  for (const d of snap.docs) {
    const s = d.data() as { name?: string; nodes?: ScriptNode[] }
    const nodes = Array.isArray(s.nodes) ? s.nodes : []
    const stuck = findStuckCollects(nodes)
      // 補法是 skipNext=原本的 next：沒有 next 的孤兒節點補不了（跟 AI 生成端同一個限制）
      .filter(st => nodes.some(n => n.id === st.nodeId && n.type === 'collect' && n.next))
      .map((st) => {
        const node = nodes.find(n => n.id === st.nodeId && n.type === 'collect')
        const next = node && 'next' in node ? nodes.find(n => n.id === (node as { next?: string }).next) : undefined
        const nextLabel = next
          ? ('question' in next && next.question) || ('text' in next && (next as { text?: string }).text) || ''
          : ''
        return { nodeId: st.nodeId, question: st.question, nextLabel: String(nextLabel).slice(0, 30) }
      })
    if (stuck.length) out.push({ id: d.id, name: String(s.name || '(未命名流程)'), nodes, stuck })
  }
  return out
}

const scriptAddSkipExit: AlertFixOpDef = {
  alertId: 'scriptDeadEnd',
  minRole: 'agent',
  async preview(ctx) {
    const rows = await listStuckScripts(ctx)
    const base = { opId: 'script-add-skip-exit' as const, alertId: this.alertId }
    if (!rows.length)
      return { ...base, state: 'clear', summary: '再查了一次，啟用中的流程已經沒有會卡死客人的步驟。', items: [] }
    const items = rows.flatMap(r => r.stuck.map(st => ({
      label: `「${r.name}」問「${st.question.slice(0, 30)}」這一題`,
      note: `會加上「${DEFAULT_SKIP_EXIT_LABEL}」按鈕；客人按了就跳過這一題${st.nextLabel ? `，直接走原本的下一步（${st.nextLabel}）` : '，直接走原本的下一步'}`,
    })))
    return {
      ...base,
      state: 'fixable',
      summary: `我會幫下面這 ${items.length} 題補一顆跳過按鈕。這幾題問的是客人手上可能根本沒有的資料，沒有退路的話答不出來的客人會被同一題無限重問。`,
      items,
      // 按鈕字樣客人看得到：popup 原文展示、由人看過才執行（08-27 拍板的守門方式）
      warning: `按鈕上的字「${DEFAULT_SKIP_EXIT_LABEL}」客人看得到；想改字樣、或想讓跳過的人改走別條路（例如轉真人），之後到客服流程編輯器調整。`,
      confirmLabel: '確定加上跳過按鈕',
    }
  },
  async execute(ctx) {
    const rows = await listStuckScripts(ctx)
    if (!rows.length) return { ok: true, message: '再查了一次，已經沒有要補退路的步驟。' }
    const details: string[] = []
    for (const r of rows) {
      const ids = new Set(r.stuck.map(s => s.nodeId))
      const nodes = addSkipExitsToCollects(r.nodes, ids)
      // 只動 nodes 這一格：觸發統計、啟用狀態等其他欄位原封不動
      await ctx.db.collection(SCRIPTS_COLLECTION).doc(r.id).update({
        nodes,
        updatedAt: FieldValue.serverTimestamp(),
      })
      await writeAuditLog({
        workspaceId: ctx.workspaceId,
        uid: ctx.uid,
        actor: 'human',
        action: 'alert-fix/script-add-skip-exit',
        note: `「${r.name}」補 ${r.stuck.length} 個跳過出口（${DEFAULT_SKIP_EXIT_LABEL}）：${r.stuck.map(s => s.nodeId).join('、')}`,
      }, ctx.db)
      details.push(`「${r.name}」補了 ${r.stuck.length} 題`)
    }
    invalidateScriptHealthCache(ctx.workspaceId)
    return {
      ok: true,
      message: '跳過按鈕都加好了，客人答不出來也走得下去。想調整字樣或改走別條路，到客服流程編輯器那一題就能改。',
      details,
    }
  },
}

// ── 推播：發送失敗重設回草稿 ────────────────────────────────────

/** 與 broadcastFailed probe 同一個查法＋同一扇 3 天窗 */
async function listRecentFailedBroadcasts(ctx: AlertFixCtx): Promise<{ id: string; name: string }[]> {
  const snap = await ctx.db.collection('broadcasts')
    .where('workspaceId', '==', ctx.workspaceId)
    .where('status', '==', 'failed')
    .select('name', 'updatedAt')
    .limit(FIX_SCAN_LIMIT)
    .get()
  const cutoff = Date.now() - BROADCAST_FAILED_WINDOW_MS
  return snap.docs
    .filter((d) => {
      const raw = (d.data() as Record<string, unknown>).updatedAt as { toMillis?: () => number } | undefined
      return (typeof raw?.toMillis === 'function' ? raw.toMillis() : 0) >= cutoff
    })
    .map(d => ({ id: d.id, name: String((d.data() as Record<string, unknown>).name ?? '(未命名推播)') }))
}

const broadcastResetFailed: AlertFixOpDef = {
  alertId: 'broadcastFailed',
  minRole: 'agent',
  async preview(ctx) {
    const failed = await listRecentFailedBroadcasts(ctx)
    const base = { opId: 'broadcast-reset-failed' as const, alertId: this.alertId }
    if (!failed.length)
      return { ...base, state: 'clear', summary: '再查了一次，近三天已經沒有發送失敗的推播。', items: [] }
    return {
      ...base,
      state: 'fixable',
      summary: `我會把這 ${failed.length} 則發送失敗的推播重設回草稿、清掉上一次的失敗紀錄。⛔不會自動發送——要不要再發、什麼時候發，到推播頁由你按。`,
      items: failed.map(b => ({ label: b.name, note: '會重設回草稿（內容與名單設定都留著）' })),
      confirmLabel: '確定重設為草稿',
    }
  },
  async execute(ctx) {
    const failed = await listRecentFailedBroadcasts(ctx)
    if (!failed.length) return { ok: true, message: '再查了一次，已經沒有發送失敗的推播。' }
    const details: string[] = []
    let done = 0
    for (const b of failed) {
      try {
        // 走既有的重設端點：清舊帳→交易內翻草稿的順序與防重複它都處理好了
        await $fetch(`/api/broadcast/${b.id}/retry`, forwardOpts(ctx))
        done++
        details.push(`「${b.name}」已重設回草稿`)
      }
      catch (e) {
        // 409＝狀態已經不是失敗（可能有人剛處理過）：不算錯，如實講
        const status = (e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status
        details.push(status === 409
          ? `「${b.name}」狀態已經不是「失敗」（可能有人剛處理過），沒有動它`
          : `「${b.name}」重設失敗：${errMessage(e)}`)
      }
    }
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'human',
      action: 'alert-fix/broadcast-reset-failed',
      note: `重設 ${done} / ${failed.length} 則失敗推播回草稿`,
    }, ctx.db)
    return {
      ok: done > 0,
      message: done === failed.length
        ? `這 ${failed.length} 則都重設回草稿了。處理好失敗原因後，到推播頁再發送。`
        : `${done} / ${failed.length} 則重設成功，其餘的狀況列在下面。`,
      details,
    }
  },
}

// ── 註冊表 ──────────────────────────────────────────────────────

export const ALERT_FIX_OPS: Record<AlertFixOpId, AlertFixOpDef> = {
  'line-webhook-set-url': lineWebhookSetUrl,
  'knowledge-refetch-sources': knowledgeRefetchSources,
  'knowledge-retry-index': knowledgeRetryIndex,
  'knowledge-retry-index-stuck': knowledgeRetryIndexStuck,
  'script-disable-anytext': scriptDisableAnyText,
  'script-add-skip-exit': scriptAddSkipExit,
  'broadcast-reset-failed': broadcastResetFailed,
}

/** 端點用：不認得的 opId 一律 400（不猜、不做最接近的事） */
export function getAlertFixOp(opId: string): { opId: AlertFixOpId; op: AlertFixOpDef } {
  if (!Object.prototype.hasOwnProperty.call(ALERT_FIX_OPS, opId))
    throw createError({ statusCode: 400, statusMessage: `未知的修復動作：${String(opId).slice(0, 60)}` })
  return { opId: opId as AlertFixOpId, op: ALERT_FIX_OPS[opId as AlertFixOpId] }
}
