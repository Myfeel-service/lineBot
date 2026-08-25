/**
 * AI 發現新標籤——掃描器（規格與紅線見 shared/tag-discovery.ts 檔頭）。
 *
 * 跟 ai-tag-suggest 的分工：那支是「每場對話結束後，從既有標籤挑要不要貼」；
 * 這支是「每週一次，把兩週的對話攤開來看，找還沒有標籤的主題」。
 * 兩支共用同一個開關（autoTagSuggest.enabled）＝「AI 讀對話」的同一份授權，
 * 不另開第二顆開關讓人搞不清楚差別。
 *
 * 成本形狀（08-11 讀取費鐵律逐條對過）：
 * - 每輪（10 分鐘）每個開著的工作區只花 1 次 tagDiscovery 讀取判斷「該不該掃」，
 *   間隔不到 6.5 天就直接走人。
 * - 真的掃：sessions 用游標窗口＋上限（⛔ 不全掃），逐場讀訊息有場數與則數上限，
 *   全部有截斷就 log（不讓「掃不完」被讀成「沒有主題」）。
 * - **一次掃描只打一次 LLM**（不是一場一次），走 runWithLlmBudget 吃月額度。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { generateJson, runWithLlmBudget } from './gemini'
import { getAiSettings } from './ai-settings'
import { recordAiUsage, type UsageDelta } from './ai-usage'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { isCustomerActionMessage } from '~~/shared/customer-action'
import {
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_WINDOW_MS,
  MAX_PENDING_DISCOVERIES,
  MAX_PROPOSALS_PER_SCAN,
  MIN_DISTINCT_USERS,
  sanitizeDiscoveryProposals,
  type RawDiscoveryTopic,
  type TagDiscoveryDoc,
  type TagDiscoveryProposal,
} from '~~/shared/tag-discovery'
import { randomUUID } from 'node:crypto'

export const TAG_DISCOVERY_COLLECTION = 'tagDiscovery'

/** 一次掃描最多納入幾場對話（兩週窗口內最新的優先；超過就截斷並 log） */
const MAX_SESSIONS_PER_SCAN = 240
/** 一場最多讀幾則訊息（只取客人說的話，見 digest） */
const MESSAGES_PER_SESSION = 20
/** 一場的摘要行長度上限（token 預算：240 行 × ~40 token ≈ 1 萬 input token） */
const DIGEST_LINE_MAX = 160
/** 併發讀訊息的批量（240 場串行要一分多鐘，Lambda 裡等不起） */
const TRANSCRIPT_CONCURRENCY = 8

/** 一場對話的摘要：這位客人（在這場）說了什麼 */
interface SessionDigest {
  userDocId: string
  text: string
}

export function buildDiscoveryPrompt(digests: SessionDigest[], excludeNames: string[]): string {
  const lines = digests.map((d, i) => `S${i}: ${d.text}`).join('\n')
  const exclude = excludeNames.filter(Boolean).join('、') || '（無）'
  return [
    '你是 LINE 官方帳號的顧客分眾顧問。下面是最近兩週多場客服對話中「客人說過的話」，每行一場（S0、S1… 是場次編號）。',
    '',
    `任務：找出「很多客人都在聊、但店家還沒有對應標籤」的主題，提出最多 ${MAX_PROPOSALS_PER_SCAN} 個值得建立的新標籤。`,
    '',
    '規則：',
    '- 只提「從對話就看得出來」的意圖、興趣或行為（想買什麼品類、想送禮、問運費、抱怨過…）。會員等級、消費金額這種對話裡看不出來的不要提。',
    '- 粒度是「品類」不是「型號」：提「在看除濕機」，不要提「在看某品牌 6L 除濕機」。',
    `- 每個主題至少要有 ${MIN_DISTINCT_USERS} 場**不同客人**的對話支持，把支持的場次編號列進 sessions；支持不夠的不要硬湊。`,
    `- 這些名稱已存在或已被店家否決，不要再提（含同義換句話說）：${exclude}`,
    '- criteria 用「什麼算＋什麼不算」的寫法（80 字內）；usage 一句話講這顆標籤拿來做什麼；reason 一句話講為什麼現在建議（給店家看的白話）。',
    '- code 用英文小寫加底線（例：intent_dehumidifier）。',
    '- 沒有夠強的主題就回空陣列，不要為了湊數而提。',
    '',
    '對話摘要：',
    lines,
    '',
    '輸出 JSON：{"topics":[{"name":"...","code":"...","category":"interest|behavior|member_status|activity|custom","criteria":"...","usage":"...","reason":"...","sessions":[0,3,17]}]}',
  ].join('\n')
}

