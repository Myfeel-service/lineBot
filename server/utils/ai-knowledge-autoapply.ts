/**
 * 網頁來源「小改自動套用」(P2-7 後半;前半=pendingHash 防輪播已上):
 * 變動偵測確認真變後,先試著自動套用——**只有最安全的一種形態**允許自動:
 * 重切出來的卡與舊卡「標題精確配對」的內容修改,且不涉手編卡、無新增無刪除、
 * 變動比例 ≤30%、內容長度沒暴跌。其餘一律退回既有的「標記+通知人工審」。
 *
 * 為什麼這麼保守:自動改知識卡沒有人把關,錯了客人直接吃到。網頁改版/暫掛/切壞
 * 的形態都是「結構變化」(新增刪除大改),被條件擋掉;能自動過的只剩「同一張卡
 * 文字更新」(價格、日期、措辭)——這正是店家最不想手動按的那種瑣事。
 *
 * 手編卡雙保險:分級判定遇到手編卡直接整源退人工(不只跳過那張),
 * 且 computeDiff 第二輪本來就不讓手編卡參與內容配對。
 */
import type { Firestore } from 'firebase-admin/firestore'
import type { KnowledgeSourceDoc, SourceAutoUpdateRecord, SourceOutdatedReason } from '~~/shared/types/ai-knowledge'
import { diffPageLines, pageChangeIsLarge, pageLinesChanged } from '~~/shared/page-line-diff'
import { chunkTextWithLlm } from './ai-knowledge-chunker'
import {
  applyCosmeticVerdicts,
  computeDiff,
  gateDiffByPageChanges,
  judgeCosmeticRewrites,
  markRemovedStillOnPage,
  normalizeForCompare,
  pickCosmeticCandidates,
  type DiffAction,
  type DiffResult,
} from './ai-knowledge-resync'
import { applyResyncEntries } from './ai-knowledge-resync-apply'
import { normalizeChunkInput, updateKnowledgeChunk, validateChunkInput } from './ai-knowledge-chunks'
import { invalidateKnowledgeChunkCount } from './ai-knowledge-quota'
import { listChunksBySource, loadAppliedPage, sourceNumbersVolatile } from './ai-knowledge-sources'
import { regenerateOverviewCard } from './ai-overview'
import { recordAiUsage } from './ai-usage'
import { callsOf, usageFromCalls } from './ai-usage-calls'

/** 變動比例上限:修改張數 / 舊卡總數 超過即退人工(整頁改版的訊號) */
export const MAX_AUTO_MODIFIED_RATIO = 0.3
/**
 * 卡片數少於此值的來源不套用比例規則——單卡來源改 1 張就是 100%,比例門檻讓自動套用
 * 對「運費說明」「FAQ 單頁」這類最常見的小來源數學上永不可能成立(卻仍付了一次重切卡的錢)。
 * 小來源改用絕對張數:一次只改 1 張才自動。
 */
const RATIO_RULE_MIN_CARDS = 4
/** 新內容總長低於舊內容的這個比例 = 疑似抓取不完整(動態頁掛掉/被擋),退人工 */
export const MIN_NEW_CONTENT_RATIO = 0.5

export interface ApplyCard {
  chunkId: string
  title: string
  content: string
  tags: string[]
  questions?: string[]
}

export interface MinorChangeVerdict {
  kind: 'auto' | 'noop' | 'manual'
  /** kind='manual' 時的原因(進通知文案,店家看得懂為什麼要自己來) */
  reason: string
  /** kind='auto' 時要套用的修改 */
  toApply: ApplyCard[]
}

/**
 * 分級判定(純函式,可測):這次 diff 是否安全到可以自動套用。
 * 條件全過才 'auto';切卡後其實沒差異回 'noop';其餘 'manual' 附原因。
 *
 * disabledChunkIds:目前狀態為 disabled 的卡(手動停用或有效期限到期被排程停用)。
 * 這類卡**絕不能**自動更新——updateKnowledgeChunk 會把 status 寫回 indexed,等於讓
 * 過期的募資/折扣卡無聲復活對客人講話,且到期日已被搬到 expiredAt,排程不會再停用第二次。
 * (reindex / reindex-all 都明文跳過 disabled,自動套用必須比照。)
 */
