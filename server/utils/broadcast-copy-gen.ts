/**
 * 幫一檔節慶擬推播文案三版（`D-85` / `C-225`）。
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
    `節日：${festival.name}（${festival.date}）`,
    `這個節日的通用切角：${festival.angle}`,
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
  const { data } = await runWithLlmBudget(workspaceId, () =>
    generateJson<{ variants?: unknown }>(buildCopyPrompt(profile, festival, tone), {
      temperature: 0.7, // 要三版不一樣，溫度不能太低
      maxOutputTokens: 900,
      thinkingBudget: 0,
    }))

  const raw = Array.isArray(data?.variants) ? data.variants : []
  const dropped: { text: string, reason: string }[] = []
  const kept: string[] = []
  for (const v of raw.slice(0, BROADCAST_DRAFT_VARIANTS * 2)) {
    const s = String(v ?? '').trim().replace(/^[「"']|[」"']$/g, '')
    const bad = rejectBroadcastCopy(s, profile)
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