function tsToMs(raw: unknown): number {
  const v = raw as { toMillis?: () => number } | null | undefined
  return typeof v?.toMillis === 'function' ? v.toMillis() : 0
}

/**
 * 排程入口（掛 cron/run-tasks）。
 */
export async function scanTagDiscovery(db: Firestore): Promise<{
  workspaces: number
  scanned: number
  proposed: number
}> {
  const stats = { workspaces: 0, scanned: 0, proposed: 0 }
  const wsSnap = await db.collection('workspaces').select().get()

  for (const wsDoc of wsSnap.docs) {
    const workspaceId = wsDoc.id
    try {
      const settings = await getAiSettings(workspaceId, db)
      if (!settings.autoTagSuggest?.enabled) continue
      stats.workspaces += 1

      const docRef = db.collection(TAG_DISCOVERY_COLLECTION).doc(workspaceId)
      const snap = await docRef.get()
      const doc = (snap.data() ?? null) as TagDiscoveryDoc | null
      const lastScanMs = Number(doc?.lastScanMs ?? 0)
      const pending = Array.isArray(doc?.pending) ? doc!.pending : []
      const dismissedNames = Array.isArray(doc?.dismissedNames) ? doc!.dismissedNames : []

      // 間隔未到 → 走人（每輪只花上面那 1 次讀取）
      if (Date.now() - lastScanMs < DISCOVERY_INTERVAL_MS) continue
      // 收件匣滿了就不掃：提了也放不進去，白燒一次 LLM。老闆清掉之後下一輪自然會掃
      if (pending.length >= MAX_PENDING_DISCOVERIES) continue

      const result = await scanOneWorkspace(db, workspaceId, pending, dismissedNames)
      stats.scanned += 1
      stats.proposed += result.proposed

      await docRef.set({
        workspaceId,
        pending: [...pending, ...result.proposals],
        dismissedNames,
        lastScanMs: Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
        ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true })
    }
    catch (e) {
      console.warn('[tag-discovery] workspace failed:', workspaceId, e)
    }
  }

  return stats
}