export function classifyMinorChange(
  diff: DiffResult,
  opts: { oldTotalChars: number; newTotalChars: number; disabledChunkIds?: Set<string> },
): MinorChangeVerdict {
  const { summary } = diff
  /**
   * ⛔「移除」要扣掉**內容其實還在網頁上**的那幾筆（`C-157`）。
   * 重切每次的分組方式都會飄（同一段這次一塊、下次兩塊），舊卡因此對不上而被列成移除
   * ——實測一次 resync 的「移除 18」幾乎全是這種。不扣的話這條路每次都判 `manual`
   * → `markSourceOutdated` → 店家被叫去看一份幾乎全是假移除的 diff，而**產生這份雜訊的
   * 正是這條路自己**。`stillOnPage` 是確定性字串比對、零 LLM，判不錯。
   */
  const realRemoved = diff.entries.filter(e => e.kind === 'removed' && !e.stillOnPage).length
  if (summary.added > 0 || realRemoved > 0) {
    return {
      kind: 'manual',
      reason: `結構有變(新增 ${summary.added} 張、移除 ${realRemoved} 張卡)`,
      toApply: [],
    }
  }
  if (opts.oldTotalChars > 0 && opts.newTotalChars < opts.oldTotalChars * MIN_NEW_CONTENT_RATIO) {
    return { kind: 'manual', reason: '新內容長度大幅縮水,疑似抓取不完整', toApply: [] }
  }

  /**
   * ⛔ 意思沒變的卡不重寫（`C-157`）：重寫會重算 embedding＝真的花錢，換來的是
   * 「可享有→可享」這種零價值的改寫。判官標過的直接跳過；全部都是的話整輪當 noop
   * ——noop 分支會把 `appliedContentHash` 推到新版，來源就不會一直掛著「有變動」。
   */
  const modified = diff.entries.filter(e => e.kind === 'modified' && !e.cosmetic)
  if (!modified.length) return { kind: 'noop', reason: '', toApply: [] }

  if (modified.some(e => e.oldChunk?.manuallyEdited)) {
    return { kind: 'manual', reason: '變動涉及你手動編輯過的卡', toApply: [] }
  }
  if (opts.disabledChunkIds?.size && modified.some(e => opts.disabledChunkIds!.has(e.oldChunk!.id))) {
    return { kind: 'manual', reason: '變動涉及已停用或已過期的卡', toApply: [] }
  }
  // 第二輪內容配對(LLM 微調過標題)不算「精確配對」:標題變了代表切卡結構在漂,留人工
  if (modified.some(e => e.oldChunk?.title !== e.newChunk?.title)) {
    return { kind: 'manual', reason: '卡片標題有變動(非原卡直接更新)', toApply: [] }
  }
  // 比例用「真的要改的張數」算（`C-157`）：把措辭差異算進去會讓門檻假性偏高，
  // 明明只有一張真的改了，卻因為另外七張只是換句話說而被判成「改版」退回人工。
  const realModified = modified.length
  const oldCards = summary.modified + summary.unchanged
  if (oldCards >= RATIO_RULE_MIN_CARDS) {
    if (realModified / oldCards > MAX_AUTO_MODIFIED_RATIO) {
      return {
        kind: 'manual',
        reason: `變動比例過高(${realModified}/${oldCards} 張卡有改)`,
        toApply: [],
      }
    }
  }
  else if (realModified > 1) {
    // 小來源(<4 張卡)改用絕對張數:一次改多張多半是頁面改版,不是文字微調
    return { kind: 'manual', reason: `這個來源只有 ${oldCards} 張卡,卻有 ${realModified} 張同時變動`, toApply: [] }
  }

  // 寫入前跑與其他建卡路徑相同的正規化+驗證:自動路徑沒有人把關,不能讓超長/空白的
  // 切卡結果直接寫進知識庫(bulk-create 與 resync-apply 都會在這裡擋下並回 400)。
  const toApply: ApplyCard[] = []
  for (const e of modified) {
    const normalized = normalizeChunkInput({
      title: e.newChunk!.title,
      content: e.newChunk!.content,
      tags: e.newChunk!.tags,
      questions: e.newChunk!.questions ?? [],
    })
    const err = validateChunkInput(normalized)
    if (err) {
      return { kind: 'manual', reason: `重切出的卡片不合規(${err})`, toApply: [] }
    }
    toApply.push({
      chunkId: e.oldChunk!.id,
      title: normalized.title,
      content: normalized.content,
      tags: normalized.tags,
      questions: normalized.questions?.length ? normalized.questions : undefined,
    })
  }

  return { kind: 'auto', reason: '', toApply }
}

