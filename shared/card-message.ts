/**
 * 卡片訊息（模組的 `flexImageCarousel`；`C-398` 以前叫「輪播訊息」）：上限、按鈕樣式、整組大小。前後端同一份。
 *
 * `D-153` ⑵（2026-10-28 拍板）：做得出「大圖＋標題＋長內文＋綠色按鈕」的卡——
 * 內文 300→1000、按鈕可選綠色按鈕／文字連結（新加的預設綠色，舊的沒存樣式＝文字連結照舊）、
 * 所有卡片換新字級（字級在送出端 `handler.ts`，舊卡片不用改資料）。示意頁＝畫布 `5r6YnPeiydQKoS71ZPbe3j`。
 */

export const CARD_TITLE_MAX = 80
/** 一張卡的內文上限。純文字是 5000，但卡片上有大圖，寫太長反而沒人讀；1000 是別家同類卡（約 240 字）的四倍 */
export const CARD_BODY_MAX = 1000

export type CardButtonStyle = 'primary' | 'link'
export const CARD_BUTTON_PRIMARY_COLOR = '#06C755'

/** 沒存樣式的按鈕（`C-398` 以前做的）＝文字連結，維持原本的樣子 */
export function cardButtonStyle(action: { style?: unknown } | null | undefined): CardButtonStyle {
  return action?.style === 'primary' ? 'primary' : 'link'
}

/**
 * LINE 的輪播整組上限（JSON 的 UTF-8 位元組）。單張卡另有 30 KB，但一張卡內文 1000 字加滿按鈕也才 10 KB 上下，碰不到。
 * ⛔ 超過的話 LINE 退的是**整個請求**——同一次回覆裡排在它前後的訊息也一起送不出去。
 */
export const LINE_CAROUSEL_JSON_MAX = 50 * 1024

const encoder = new TextEncoder()

