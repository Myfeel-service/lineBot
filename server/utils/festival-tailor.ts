/**
 * 節慶提醒客製化（`D-85` / `C-223`＝`D-21` 的 Phase 2）。
 *
 * ── 這支在補的洞 ───────────────────────────────────────────────
 * `shared/taiwan-festivals.ts` 的 `angle` 是**跨產業通用**的一句（「禮盒與送禮的需求會
 * 明顯升溫」），那個檔頭自己就寫著「要客製到商家自己的商品是日後 Phase 2 的事」。
 * 有了店家輪廓（`C-217`）之後，那個 Phase 2 才做得到。
 *
 * ── 四條鐵律 ───────────────────────────────────────────────────
 * ① **失敗一律退回通用句**。⛔ 客製不出來時整段消失，是最糟的結果——
 *    商家會以為這個節日系統漏掉了，而其實只是模型那一刻不順。
 * ② **只准用輪廓裡真的有的商品**。模型掰一個商家沒賣的東西，比講通用句還傷信任。
 * ③ **不准出現金額**。我們不知道他賣多少錢（輪廓的價格帶是 AI 從網站猜的），
 *    寫出「推 NT$599 組合」等於替他決定定價。
 * ④ **一句話**。這段要塞進每天早上那則 LINE 訊息裡（08-06 拍板「一則錢講完全部」），
 *    長了就把整則摘要擠爆。
 */

import { generateText, runWithLlmBudget } from '~~/server/utils/gemini'
import { storeProfileForPrompt, type StoreProfileDoc } from '~~/shared/types/store-profile'
import type { TaiwanFestival } from '~~/shared/taiwan-festivals'

/** 客製句的長度上限。超過就退回通用句——擠爆摘要比沒客製糟。 */
export const TAILORED_ANGLE_MAX = 60
/**
 * prompt 裡跟模型要的字數。**刻意比上限低一截**：
 * 實測要 60 字時，它會寫到 61–74 字而被整句退掉（8 次裡退了 2 次）。
 * 要 35 字則落在 30–55 字之間，退回率降到 0。
 */
export const TAILORED_ANGLE_TARGET = 35

/**
 * 把模型吐出來的句子修成「能塞進模板中間」的形狀。純函式、可測。
 *
 * ⚠️ 三條都是 2026-09-23 實測當場看到的：
 *   ① 句尾的句號會跟模板的「，建議這幾天…」撞成「**。，**」；
 *   ② 開頭常重複節日名（「再過 7 天就是中秋節。**中秋節將至**，…」）；
 *   ③ 偶爾用「老闆，」開頭——它被塞在句子中間，呼語在那裡讀不通。
 */
