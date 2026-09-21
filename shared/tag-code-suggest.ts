/**
 * 從標籤的顯示名稱猜一組英文代號，給「就地建標籤」的小視窗預填（`C-208`）。
 *
 * **為什麼需要這支**：建標籤時「英文代號」是必填、而且**建立後不能改**
 * （`tags.vue` 的欄位說明就是這樣寫的），對第一次用的人來說是整個流程最卡的一格——
 * 他只是想在模組按鈕上貼一顆「問過出貨」，卻要先想一個自己永遠不會再看到的英文字串。
 * 預填一組合法的值之後，他可以直接按建立，想改也還是改得到。
 *
 * ⚠️ **這支不是「把代號藏起來」**：那是 `D-83`③ 還沒回答的拍板題。
 *    在拍板之前，小視窗仍然把代號秀出來、可編輯，只是不再要求他從零想一個。
 *
 * ⛔ **刻意不用 pinyin**：`pinyin-pro` 只在 `server/utils/ai-answer.ts` 用，
 *    它帶一整份字典（約 1MB），為了預填一格輸入框把它拉進前端 bundle 不划算。
 *    中文名字取不到 ASCII 時退回 `tag`／`tag_2`，使用者照樣看得到、改得動。
 *
 * 規則與 `server/api/tag/create.post.ts` 的 `/^[a-z][a-z0-9_]*$/` 完全一致——
 * ⛔ 這支吐出來的東西一定要能通過那一關，否則就是「幫他填了一個會被退件的值」。
 */

/** 與 `server/api/tag/create.post.ts` 同一條規則（⛔ 兩邊要一起改） */
export const TAG_CODE_RE = /^[a-z][a-z0-9_]*$/

/** 代號長度上限。後端沒有限制，這裡限是為了預填出來的東西還讀得下去 */
export const TAG_CODE_MAX_LENGTH = 24

/** 取不到任何 ASCII 英數時的退路（例如純中文名字） */
export const TAG_CODE_FALLBACK = 'tag'

export function isValidTagCode(code: string): boolean {
  return TAG_CODE_RE.test(code)
}

/**
 * 把顯示名稱壓成一段合法代號的「主體」（還沒做去重）。
 *
 * - 只留 ASCII 英數，其餘（中文、空白、標點、emoji）一律變底線再收斂
 * - 開頭必須是英文字母 → 砍掉前面的數字與底線
 * - 砍完是空的就回 `''`，由呼叫端決定退路
 */
export function tagCodeBase(name: string): string {
  const compact = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  // 開頭只能是英文字母：`2026_spring` → `spring`、`123` → ``
  const fromLetter = compact.replace(/^[0-9_]+/, '')
  if (!fromLetter) return ''

  return fromLetter.slice(0, TAG_CODE_MAX_LENGTH).replace(/_+$/, '')
}

/**
 * 猜一組**還沒被用過**的代號。
 *
 * @param name          使用者剛打的顯示名稱
 * @param existingCodes 這個工作區已經有的代號（拿 `/api/tag/list` 的結果即可）
 *
 * ⛔ 去重是必要的不是保險：撞到既有代號時後端回 409，而那句話是英文的
 *    （`Tag code "x" already exists in this workspace`），直接噴給店家看沒有意義。
 * ⚠️ 去重只擋「這個工作區**現在載到的**那些代號」——別人同時建了一顆同名的還是會 409，
 *    所以呼叫端仍然要把 409 翻成白話並讓他改，⛔ 不可以假設這支回來的一定能建成功。
 */
export function suggestTagCode(name: string, existingCodes: Iterable<string> = []): string {
  const taken = new Set<string>()
  for (const code of existingCodes) {
    const normalized = String(code ?? '').trim().toLowerCase()
    if (normalized) taken.add(normalized)
  }

  const base = tagCodeBase(name) || TAG_CODE_FALLBACK
  if (!taken.has(base)) return base

  // 撞號就加序號；⛔ 加完還是要守住長度上限，所以是「截短再接」不是「直接接」
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `_${n}`
    const head = base.slice(0, Math.max(1, TAG_CODE_MAX_LENGTH - suffix.length)).replace(/_+$/, '')
    const candidate = `${head || TAG_CODE_FALLBACK}${suffix}`
    if (!taken.has(candidate)) return candidate
  }

  // 1000 顆同名標籤是不可能的情境，但也不能回一個非法值
  return `${TAG_CODE_FALLBACK}_${Date.now().toString(36)}`.slice(0, TAG_CODE_MAX_LENGTH)
}
