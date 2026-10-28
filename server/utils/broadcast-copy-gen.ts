/**
 * 幫一檔節慶擬推播文案三版（`D-85` / `C-225`）；`D-155` 起也幫好友統計的行銷提案擬（發給某一群人、可能搭一檔）。
 *
 * ── 跟 `C-223` 的差別 ──────────────────────────────────────────
 * `C-223` 寫的是**給老闆看的一句建議**（「該推什麼」）；這裡寫的是**要發給客人的訊息**。
 * 讀者不同、紅線也不同：這幾句會出現在客人的 LINE 裡，所以
 * ⛔ 不准出現價格、折扣數字、期限承諾——那些是我們不知道、而他會被客人拿著問的事。
 *
 * ── 五條鐵律 ───────────────────────────────────────────────────
 * ① **一律是草稿**：這支只產文字，⛔ 不建立、不排程、不送出（`C-221` 同一條紅線）。
 * ② **只准用輪廓裡真的有的商品**。
 * ③ ⛔ **不准出現金額、折扣百分比、「限時 N 天」**：客人會照著那個數字來要。
 * ④ **LINE 訊息長度**：太長在手機上要展開，實測 120 字以內最好讀。
 * ⑤ **三版要真的不一樣**：三句幾乎相同等於只給一版，人挑不出東西。
 */

import { generateJson, runWithLlmBudget } from '~~/server/utils/gemini'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { runMeteredAi, usageFromCalls } from '~~/server/utils/ai-usage-calls'
import { splitProfileProducts } from '~~/server/utils/festival-tailor'
import { storeProfileForPrompt, type StoreProfileDoc } from '~~/shared/types/store-profile'
import { BROADCAST_DRAFT_VARIANTS } from '~~/shared/broadcast-draft-handoff'
import type { TaiwanFestival } from '~~/shared/taiwan-festivals'

/** 一則的字數上限。超過就丟掉那一版（其餘照留）。 */
export const BROADCAST_COPY_MAX = 120
/** 跟模型要的字數。⛔ 比上限低一截——`C-223` 實測要上限值它就會超過。 */
export const BROADCAST_COPY_TARGET = 70

/**
 * 這一版能不能用。回 `null`＝可以；回字串＝不能用的原因。
 * ⛔ 純函式而且**一定要先驗再用**：這幾句會進客人的 LINE。
 */
export function rejectBroadcastCopy(text: string, profile: StoreProfileDoc): string | null {
  const s = String(text ?? '').trim()
  if (!s) return '空的'
  if (s.length > BROADCAST_COPY_MAX) return `太長（${s.length} 字）`
  // ⛔ 金額／折扣／期限：客人會照著那個數字來要，而我們不知道他打算賣多少。
  // ⚠️ **中文數字的折扣一定要抓**（「八折」「七五折」「對折」）——台灣行銷最常見的就是這種寫法，
  //    只寫 `\d折` 會整批漏掉。單元測試當場抓到這個洞。
  if (/NT\$|新臺幣|新台幣|\d{2,}\s*元/.test(s)) return '出現了價格或折扣數字'
  if (/[0-9一二三四五六七八九十兩]+\s*折|對折|折扣\s*[0-9一二三四五六七八九十]/.test(s)) return '出現了價格或折扣數字'
  if (/[0-9]{1,2}\s*%|[0-9]{1,2}\s*％/.test(s)) return '出現了價格或折扣數字'
  if (/限時\s*\d|剩下\s*\d\s*(天|小時)|前\s*\d+\s*名/.test(s)) return '出現了我們沒有的期限或名額'
  // ⛔ 變數：這一段是直接發出去的文字，`{{...}}` 會原樣出現在客人眼前
  if (/\{\{|\}\}/.test(s)) return '出現了變數語法'
  if (/\n\n\n/.test(s)) return '空行太多'

  const products = splitProfileProducts(profile)
  if (products.length && /商品|品項|款/.test(s) && !products.some(p => s.includes(p))) {
    return '講了商品卻沒有一個對得上輪廓'
  }
  return null
}

/** 三版是不是真的不一樣。⛔ 幾乎相同＝只給了一版。 */
export function tooSimilar(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\s，。！？、,.!?~～]/g, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  const shorter = x.length <= y.length ? x : y
  const longer = x.length <= y.length ? y : x
  // 短的整句被長的包含＝實質同一句
  if (longer.includes(shorter)) return true
  // 字元重疊率（粗略夠用，⛔ 不為此引入相似度套件）
  const setA = new Set(shorter)
  let hit = 0
  for (const ch of setA) if (longer.includes(ch)) hit++
  return hit / setA.size > 0.92
}

/** 去掉重複的版本，保留先來的那一版。 */
export function dedupeVariants(list: string[]): string[] {
  const out: string[] = []
  for (const v of list) {
    if (out.some(k => tooSimilar(k, v))) continue
    out.push(v)
  }
  return out
}

