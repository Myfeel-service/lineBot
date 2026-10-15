/**
 * 推播發送前：將訊息裡的 URI action（按鈕範本、輪播、Flex 卡、imagemap）改為先經 /api/r/:token 再 302 到原網址，
 * 以便寫入 broadcastClickLogs（multicast 同一則訊息，故 deliveryId / userId 留空，僅做活動層級統計）。
 *
 * ⚠️ token 沒有簽章，`/api/r/:token` 轉址前改成「拿推播本身比對目標網址」（`G-95`，理由寫在那支檔頭）；
 * 比對用的集合由這裡的 `collectClickTrackableUris`／`clickTargetInBroadcast` 算，走的是同一條版型走法。
 */

function isHttpsUrl(s: string): boolean {
  return /^https:\/\//i.test(s.trim())
}

/**
 * 推播發送時會在 `broadcasts/{id}.clickTrackingVersion` 記下這個版本（`C-301`）。
 * 2＝圖片上的連結（圖文訊息發出去的 imagemap 與單張 Flex 卡）也認得；沒有這一欄的舊推播，
 * 點擊次數只算到文字按鈕、按鈕範本與輪播卡。
 */
export const CLICK_TRACKING_VERSION = 2

/**
 * LINE 對網址長度的上限（按鈕範本、Flex、imagemap 的連結都是 1000 字）。
 * ⛔ 包成追蹤連結後超過就**不包**：超過的話 LINE 會把整則推播退回，客人一則都收不到——
 * 少記一個連結的點擊，遠比整批送不出去便宜。
 */
const LINE_URI_MAX = 1000

function alreadyTrackingUrl(uri: string, origin: string): boolean {
  const base = origin.replace(/\/$/, '')
  return uri.startsWith(`${base}/api/r/`)
}

function wrapOneUri(
  uri: string,
  campaignId: string,
  linkKey: string,
  origin: string,
): string {
  const u = uri.trim()
  if (!isHttpsUrl(u) || alreadyTrackingUrl(u, origin)) return uri
  const base = origin.replace(/\/$/, '')
  const token = Buffer.from(
    [campaignId, '', '', linkKey, u].join('|'),
    'utf-8',
  ).toString('base64url')
  const wrapped = `${base}/api/r/${token}`
  return wrapped.length > LINE_URI_MAX ? uri : wrapped
}

/**
 * 一個「會被換成追蹤連結」的網址位置：放在哪個物件的哪一格。
 * 大多數版型放在 `action.uri`；imagemap 的連結放在 `action.linkUri`（`C-301`）。
 */
type UriSlot = { holder: Record<string, unknown>; field: 'uri' | 'linkUri' }

type Visit = (slot: UriSlot, linkKey: string) => void

function visitUriAction(raw: unknown, linkKey: string, visit: Visit): void {
  const a = raw as Record<string, unknown> | null | undefined
  if (a?.type === 'uri' && typeof a.uri === 'string') visit({ holder: a, field: 'uri' }, linkKey)
}

function visitActionsArray(
  actions: unknown[] | undefined,
  keyPrefix: string,
  visit: Visit,
): void {
  if (!Array.isArray(actions)) return
  actions.forEach((raw, i) => visitUriAction(raw, `${keyPrefix}_${i}`, visit))
}

/**
 * 單張 Flex 卡（`C-301`）：圖文訊息走 Flex 時就是這個形狀——body 裡一張圖，
 * 上面疊幾個透明的點擊區（`handler.ts` 的 `buildRichMessageFlexMessage`），連結掛在那些區塊上。
 * hero／footer 也一起看：別的版型做成單張卡時會用到。
 */
function visitBubble(bubble: Record<string, unknown> | null | undefined, keyPrefix: string, visit: Visit): void {
  if (!bubble || typeof bubble !== 'object') return
  visitUriAction((bubble.hero as { action?: unknown } | undefined)?.action, `${keyPrefix}_hero`, visit)
  const bodyContents = (bubble.body as { contents?: unknown[] } | undefined)?.contents
  if (Array.isArray(bodyContents)) {
    bodyContents.forEach((raw, i) => visitUriAction((raw as { action?: unknown } | null)?.action, `${keyPrefix}_body_${i}`, visit))
  }
  const footerContents = (bubble.footer as { contents?: unknown[] } | undefined)?.contents
  if (Array.isArray(footerContents)) {
    footerContents.forEach((raw, i) => visitUriAction((raw as { action?: unknown } | null)?.action, `${keyPrefix}_btn_${i}`, visit))
  }
}