export function normalizeTailoredAngle(raw: string, festivalName = ''): string {
  let s = String(raw ?? '').trim()
  s = s.replace(/^[「『"'\s]+|[」』"'\s]+$/g, '')
  // ③ 呼語
  s = s.replace(/^(老闆|店長|您好|你好)[，,：:]\s*/, '')
  // ② 開頭重複節日名（「中秋節將至，」「雙 11 快到了，」「中秋節，」）
  if (festivalName) {
    const esc = festivalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    s = s.replace(new RegExp(`^${esc}\\s*(將至|快到了|到了|檔期|期間)?[，,]\\s*`), '')
  }
  // ① 句尾標點（模板後面接的是「，建議…」）
  s = s.replace(/[。．.！!？?，,、；;]+$/, '')
  return s.trim()
}

/**
 * 判斷這句客製句能不能用。
 * 回 `null`＝可以用；回字串＝不能用的原因（呼叫端記 log、退回通用句）。
 *
 * ⛔ 這是純函式而且**一定要先驗再用**：模型輸出直接落地是這個專案踩過最多次的坑。
 */
export function rejectTailoredAngle(text: string, profile: StoreProfileDoc): string | null {
  const s = String(text ?? '').trim()
  if (!s) return '空的'
  if (s.length > TAILORED_ANGLE_MAX) return `太長（${s.length} 字）`
  // ⛔ 金額：我們不知道他賣多少錢，寫出來等於替他決定定價
  if (/NT\$|新臺幣|新台幣|\d{2,}\s*元/.test(s)) return '出現了金額'
  // ⛔ 換行／條列：這一句要塞進一則 LINE 訊息的一行
  if (/\n|•|・\s|^\d+\./.test(s)) return '有換行或條列'
  // ⛔ 模型偶爾會把 prompt 的欄位名抄回來
  if (/主打商品|產業與品類|輪廓/.test(s)) return '抄到了欄位名'

  // ⛔ **提到的商品必須真的在輪廓裡**：掰一個他沒賣的東西比講通用句還傷。
  //    做法＝把輪廓裡的商品逐一比對，只要句子提到「商品」這個概念卻沒有一個對得上，就退。
  //    ⚠️ 只在輪廓真的有商品時才檢查（沒填商品的店本來就不該被這條擋掉）。
  const products = splitProfileProducts(profile)
  if (products.length) {
    const mentionsAny = products.some(p => s.includes(p))
    // 沒提到任何商品也可以（講客群、講檔期節奏都合理），但**提到了就必須對得上**。
    // 用「有沒有出現引號括起來的名詞」當偵測太脆弱，改成：句子裡若出現輪廓沒有的
    // 商品字樣無從判斷，所以這裡只做「有提到就要對得上」的寬鬆版本——
    // 嚴格版交給 ②「只准用輪廓裡的商品」寫進 prompt。
    if (!mentionsAny && /商品|品項|款/.test(s)) return '講了商品卻沒有一個對得上輪廓'
  }
  return null
}

/** 把輪廓的「主打商品」拆成陣列（價格帶用 ｜ 隔開，只取前半） */
export function splitProfileProducts(profile: StoreProfileDoc): string[] {
  const raw = String(profile.fields?.products?.value ?? '')
  const head = raw.split(/[｜|]/)[0] ?? ''
  return head
    .split(/[、,，/／]/)
    .map(s => s.trim())
    .filter(s => s.length >= 2)
    .slice(0, 3)
}

export function buildTailorPrompt(profile: StoreProfileDoc, festival: TaiwanFestival, daysUntil: number): string {
  const products = splitProfileProducts(profile)
  return [
    '你是一位資深行銷企劃，正在幫一家店想「這個節日該推什麼」。',
    '',
    `節日：${festival.name}（還有 ${daysUntil} 天）`,
    `這個節日的通用切角：${festival.angle}`,
    '',
    '這家店：',
    storeProfileForPrompt(profile),
    '',
    '請寫**一句話**告訴老闆，這個節日他該推什麼、推給誰。規則：',
    `1. **只能用上面列出的商品**${products.length ? `（${products.join('、')}）` : ''}，⛔ 不准提到沒列出來的東西。`,
    '2. ⛔ 不准出現任何金額（我們不知道他賣多少錢）。',
    // ⚠️ 要 35 是為了拿到 60 以內：實測直接要 60 會寫到 74 字而被整句退掉
    `3. **${TAILORED_ANGLE_TARGET} 字以內**，一句話，不要換行、不要條列。`,
    // ⚠️ 這句會被塞進「再過 7 天就是中秋節。＿＿＿，建議這幾天…」的中間
    `4. ⛔ 開頭不要再提一次「${festival.name}」，也不要用「老闆」之類的稱呼開頭，句尾不要句號。`,
    '5. 用繁體中文，講老闆聽得懂的話，不要行銷術語。',
    '6. 只回那一句話本身，不要加任何說明或引號。',
  ].join('\n')
}

/**
 * 產生客製化的節慶切角。⛔ **任何失敗都回 `null`**，呼叫端退回通用句。
 *
 * @returns 客製句，或 `null`（沒有輪廓／模型失敗／驗不過）
 */
export async function tailorFestivalAngle(
  workspaceId: string,
  profile: StoreProfileDoc | null | undefined,
  festival: TaiwanFestival,
  daysUntil: number,
): Promise<string | null> {
  // 輪廓太空就不用花這個錢：prompt 裡沒有商品，生出來的跟通用句沒兩樣
  if (!profile || !storeProfileForPrompt(profile)) return null
  if (!splitProfileProducts(profile).length) return null

  try {
    const res = await runWithLlmBudget(workspaceId, () =>
      generateText(buildTailorPrompt(profile, festival, daysUntil), {
        // 這是文案不是抽事實，給一點溫度；但仍要短、要準
        temperature: 0.4,
        maxOutputTokens: 200,
        thinkingBudget: 0,
      }))
    const text = normalizeTailoredAngle(res.text ?? '', festival.name)
    const bad = rejectTailoredAngle(text, profile)
    if (bad) {
      console.warn('[festival-tailor] 退回通用句：', workspaceId, festival.id, bad, text.slice(0, 80))
      return null
    }
    return text
  }
  catch (e) {
    // ⛔ 生成失敗不可以讓整段節慶提醒消失——商家會以為系統漏掉這個節日
    console.warn('[festival-tailor] 生成失敗，退回通用句：', workspaceId, festival.id, e)
    return null
  }
}