export function buildCopyPrompt(profile: StoreProfileDoc, festival: TaiwanFestival, tone: string): string {
  const products = splitProfileProducts(profile)
  return [
    `你是一位資深行銷企劃，要幫一家店寫 ${BROADCAST_DRAFT_VARIANTS} 版「${festival.name}」要發給客人的 LINE 訊息。`,
    '',
    // `D-122`②：店家自己的檔期（週年慶、新品開賣）沒有跨產業的通用切角，⛔ 不要塞一行空的「通用切角：」給模型
    ...(festival.own
      ? [`檔期：${festival.name}（${festival.date}）——這是店家自己的檔期，不是國定節日；只照名稱與下面的店家資料寫，⛔ 不要自己編活動內容。`]
      : [`節日：${festival.name}（${festival.date}）`, `這個節日的通用切角：${festival.angle}`]),
    '',
    '這家店：',
    storeProfileForPrompt(profile),
    tone ? `\n說話的口氣：${tone}` : '',
    '',
    '規則（違反任何一條這次就算失敗）：',
    `1. **只能提到上面列出的商品**${products.length ? `（${products.join('、')}）` : ''}，⛔ 不准編造沒列出來的東西。`,
    '2. ⛔ **不准出現任何價格、折扣數字、期限或名額**（例如「NT$599」「八折」「限時 3 天」「前 50 名」）——'
    + '我們不知道他打算怎麼賣，寫出來客人會照著那個數字來要。',
    '3. ⛔ 不准使用 `{{變數}}` 這類語法，這段文字會被原樣發出去。',
    `4. 每一版 **${BROADCAST_COPY_TARGET} 字以內**，客人在手機上一眼讀得完。`,
    `5. ${BROADCAST_DRAFT_VARIANTS} 版要**明顯不一樣**（切角不同：例如一版講送禮、一版講自用、一版講時間快到了），`
    + '⛔ 不可以只是換幾個字。',
    '6. 用繁體中文，像店家自己講話，不要行銷術語堆砌。',
    '',
    `回傳純 JSON：{"variants": ["第一版", "第二版", "第三版"]}`,
  ].filter(Boolean).join('\n')
}

// ═══════════════════════════════════════════════════════════════════
//  好友統計的行銷提案（`D-155`）：發給「某一群人」，可能搭一檔
// ═══════════════════════════════════════════════════════════════════

export interface ProposalCopyInput {
  /** 提案的那顆標籤名（例：在看咖啡機） */
  tagName: string
  /** 那顆標籤在講什麼：說明＋AI 判斷條件（店家自己在標籤頁寫的）；沒寫就空字串 */
  tagMeaning: string
  /** 搭的檔期；沒有＝null（提案寫「這週就可以」） */
  festival: TaiwanFestival | null
}

/**
 * 提案文案多一條紅線：⛔ **不可以讓客人覺得被監視**。
 * 這群人是 AI 從對話裡判出來的，「我們注意到你在看咖啡機」會把客人嚇跑——
 * prompt 第 7 條有講，這裡才是真的擋人的（同 `C-223`：prompt 是拜託，檢查才是規則）。
 */
export function rejectProposalCopy(text: string, profile: StoreProfileDoc): string | null {
  const base = rejectBroadcastCopy(text, profile)
  if (base) return base
  const s = String(text ?? '')
  // ⚠️ 只抓「在講我們觀察客人」的說法，⛔ 不抓單獨的「系統」：「淨水系統」「智慧門鎖系統」是商品名，
  //    整個擋掉的話賣這類東西的店一版都擬不出來（`C-404` code review 抓到）
  // ⛔「你」「您」都要擋：店家口氣設成「您」時，AI 擬的就是「我們注意到您…」（code review 抓到只認「你」）
  if (/注意到[你您]|發現[你您]|觀察到[你您]|系統(判斷|顯示|偵測|發現|記錄|紀錄)|判斷[你您]|偵測到[你您]|紀錄顯示|根據[你您]的/.test(s)) return '寫出了「我們在觀察你」的話'
  // 要人補的空格：忘了補就原樣送到客人手上。⚠️ 只抓「裡面寫著填／內容／XX」的括號——「【雙 11 限定】」是正常寫法
  if (/[［[【][^］\]】]*(填|輸入|內容|XX|xx|○○)[^］\]】]*[］\]】]/.test(s)) return '留了要人補的空格'
  return null
}