export interface AutoApplyResult {
  /** true = 已自動套用(updated/failed 有值) */
  applied: boolean
  /** true = 重切後其實沒有內容差異(排版級變動),不必通知也不必標 outdated */
  noop: boolean
  updated: number
  failed: number
  /** applied=false 且 noop=false 時:退人工的原因(進通知文案) */
  reason: string
}

/**
 * 對「已確認變動」的 URL 來源試跑自動套用。任何內部錯誤都 fail-open:
 * 回 manual 讓呼叫端走既有的「標記+通知人工審」,絕不讓排程因此中斷。
 */
export async function tryAutoApplyMinorChange(
  db: Firestore,
  sourceId: string,
  source: KnowledgeSourceDoc,
  newText: string,
): Promise<AutoApplyResult> {
  const manual = (reason: string): AutoApplyResult =>
    ({ applied: false, noop: false, updated: 0, failed: 0, reason })

  // 型錄來源(generateOverview)先擋在 LLM 之前:子卡變動要連總覽卡一起重生,
  // 自動路徑不做總覽卡重生(那是 resync-apply 的事),交人工。也省一次切卡費用。
  if (source.generateOverview) return manual('這是型錄/列表來源,總覽卡需要一併重生')

  try {
    const rechunked = await chunkTextWithLlm(newText, {
      hint: source.name,
    })
    const newChunks = rechunked.chunks
    await recordAiUsage(source.workspaceId, usageFromCalls('build', callsOf(rechunked)))
    if (!newChunks.length) return manual('重切後沒有產出卡片')

    // 一次讀齊(含 status):總覽卡不參與 diff(由 resync-apply 依最終子卡重生),
    // disabled 卡仍要參與比對——它們留在 diff 裡才能被下面的護欄擋下,
    // 從 oldChunks 抽掉反而會讓同名新卡變成「新增」而繞過判定。
    const allChunks = await listChunksBySource(db, source.workspaceId, sourceId)
    const oldChunks = allChunks.filter(c => !c.isOverview).map(c => ({
      id: c.id,
      title: c.title,
      content: c.content,
      tags: c.tags,
      manuallyEditedAtMs: c.manuallyEditedAtMs,
    }))
    if (!oldChunks.length) return manual('來源目前沒有卡片可比對')
    const disabledChunkIds = new Set(allChunks.filter(c => c.status === 'disabled').map(c => c.id))
    const diff = computeDiff(oldChunks, newChunks)

    /**
     * 跟手動「重新同步」走**同一套摺疊**（`C-157`）。以前只有手動那條路有，
     * 於是每天在跑、會自己改卡片又會發通知的這一條，反而在跟重切雜訊硬碰硬。
     * ① 確定性：內容其實還在網頁上的「移除」→ 不算結構有變（零成本，先做）
     * ② 意思判官：措辭沒變的卡不重寫（省 embedding）。判官掛掉不擋——
     *    退回原本的行為（照舊當成真的修改），方向安全。
     */
    markRemovedStillOnPage(diff, newText)
    const cosmeticCandidates = pickCosmeticCandidates(diff)
    if (cosmeticCandidates.length) {
      try {
        const judged = await judgeCosmeticRewrites(cosmeticCandidates.map(e => ({
          oldTitle: e.oldChunk?.title ?? '',
          old: e.oldChunk?.content ?? '',
          nextTitle: e.newChunk?.title ?? '',
          next: e.newChunk?.content ?? '',
        })))
        // 「只改措辭」的判斷也是一次 AI 呼叫：以前沒記帳（`C-338`①），記進整理知識庫那桶
        await recordAiUsage(source.workspaceId, usageFromCalls('build', callsOf(judged)))
        applyCosmeticVerdicts(cosmeticCandidates, judged.verdicts)
      }
      catch (e) {
        console.warn('[autoapply] 意思判官失敗（照舊當成真的修改）:', (e as Error)?.message)
      }
    }

    const verdict = classifyMinorChange(diff, {
      oldTotalChars: oldChunks.reduce((s, c) => s + c.content.length, 0),
      newTotalChars: newChunks.reduce((s, c) => s + c.content.length, 0),
      disabledChunkIds,
    })
    if (verdict.kind === 'noop') return { applied: false, noop: true, updated: 0, failed: 0, reason: '' }
    if (verdict.kind === 'manual') return manual(verdict.reason)

    let updated = 0
    let failed = 0
    for (const card of verdict.toApply) {
      try {
        const r = await updateKnowledgeChunk(db, {
          chunkId: card.chunkId,
          title: card.title,
          content: card.content,
          tags: card.tags,
          questions: card.questions, // undefined = 保留既有問法
          sourceId,
          contentChanged: true,
          // 不帶 manualEdit:自動套用不能把卡標成「手動編輯」,否則之後 re-sync 永遠 keep_old
        })
        if (r.status === 'failed') failed++
        else updated++
      }
      catch (e) {
        failed++
        console.warn(`[auto-apply] ${sourceId} 卡片 ${card.chunkId} 套用失敗:`, e)
      }
    }
    return { applied: true, noop: false, updated, failed, reason: '' }
  }
  catch (e: any) {
    console.warn(`[auto-apply] ${sourceId} 自動套用失敗,退回人工審:`, e)
    return manual('自動比對過程出錯')
  }
}