/**
 * 走過訊息裡「會被換成追蹤連結」的每一個 URI action，連同它的 linkKey（`G-95`）。
 *
 * ⛔ 送出前包裝（`wrapBroadcastMessagesForClickTracking`）與點下去時驗證
 * （`collectClickTrackableUris` → `/api/r/:token`）**走的是同一條**：兩邊各寫一份的話，
 * 哪天包裝多認一種版型、驗證沒跟上，那一種的連結就全部被當成偽造、客人點了回首頁。
 */
function forEachTrackableUriAction(
  messages: unknown[],
  visit: Visit,
): void {
  if (!Array.isArray(messages)) return
  ;(messages as Record<string, unknown>[]).forEach((msg, mi) => {
    // ── Template messages ──
    if (msg?.type === 'template' && msg.template && typeof msg.template === 'object') {
      const tpl = msg.template as Record<string, unknown>
      const t = String(tpl.type || '')

      if (t === 'buttons' || t === 'confirm') {
        visitActionsArray(tpl.actions as unknown[] | undefined, `tpl_${t}`, visit)
      }
      else if (t === 'carousel' && Array.isArray(tpl.columns)) {
        tpl.columns.forEach((col: Record<string, unknown>, ci: number) => {
          visitActionsArray(col?.actions as unknown[] | undefined, `car_${ci}`, visit)
        })
      }
      else if (t === 'image_carousel' && Array.isArray(tpl.columns)) {
        tpl.columns.forEach((col: Record<string, unknown>, ci: number) => {
          visitUriAction(col?.action, `imgcar_${ci}`, visit)
        })
      }
    }

    // ── Flex ──
    else if (msg?.type === 'flex') {
      const contents = msg.contents as Record<string, unknown> | undefined
      // 輪播（hero 圖與 footer 按鈕）。⛔ linkKey 不可以改：已經記下的點擊是用這組名字分的
      if (contents?.type === 'carousel' && Array.isArray(contents.contents)) {
        (contents.contents as Record<string, unknown>[]).forEach((bubble, bi) => {
          visitUriAction((bubble?.hero as { action?: unknown } | undefined)?.action, `flexcar_${bi}`, visit)
          const footerContents = (bubble?.footer as { contents?: unknown[] } | undefined)?.contents
          if (Array.isArray(footerContents)) {
            footerContents.forEach((raw, fi) => {
              visitUriAction((raw as { action?: unknown } | null)?.action, `flexcar_${bi}_btn_${fi}`, visit)
            })
          }
        })
      }
      // 單張卡（`C-301`）：圖文訊息走 Flex 的那種
      else if (contents?.type === 'bubble') {
        visitBubble(contents, `m${mi}_flex`, visit)
      }
    }

    // ── Imagemap（`C-301`）：圖文訊息勾了「保留 PNG 透明」時發出去的就是這個，連結在 linkUri ──
    else if (msg?.type === 'imagemap' && Array.isArray(msg.actions)) {
      (msg.actions as Record<string, unknown>[]).forEach((a, ai) => {
        if (a?.type === 'uri' && typeof a.linkUri === 'string') visit({ holder: a, field: 'linkUri' }, `m${mi}_imagemap_${ai}`)
      })
    }
  })
}

/**
 * 回傳新物件（深拷貝自 messages），只替換認得的那幾種網址位置。
 */
export function wrapBroadcastMessagesForClickTracking(
  messages: unknown[],
  campaignId: string,
  originWithoutTrailingSlash: string,
): unknown[] {
  const origin = String(originWithoutTrailingSlash || '').trim().replace(/\/$/, '')
  if (!origin.startsWith('http')) return messages

  const cloned = JSON.parse(JSON.stringify(messages)) as Record<string, unknown>[]
  forEachTrackableUriAction(cloned, ({ holder, field }, linkKey) => {
    holder[field] = wrapOneUri(String(holder[field]), campaignId, linkKey, origin)
  })
  return cloned
}