export function buildProposalCopyPrompt(profile: StoreProfileDoc, input: ProposalCopyInput, tone: string): string {
  const products = splitProfileProducts(profile)
  const f = input.festival
  return [
    `你是一位資深行銷企劃，要幫一家店寫 ${BROADCAST_DRAFT_VARIANTS} 版要發給一群客人的 LINE 訊息。`,
    '',
    `這群客人：最近在對話裡表現出「${input.tagName}」${input.tagMeaning ? `（店家對這群人的說明：${input.tagMeaning}）` : ''}。`,
    ...(f
      ? f.own
        ? [`搭的檔期：${f.name}（${f.date}）——這是店家自己的檔期；只照名稱與下面的店家資料寫，⛔ 不要自己編活動內容。`]
        : [`搭的檔期：${f.name}（${f.date}）`, `這個檔期的通用切角：${f.angle}`]
      : []),
    '',
    '這家店：',
    storeProfileForPrompt(profile),
    tone ? `\n說話的口氣：${tone}` : '',
    '',
    '規則（違反任何一條這次就算失敗）：',
    `1. **只能提到上面列出的商品**${products.length ? `（${products.join('、')}）` : ''}，⛔ 不准編造沒列出來的東西。`,
    '2. ⛔ **不准出現任何價格、折扣數字、期限或名額**（例如「NT$599」「八折」「限時 3 天」「前 50 名」）——'
    + '我們不知道他打算怎麼賣，寫出來客人會照著那個數字來要。',
    '3. ⛔ 不准使用 `{{變數}}` 或 `［請填寫］` 這類要人補的空格：這段文字會被原樣發出去，忘了補就會原樣出現在客人眼前。',
    `4. 每一版 **${BROADCAST_COPY_TARGET} 字以內**，客人在手機上一眼讀得完。`,
    `5. ${BROADCAST_DRAFT_VARIANTS} 版要**明顯不一樣**（切角不同：例如一版講用起來的好處、一版講${f ? '檔期' : '現在'}、一版請他直接回訊息問），`
    + '⛔ 不可以只是換幾個字。',
    '6. 用繁體中文，像店家自己講話，不要行銷術語堆砌。',
    '7. ⛔ **不可以讓客人覺得被觀察**：不要寫「我們注意到你在看…」「系統判斷你…」「根據你的紀錄…」，'
    + '用自然的開場，像店家對老客人分享消息。',
    '8. 最後一句請他**直接在 LINE 回訊息**就好，⛔ 不要叫他去填表單或另外開網頁。',
    '',
    `回傳純 JSON：{"variants": ["第一版", "第二版", "第三版"]}`,
  ].filter(Boolean).join('\n')
}

/** 提案的三版文案。驗法跟節慶那支一樣，再多一條「不可以讓客人覺得被觀察」 */
export async function generateProposalCopy(
  workspaceId: string,
  profile: StoreProfileDoc,
  input: ProposalCopyInput,
): Promise<CopyGenOutcome> {
  const tone = String(profile.fields?.tone?.value ?? '')
  return runCopyGeneration(workspaceId, buildProposalCopyPrompt(profile, input, tone), s => rejectProposalCopy(s, profile))
}

export interface CopyGenOutcome {
  variants: string[]
  /** 被丟掉的版本與原因（⛔ 一定要往上傳：丟了東西要說得出丟了什麼） */
  dropped: { text: string, reason: string }[]
}

/**
 * 產文案。⛔ **驗不過的那一版丟掉、其餘照留**——
 * 三版全掛才回空陣列，呼叫端負責講「這次擬不出來」。
 */
export async function generateBroadcastCopy(
  workspaceId: string,
  profile: StoreProfileDoc,
  festival: TaiwanFestival,
): Promise<CopyGenOutcome> {
  const tone = String(profile.fields?.tone?.value ?? '')
  return runCopyGeneration(workspaceId, buildCopyPrompt(profile, festival, tone), s => rejectBroadcastCopy(s, profile))
}

/** 叫模型、逐版驗、去重——節慶與提案兩種共用（⛔ 不要各寫一份，驗法會漂開） */
async function runCopyGeneration(
  workspaceId: string,
  prompt: string,
  reject: (text: string) => string | null,
): Promise<CopyGenOutcome> {
  // 記帳（`C-338`①：以前完全沒記）：後台有人按「幫我擬」才跑＝後台自用那桶，次數一起記（成本進哪桶次數就進哪桶）。
  // 用計量器記：JSON 壞掉丟錯那次也付了錢
  const { data } = await runMeteredAi(
    () => runWithLlmBudget(workspaceId, () =>
      generateJson<{ variants?: unknown }>(prompt, {
        temperature: 0.7, // 要三版不一樣，溫度不能太低
        maxOutputTokens: 900,
        thinkingBudget: 0,
      }), 'assist'),
    calls => recordAiUsage(workspaceId, { ...usageFromCalls('test', calls), testInvocations: 1 }),
  )

  const raw = Array.isArray(data?.variants) ? data.variants : []
  const dropped: { text: string, reason: string }[] = []
  const kept: string[] = []
  for (const v of raw.slice(0, BROADCAST_DRAFT_VARIANTS * 2)) {
    const s = String(v ?? '').trim().replace(/^[「"']|[」"']$/g, '')
    const bad = reject(s)
    if (bad) {
      dropped.push({ text: s.slice(0, 60), reason: bad })
      continue
    }
    kept.push(s)
  }

  const unique = dedupeVariants(kept)
  for (const k of kept) {
    if (!unique.includes(k)) dropped.push({ text: k.slice(0, 60), reason: '跟另一版幾乎一樣' })
  }
  return { variants: unique.slice(0, BROADCAST_DRAFT_VARIANTS), dropped }
}