// ── 先比網頁、沒衝突就自動做完（`C-368`，設計見 docs/KB-URL-UPDATE-DESIGN-20261021.md）────────
//
// 跟上面那支（舊路）的差別：舊路只敢自動套用「標題一模一樣的小改」，有新增、有刪除、型錄來源一律退人工
// ——首頁只要換一個商品就掛「有變動」。新路先拿「這批知識是照哪一版網頁做的」原文跟這一版一行一行比：
//   · 一行都沒改 → 什麼都不做（不花 AI 的錢）
//   · 改了 → 請 AI 整理，但只採用跟改了的那幾行有關的變動；沒衝突就自動做完
//   · 只有三種衝突才停下來問：動到手改過的／網頁少了一大半／有改了的行對不到知識
// 沒有上一版原文（舊資料）→ 回 'legacy'，呼叫端照舊走上面那支。

export interface PageAutoApplyResult {
  /**
   * legacy：沒有上一版原文，照舊路；noop：一行都沒改、或改了的都不影響知識；
   * applied：做完了；manual：要人看（reason 講為什麼）；needs_ai：要 AI 整理但這一輪的名額用完了，下一輪再來；
   * numbers_drift：數字會跳的網址，行都一樣、只有數字跟上一版不同，而數字還在跳——不花錢、
   * ⛔ 也不算「這批知識對到這一版」（卡上的數字可能真的舊了，留給「立即更新」照實列出來）
   */
  kind: 'legacy' | 'noop' | 'applied' | 'manual' | 'needs_ai' | 'numbers_drift'
  reason?: SourceOutdatedReason
  /** 這一次有沒有花 AI 的錢 */
  usedAi: boolean
  /** kind='applied'：做了什麼（資料頁那一行紀錄） */
  record?: Omit<SourceAutoUpdateRecord, 'at'>
  /** kind='applied'：全部套成功、沒有因為空間不夠少加——這批知識才算對到這一版網頁 */
  fingerprintSafe?: boolean
  /** kind='applied'：沒套成功的條數 */
  failed?: number
}

/** 紀錄裡每一種最多列幾條標題（資料頁「看是哪些」） */
const RECORD_MAX_TITLES = 30