/**
 * 這幾則訊息送出時，會被包成追蹤連結的**原網址**有哪些（純函式，`G-95`）。
 *
 * 跟 `wrapOneUri` 放進 token 的是同一個值（去頭尾空白、只收 https）。
 * ⚠️ 已經是 `/api/r/` 的網址 `wrapOneUri` 不會再包、這裡照樣收：多收一個店家自己放的網址無害
 * （轉過去還會再驗一次），省得這支也要知道當時的 origin。
 */
export function collectClickTrackableUris(messages: unknown): Set<string> {
  const uris = new Set<string>()
  forEachTrackableUriAction(Array.isArray(messages) ? messages : [], ({ holder, field }) => {
    const u = String(holder[field] || '').trim()
    if (isHttpsUrl(u)) uris.add(u)
  })
  return uris
}

/**
 * 把一團資料裡**所有看起來是 https 網址的字串**撿出來（純函式）。
 *
 * 給 `sentContent.messages` 用：那一份是**編輯器格式**（`C-246`，後台預覽看得懂的那種），
 * 按鈕的網址放在哪一格跟 LINE 格式不一樣，⛔ 不能用上面那條 LINE 格式的走法。
 * 送出時網址會經過 `renderWithAttributes`（群發時 `{{變數}}` 換成空字串），
 * 所以同一個網址把變數拿掉的版本也一起收。
 * ⚠️ 一人一則送（`D-118` A）時變數換成**那一位的值**，這裡比不到＝點了回首頁；2026-10-15 唯讀查過正式庫
 *    網址裡放變數的模組與推播都是 0，待辦 `C-326`。
 * （開了貼標的網址按鈕是另一件事：目標是那一位的貼標連結，由 `/api/r/` 驗簽章後拿裡面的原網址比，`C-322`）
 * 有深度與數量上限：這是公開端點每點一次就要跑的東西，⛔ 不可以被一份怪資料拖住。
 */
export function collectHttpsStringsDeep(value: unknown, maxDepth = 12, maxCount = 500): Set<string> {
  const out = new Set<string>()
  const walk = (v: unknown, depth: number) => {
    if (out.size >= maxCount || depth > maxDepth || v == null) return
    if (typeof v === 'string') {
      const s = v.trim()
      if (!isHttpsUrl(s)) return
      out.add(s)
      if (s.includes('{{')) out.add(s.replace(/\{\{\s*[A-Za-z]\w*\s*\}\}/g, ''))
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    if (typeof v === 'object') {
      for (const item of Object.values(v as Record<string, unknown>)) walk(item, depth + 1)
    }
  }
  walk(value, 0)
  return out
}

/**
 * 這則推播有沒有**真的交給送出端過**（純函式，`G-95`）。
 *
 * 追蹤連結只會在正式送出時產生（試發不包，見 `test-send.post.ts`），所以從來沒送過的草稿
 * 不可能有客人手上的連結。⛔ 不擋的話，任何一位客服建一則草稿、把釣魚網址填進按鈕，
 * 就能自己組出「我們網域 → 那個網址」的連結，完全不用真的發出去。
 * - `processing`／`completed`／`failed` 都算：`failed` 可能是看門狗收殮的（訊息其實送出去了）。
 * - 失敗後按「重設」會回到草稿、`retryCount` 加一——那一輪可能也送出去過，所以也算。
 */
export function broadcastEverHandedToSender(doc: { status?: unknown, retryCount?: unknown }): boolean {
  const status = String(doc?.status || '')
  if (status === 'processing' || status === 'completed' || status === 'failed') return true
  return Number(doc?.retryCount ?? 0) > 0
}

/**
 * 點下去的目標網址，是不是這則推播送出時真的包過的那幾個之一（純函式，`G-95`）。
 *
 * 看兩份：`messages`（非模組型送出去的就是這一份，送出後不能再改）與 `sentContent.messages`
 * （模組型從 `C-246` 起留存的當時內容）。模組型更早以前送的，要由呼叫端再拿模組現在的內容比一次。
 */
export function clickTargetInBroadcast(
  targetUrl: string,
  doc: { messages?: unknown, sentContent?: unknown },
): boolean {
  const target = String(targetUrl || '').trim()
  if (!target) return false
  if (collectClickTrackableUris(doc?.messages).has(target)) return true
  return collectHttpsStringsDeep((doc?.sentContent as { messages?: unknown } | null | undefined)?.messages).has(target)
}