async function scanOneWorkspace(
  db: Firestore,
  workspaceId: string,
  pending: TagDiscoveryProposal[],
  dismissedNames: string[],
): Promise<{ proposed: number; proposals: TagDiscoveryProposal[] }> {
  const none = { proposed: 0, proposals: [] as TagDiscoveryProposal[] }

  // 窗口：上次掃描之後的對話；第一次掃回看兩週（一次 LLM 的量，跟 tag-suggest
  // 「不追歷史」的考量不同——那支是一場一次 LLM，追歷史是幾千次）
  const sinceMs = Math.max(Date.now() - DISCOVERY_WINDOW_MS, 0)
  const sessSnap = await db.collection('conversationSessions')
    .where('workspaceId', '==', workspaceId)
    .where('status', '==', 'closed')
    .where('lastActivityAt', '>', Timestamp.fromMillis(sinceMs))
    .orderBy('lastActivityAt', 'asc')
    .limit(MAX_SESSIONS_PER_SCAN)
    .get()
  if (sessSnap.size >= MAX_SESSIONS_PER_SCAN) {
    console.warn(`[tag-discovery] ${workspaceId} 窗口內對話超過 ${MAX_SESSIONS_PER_SCAN} 場，只取最舊那批（其餘下次掃）`)
  }

  // 客人真的講過話的場才有東西可看
  const sessions = sessSnap.docs
    .map(d => d.data())
    .filter(s => s.hasInbound !== false && String(s.userId ?? ''))
  if (sessions.length < MIN_DISTINCT_USERS) return none

  // 逐場抽「客人說的話」摘要（分批併發，別串行等一分鐘）
  const digests: SessionDigest[] = []
  for (let i = 0; i < sessions.length; i += TRANSCRIPT_CONCURRENCY) {
    const chunk = sessions.slice(i, i + TRANSCRIPT_CONCURRENCY)
    const results = await Promise.all(chunk.map(async (sess) => {
      const userDocId = lineUserFirestoreDocId(String(sess.userId), workspaceId)
      try {
        const msgSnap = await db.collection('conversations').doc(userDocId)
          .collection('messages')
          .orderBy('timestamp', 'desc')
          .limit(MESSAGES_PER_SESSION)
          .get()
        // 只留客人打的字（動作紀錄不是話；店家的話對「客人在意什麼」沒資訊量還佔 token）
        const texts = msgSnap.docs.slice().reverse()
          .map(d => d.data() as { direction?: string; text?: string; messageType?: string })
          .filter(m => m.direction === 'incoming' && !isCustomerActionMessage(m.messageType))
          .map(m => String(m.text ?? '').trim())
          .filter(t => t.length >= 2)
        if (!texts.length) return null
        const line = texts.join(' / ').slice(0, DIGEST_LINE_MAX)
        return { userDocId, text: line } satisfies SessionDigest
      }
      catch (e) {
        console.warn('[tag-discovery] transcript failed:', userDocId, e)
        return null
      }
    }))
    digests.push(...results.filter((r): r is SessionDigest => !!r))
  }
  if (new Set(digests.map(d => d.userDocId)).size < MIN_DISTINCT_USERS) return none

  // 排除名單＝所有既有標籤名（不分 aiMode——同名就是重複，不管誰在判）＋pending＋否決過的
  const tagSnap = await db.collection('tags').where('workspaceId', '==', workspaceId).get()
  const takenNames = [
    ...tagSnap.docs.map(d => String(d.data()?.name ?? '')),
    ...pending.map(p => p.name),
    ...dismissedNames,
  ].filter(Boolean)

  const prompt = buildDiscoveryPrompt(digests, takenNames)
  const { data, inputTokens, outputTokens } = await runWithLlmBudget(workspaceId, () =>
    generateJson<{ topics?: RawDiscoveryTopic[] }>(prompt, {
      // 跨兩百行摘要做歸納命名，比「從清單挑選」難一階 → 用 flash 不用 lite；一週一次，費用可忽略
      model: 'gemini-2.5-flash',
      temperature: 0,
      maxOutputTokens: 1500,
      thinkingBudget: 0, // 短 JSON 輸出：thinking 會吃掉 output 配額把 JSON 截斷（見 gemini.ts）
    }))

  // 背景資料處理桶（import* ⊆ 總量子集慣例，同知識缺口掃描）；⛔ 不記 invocations/answered
  const usage: UsageDelta = {
    importInputTokens: inputTokens,
    importOutputTokens: outputTokens,
    inputTokens,
    outputTokens,
  }
  await recordAiUsage(workspaceId, usage, db).catch(e => console.warn('[tag-discovery] usage record failed:', e))

  const room = MAX_PENDING_DISCOVERIES - pending.length
  const cleaned = sanitizeDiscoveryProposals(Array.isArray(data?.topics) ? data.topics : [], {
    sessionUserIds: digests.map(d => d.userDocId),
    takenNames,
    maxProposals: Math.min(MAX_PROPOSALS_PER_SCAN, Math.max(0, room)),
  })

  const proposals: TagDiscoveryProposal[] = cleaned.map(p => ({
    ...p,
    id: randomUUID(), // ⛔ id 是伺服器產的，模型只產內容
    proposedAtMs: Date.now(),
  }))
  return { proposed: proposals.length, proposals }
}