/** 這段字串放進 JSON 之後佔幾個位元組（換行、引號、反斜線會多一個跳脫字元） */
function jsonBytes(value: unknown): number {
  const s = String(value ?? '')
  if (!s) return 0
  const escapes = s.match(/["\\\n\r\t]/g)?.length ?? 0
  return encoder.encode(s).length + escapes
}

/**
 * 網址送出時可能變長：開了貼標會換成那一位的貼標連結（原網址 base64 再加約兩百字），
 * 推播會再包一層點擊追蹤（`broadcast-click-track.ts`），兩種包完超過 1000 字就不包、退回原網址。
 * 所以照「1.4 倍＋300、最多 1000」估，原網址本來就比較長的照原網址。
 */
function uriBytes(uri: unknown): number {
  const raw = jsonBytes(uri)
  return Math.max(raw, Math.min(1000, Math.ceil(raw * 1.4) + 300))
}

/** 一個動作（圖片動作或按鈕）最多佔多少；`type: none` 不送 */
function actionBytes(action: any): number {
  const type = String(action?.type || '')
  if (!type || type === 'none') return 0
  // 動作物件本身的鍵（type／label／uri…）＋按鈕外框（type／style／color／height）
  const fixed = 160
  const label = jsonBytes(action?.label)
  if (type === 'uri') return fixed + label + uriBytes(action?.uri)
  // 叫出模組＝postback data，LINE 上限 300 字
  if (type === 'module') return fixed + label + 300
  // 送一句話：開了貼標時同一句會出現兩次（data 與 displayText），data 另外帶標籤
  return fixed + label + jsonBytes(action?.text || action?.label) * 2 + 300
}

/**
 * 估這則卡片訊息送出去有多大（UTF-8 位元組）。**故意估大不估小**——估小的話存得進去、送出時整則被 LINE 退回。
 * ⚠️ 名字變數（`{{displayName}}`）換進去最多 20 字，跟記號本身差不多長，不另外算。
 * 測試拿真的組訊息那支（`renderModuleToLineMessages`）的輸出對：估出來的一定 ≥ 實際。
 */
export function estimateCardMessageBytes(msg: any): number {
  const columns: any[] = Array.isArray(msg?.columns) ? msg.columns : []
  const enableImage = msg?.enableImage !== false
  // 訊息外框＋提醒文字（沒填時送出端用第一張的標題，照 400 上限算）
  let total = 200 + Math.max(jsonBytes(msg?.altText), 400 * 3)
  for (const col of columns) {
    // 一張卡的外框：bubble／hero／body／footer 各層的鍵與字級設定
    total += 900
    if (enableImage) total += jsonBytes(col?.imageUrl) + actionBytes(col?.action)
    total += jsonBytes(col?.title) + jsonBytes(col?.text)
    for (const btn of Array.isArray(col?.actions) ? col.actions : []) total += actionBytes(btn)
  }
  return total
}

/** 有開貼標卻一個標籤都沒選 */
function taggingMissingTags(tagging: any): boolean {
  if (tagging?.enabled !== true) return false
  const ids = Array.isArray(tagging?.addTagIds) ? tagging.addTagIds.map((x: unknown) => String(x || '').trim()).filter(Boolean) : []
  return ids.length === 0
}

/**
 * 卡片訊息存檔前的全部檢查（張數、圖片、標題、內文、圖片動作、按鈕、貼標、整組大小），回第一個錯誤句，都沒問題回空字串。
 * ⛔ 前後端都叫這一支（`flow.vue` 的 validateMessages、`flow-validator.ts`）——以前兩邊各抄一份，
 *    改規則要改兩個地方，漏一邊就是「後台放行、伺服器擋下」（code review 第 10 條）。
 * 開貼標的按鈕放不放得進 LINE 的 300 字不在這裡（`action-schema.ts` 的 flowTaggedPostbackError，所有訊息共用）。
 */
export function cardMessageError(msg: any): string {
  const columns = msg?.columns
  if (!Array.isArray(columns) || columns.length < 1) return '卡片訊息：至少要有 1 張卡'
  if (columns.length > 10) return '卡片訊息：最多 10 張卡'
  const enableImage = msg?.enableImage !== false
  const blank = (v: unknown) => !String(v ?? '').trim()

  for (const col of columns) {
    if (enableImage) {
      if (blank(col?.imageUrl)) return '卡片訊息：已開啟圖片，每張卡都要上傳圖片'
    }
    else if (blank(col?.title)) {
      return '卡片訊息：沒開圖片時，每張卡都要有標題'
    }
    if (String(col?.title ?? '').length > CARD_TITLE_MAX) return `卡片訊息：標題最多 ${CARD_TITLE_MAX} 字`
    if (String(col?.text ?? '').length > CARD_BODY_MAX) {
      return `卡片訊息：內文最多 ${CARD_BODY_MAX} 字（目前 ${String(col.text).length} 字）`
    }
    const action = col?.action
    if (enableImage) {
      if (action?.type === 'uri' && blank(action?.uri)) return '卡片訊息：圖片動作網址為必填'
      if (action?.type === 'message' && blank(action?.text)) return '卡片訊息：圖片動作傳送文字為必填'
      if (action?.type === 'module' && blank(action?.moduleId)) return '卡片訊息：請選擇圖片動作要觸發的機器人模組'
      if (taggingMissingTags(action?.tagging)) return '卡片訊息：已啟用貼標，請至少選擇一個標籤'
    }
    if (Array.isArray(col?.actions)) {
      if (col.actions.length > 3) return '卡片訊息：每張卡按鈕最多 3 個'
      for (const btn of col.actions) {
        if (blank(btn?.label)) return '卡片訊息：按鈕文字為必填'
        if (btn?.type === 'uri' && blank(btn?.uri)) return '卡片訊息：按鈕網址為必填'
        if (btn?.type === 'message' && blank(btn?.text)) return '卡片訊息：按鈕傳送文字為必填'
        if (btn?.type === 'module' && blank(btn?.moduleId)) return '卡片訊息：請選擇按鈕要觸發的機器人模組'
        if (taggingMissingTags(btn?.tagging)) return '卡片訊息：已啟用貼標，請至少選擇一個標籤'
      }
    }
  }
  return cardMessageSizeError(msg)
}

/** 整組太大時給人看的那句話；沒問題回空字串。存檔時前後端都擋（經由 `cardMessageError`） */
export function cardMessageSizeError(msg: any): string {
  const bytes = estimateCardMessageBytes(msg)
  if (bytes <= LINE_CAROUSEL_JSON_MAX) return ''
  const kb = Math.ceil(bytes / 1024)
  return `卡片訊息：這組卡片太大，LINE 收不下（約 ${kb} KB，上限 50 KB）。請減少張數，或縮短內文與網址。`
}