export async function tryAutoApplyPageChange(
  db: Firestore,
  sourceId: string,
  source: KnowledgeSourceDoc,
  newText: string,
  newHash: string,
  opts: {
    /**
     * 要請 AI 了，跟這一輪拿一個名額：拿到回 true（已經扣掉）。⛔ 要在花錢那一刻才拿（`C-379`）——
     * 排程是幾個來源一起跑的，先看「還有名額」、等 AI 整理完才扣，同時跑的幾個都會看到還有、一起超過上限。
     */
    takeAiSlot: () => boolean
    autoApply: boolean
    /**
     * 數字停下來了：這一輪跟上次確認的版本抹掉數字後一字不差，只有數字換了、而且連兩輪都是這組新數字
     * （改價、集資結束；見 decideSourceChange 的 'changed'）。不是的話＝數字還在自己跳。
     */
    numbersSettled?: boolean
  },
): Promise<PageAutoApplyResult> {
  const manualOf = (kind: SourceOutdatedReason['kind'], count: number, usedAi: boolean): PageAutoApplyResult =>
    ({ kind: 'manual', reason: { kind, count }, usedAi })

  const applied = await loadAppliedPage(db, sourceId)
  if (!applied) return { kind: 'legacy', usedAi: false }
  const ignoreNumbers = sourceNumbersVolatile(source)
  const lineDiff = diffPageLines(applied.text, newText, { ignoreNumbers })
  let changedLines = lineDiff.added.length + lineDiff.removed.length
  if (!pageLinesChanged(lineDiff)) {
    /**
     * 抹掉數字後一行都沒改（空白、順序）。數字會跳的網址要再逐字比一次（比照手動「立即更新」，`C-379`）：
     * 數字也一樣才算這批知識還是對的。以前直接當沒改、把版本記號推到這一版——改了價錢、集資結束的數字
     * 從此卡上是舊的，按「立即更新」又跟版本記號一模一樣、回「網頁沒有要更新的地方」，再也抓不回來。
     */
    const exact = ignoreNumbers ? diffPageLines(applied.text, newText, { ignoreNumbers: false }) : null
    if (!exact || !pageLinesChanged(exact)) return { kind: 'noop', usedAi: false }
    // 數字還在跳（這一輪是因為順序換了才走到這裡）：不花錢，但也不推進版本記號
    if (!opts.numbersSettled) return { kind: 'numbers_drift', usedAi: false }
    // 數字停在新的值：照樣請 AI 整理——改了的行是空的，下面只會留下卡上數字有變的那幾條（數字紅線）
    changedLines = exact.added.length + exact.removed.length
  }
  // 店家設定成「每次都先問我」：照樣不自動，但講得出網頁改了幾行
  if (!opts.autoApply) return manualOf('ask', changedLines, false)
  if (pageChangeIsLarge(lineDiff)) return manualOf('big_change', changedLines, false)
  // 抓到的網頁少了一大半：多半是網頁壞了或改成動態載入，不能照著刪知識
  if (newText.trim().length < applied.text.trim().length * MIN_NEW_CONTENT_RATIO) return manualOf('shrink', 0, false)
  if (!opts.takeAiSlot()) return { kind: 'needs_ai', usedAi: false }

  try {
    const rechunked = await chunkTextWithLlm(newText, { hint: source.name })
    await recordAiUsage(source.workspaceId, usageFromCalls('build', callsOf(rechunked)))
    if (!rechunked.chunks.length) return manualOf('other', 0, true)

    const allChunks = await listChunksBySource(db, source.workspaceId, sourceId)
    const oldChunks = allChunks.filter(c => !c.isOverview).map(c => ({
      id: c.id,
      title: c.title,
      content: c.content,
      tags: c.tags,
      manuallyEditedAtMs: c.manuallyEditedAtMs,
    }))
    const disabledIds = new Set(allChunks.filter(c => c.status === 'disabled').map(c => c.id))
    const diff = computeDiff(oldChunks, rechunked.chunks)
    const gate = gateDiffByPageChanges(diff, lineDiff)
    markRemovedStillOnPage(diff, newText)
    const candidates = pickCosmeticCandidates(diff)
    if (candidates.length) {
      try {
        const judged = await judgeCosmeticRewrites(candidates.map(e => ({
          oldTitle: e.oldChunk?.title ?? '',
          old: e.oldChunk?.content ?? '',
          nextTitle: e.newChunk?.title ?? '',
          next: e.newChunk?.content ?? '',
        })))
        await recordAiUsage(source.workspaceId, usageFromCalls('build', callsOf(judged)))
        applyCosmeticVerdicts(candidates, judged.verdicts)
      }
      catch (e) {
        console.warn('[autoapply] 意思判官失敗（照舊當成真的修改）:', (e as Error)?.message)
      }
    }
    // ⛔ 有改了的行對不到任何知識：不知道該改哪條，停下來問（不默默略過）
    if (gate.uncertain > 0) return manualOf('unclaimed', gate.uncertain, true)

    const decisions: Record<string, DiffAction> = {}
    let manualHits = 0
    let disabledHits = 0
    for (const e of diff.entries) {
      if (e.kind === 'unchanged' || e.pageUnchanged || e.cosmetic || e.stillOnPage) continue
      if (e.kind === 'new') {
        decisions[e.id] = 'add_new'
        continue
      }
      if (e.oldChunk?.manuallyEdited) {
        manualHits++
        continue
      }
      if (e.kind === 'modified') {
        // 停用／到期的卡不能自動改寫：updateKnowledgeChunk 會把它寫回 indexed，等於讓過期的募資卡復活
        if (disabledIds.has(e.oldChunk!.id)) disabledHits++
        else decisions[e.id] = 'use_new'
        continue
      }
      // 網頁上那一段沒了：照網頁拿掉（停用中的也一樣拿掉，本來就不對客人講話）
      decisions[e.id] = 'delete_old'
    }
    if (manualHits) return manualOf('manual_edit', manualHits, true)
    if (disabledHits) return manualOf('disabled', disabledHits, true)
    if (!Object.keys(decisions).length) return { kind: 'noop', usedAi: true }

    // 自動路徑沒有人把關：先驗一輪，有一條不合規就整份停下來（不做一半）
    for (const e of diff.entries) {
      if (decisions[e.id] !== 'add_new' && decisions[e.id] !== 'use_new') continue
      if (validateChunkInput(normalizeChunkInput({ ...e.newChunk!, questions: e.newChunk!.questions ?? [] }))) {
        return manualOf('other', 1, true)
      }
    }

    const { createHash } = await import('node:crypto')
    const r = await applyResyncEntries(db, {
      workspaceId: source.workspaceId,
      sourceId,
      entries: diff.entries,
      decisions,
      // 同一版網頁、同一個標題＝同一個編號：這一輪中途逾時、下一輪重跑時覆寫同一條，不會長出重複的
      chunkIdFor: e => createHash('sha256')
        .update(`autosync:${sourceId}:${newHash}:${normalizeForCompare(e.newChunk?.title ?? e.id)}`)
        .digest('hex').slice(0, 32),
    })

    let overviewUpdated = false
    if (source.generateOverview && (r.added || r.updated || r.deleted)) {
      const outcome = await regenerateOverviewCard(db, source.workspaceId, sourceId)
        .catch((e) => {
          console.warn(`[autoapply] ${sourceId} 總覽沒重做成:`, e)
          return 'skipped' as const
        })
      overviewUpdated = outcome === 'updated' || outcome === 'created'
    }
    if (r.added || r.deleted) invalidateKnowledgeChunkCount(source.workspaceId)

    return {
      kind: 'applied',
      usedAi: true,
      fingerprintSafe: r.errors.length === 0 && r.quotaSkipped === 0,
      failed: r.errors.length,
      ...(r.quotaSkipped ? { reason: { kind: 'quota' as const, count: r.quotaSkipped } } : r.errors.length ? { reason: { kind: 'other' as const, count: r.errors.length } } : {}),
      record: {
        added: r.added,
        removed: r.deleted,
        updated: r.updated,
        addedTitles: r.addedTitles.slice(0, RECORD_MAX_TITLES),
        removedTitles: r.removedTitles.slice(0, RECORD_MAX_TITLES),
        updatedTitles: r.updatedTitles.slice(0, RECORD_MAX_TITLES),
        quotaSkipped: r.quotaSkipped,
        overviewUpdated,
      },
    }
  }
  catch (e) {
    console.warn(`[autoapply] ${sourceId} 照網頁自動更新失敗，留給人看:`, e)
    return manualOf('other', 0, true)
  }
}
