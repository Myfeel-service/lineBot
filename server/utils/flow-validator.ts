import { createError } from 'h3'
import { validateUnifiedAction } from '~~/shared/action-schema'
import { lineTextOverflowMessage, measureLineText, messageHasButtons } from '~~/shared/line-text-limits'

const FLOW_MESSAGE_LIMIT = 5
const USER_INPUT_ATTRIBUTE_RE = /^[A-Za-z][A-Za-z0-9_]{0,49}$/

function fail(statusMessage: string): never {
  throw createError({ statusCode: 400, statusMessage })
}

function ensureTaggingSelection(tagging: any, prefix: string): void {
  if (tagging?.enabled === true) {
    const tagIds = Array.isArray(tagging?.addTagIds)
      ? tagging.addTagIds.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : []
    if (tagIds.length === 0) fail(`${prefix}：已啟用貼標，請至少選擇一個標籤`)
  }
}

/**
 * ⛔ 文字長度一定要在這裡擋，不能只靠前端的 `maxlength`。
 * `maxlength` 只擋「當下打的字」——先把長文貼好、之後才加按鈕，舊值不會被裁，
 * 上限形同虛設（`H-27` 就是這樣進來的：5 則模組存著超長文字、發出去被切一半）。
 * 這裡是唯一的收斂點（建立與更新兩支端點都走 `assertValidFlowMessages`）。
 */
function validateTextLength(msg: any): void {
  const measure = measureLineText(String(msg?.text || ''), messageHasButtons(msg))
  if (measure.willTruncate) fail(lineTextOverflowMessage(measure))
}

function validateTextButtons(msg: any): void {
  if (!Array.isArray(msg?.buttons)) return
  if (msg.buttons.length > 4) fail('文字模組：按鈕最多 4 個')

  for (const btn of msg.buttons) {
    if (!String(btn?.label || '').trim()) fail('文字模組：請輸入按鈕標題')
    if (btn?.type === 'message' && !String(btn?.text || '').trim()) {
      fail('文字模組：請輸入按鈕傳送文字')
    }
    if (btn?.type === 'uri' && !String(btn?.uri || '').trim()) {
      fail('文字模組：請輸入按鈕網址')
    }
    if (btn?.type === 'module' && !String(btn?.moduleId || '').trim()) {
      fail('文字模組：請選擇要觸發的機器人模組')
    }
    ensureTaggingSelection(btn?.tagging, '文字模組')
  }
}

function validateQuickReply(msg: any): void {
  if (!String(msg?.text || '').trim()) fail('快速回覆模組：搭配的文字內容為必填')
  if (!Array.isArray(msg?.quickReplies) || msg.quickReplies.length < 1) {
    fail('快速回覆模組：至少要有 1 個快速回覆選項')
  }
  if (msg.quickReplies.length > 13) fail('快速回覆模組：最多 13 個快速回覆選項')

  for (const qr of msg.quickReplies) {
    if (!String(qr?.action?.label || '').trim()) fail('快速回覆：請輸入按鈕名稱')
    if (qr?.action?.type === 'message' && !String(qr?.action?.text || '').trim()) {
      fail('快速回覆：回覆文字不可為空')
    }
    if (qr?.action?.type === 'uri' && !String(qr?.action?.uri || '').trim()) {
      fail('快速回覆：網址不可為空')
    }
    if (qr?.action?.type === 'module' && !String(qr?.action?.moduleId || '').trim()) {
      fail('快速回覆：請選擇要觸發的機器人模組')
    }
    ensureTaggingSelection(qr?.action?.tagging, '快速回覆')
  }
}

function validateUserInput(msg: any): void {
  if (!String(msg?.text || '').trim()) fail('用戶輸入卡片：請輸入你的問題')
  if (!String(msg?.moduleId || '').trim()) {
    fail('用戶輸入卡片：請選擇等待回覆後要觸發的下一個模組')
  }
  const attribute = String(msg?.attribute || '').trim()
  if (attribute && !USER_INPUT_ATTRIBUTE_RE.test(attribute)) {
    fail('用戶輸入卡片：儲存屬性名稱格式錯誤，請使用英文字母開頭，且只能包含英數與底線')
  }
  ensureTaggingSelection(msg?.tagging, '用戶輸入卡片')
}

function validateRichMessage(msg: any): void {
  if (!String(msg?.altText || '').trim()) fail('圖文訊息：請輸入提醒文字（Alt Text）')
  if (!String(msg?.heroImageUrl || '').trim()) fail('圖文訊息：請上傳背景圖片')
  if (!Array.isArray(msg?.actions) || msg.actions.length < 1) {
    fail('圖文訊息：尚未設定任何動作區塊')
  }
  for (const action of msg.actions) {
    const error = validateUnifiedAction({
      slot: String(action?.slot || ''),
      type: action?.type === 'message' || action?.type === 'module' ? action.type : 'uri',
      uri: String(action?.uri || ''),
      text: String(action?.text || ''),
      moduleId: String(action?.moduleId || ''),
      tagging: {
        enabled: action?.tagging?.enabled === true,
        addTagIds: Array.isArray(action?.tagging?.addTagIds) ? action.tagging.addTagIds : [],
      },
    })
    if (error) fail(`圖文訊息：區塊 ${String(action?.slot || '?')} ${error}`)
  }
}

function validateCarousel(msg: any): void {
  if (!Array.isArray(msg?.columns) || msg.columns.length < 1) fail('輪播訊息：至少要有 1 個欄位')
  if (msg.columns.length > 10) fail('輪播訊息：最多 10 個欄位')

  for (const col of msg.columns) {
    if (!String(col?.thumbnailImageUrl || '').trim()) fail('輪播訊息：每個欄位都需要縮圖')
    if (!String(col?.title || '').trim()) fail('輪播訊息：標題為必填')
    if (!Array.isArray(col?.actions) || col.actions.length < 1) {
      fail('輪播訊息：每個欄位至少要有 1 個按鈕')
    }
    if (col.actions.length > 3) fail('輪播訊息：每個欄位按鈕最多 3 個')
    for (const action of col.actions) {
      if (!String(action?.label || '').trim()) fail('輪播按鈕文字為必填')
      if (action?.type === 'uri' && !String(action?.uri || '').trim()) fail('輪播按鈕網址為必填')
      if (action?.type === 'message' && !String(action?.text || '').trim()) fail('輪播按鈕傳送文字為必填')
      if (action?.type === 'module' && !String(action?.moduleId || '').trim()) {
        fail('輪播：請選擇要觸發的機器人模組')
      }
      ensureTaggingSelection(action?.tagging, '輪播')
    }
  }
}

function validateImageCarousel(msg: any): void {
  if (!Array.isArray(msg?.columns) || msg.columns.length < 1) fail('圖片輪播：至少要有 1 個欄位')
  if (msg.columns.length > 10) fail('圖片輪播：最多 10 個欄位')

  for (const col of msg.columns) {
    if (!String(col?.imageUrl || '').trim()) fail('圖片輪播：每個欄位都需要圖片')
    const action = col?.action
    if (action?.type === 'uri') {
      if (!String(action?.label || '').trim()) fail('圖片輪播按鈕文字為必填')
      if (!String(action?.uri || '').trim()) fail('圖片輪播網址為必填')
    }
    if (action?.type === 'message') {
      if (!String(action?.label || '').trim()) fail('圖片輪播按鈕文字為必填')
      if (!String(action?.text || '').trim()) fail('圖片輪播傳送文字為必填')
    }
    if (action?.type === 'module') {
      if (!String(action?.label || '').trim()) fail('圖片輪播按鈕文字為必填')
      if (!String(action?.moduleId || '').trim()) fail('圖片輪播：請選擇要觸發的機器人模組')
    }
    ensureTaggingSelection(action?.tagging, '圖片輪播')
  }
}

function validateFlexImageCarousel(msg: any): void {
  if (!Array.isArray(msg?.columns) || msg.columns.length < 1) fail('輪播訊息：至少要有 1 個欄位')
  if (msg.columns.length > 10) fail('輪播訊息：最多 10 個欄位')

  const enableImage = msg?.enableImage !== false

  for (const col of msg.columns) {
    if (enableImage) {
      if (!String(col?.imageUrl || '').trim()) fail('輪播訊息：已開啟圖片，每個欄位都需要上傳圖片')
    }
    else if (!String(col?.title || '').trim()) {
      fail('輪播訊息：未開啟圖片時，每個欄位標題為必填')
    }
    const action = col?.action
    if (enableImage) {
      if (action?.type === 'uri') {
        if (!String(action?.uri || '').trim()) fail('輪播訊息：圖片動作網址為必填')
      }
      if (action?.type === 'message') {
        if (!String(action?.text || '').trim()) fail('輪播訊息：圖片動作傳送文字為必填')
      }
      if (action?.type === 'module') {
        if (!String(action?.moduleId || '').trim()) fail('輪播訊息：請選擇圖片動作要觸發的機器人模組')
      }
      ensureTaggingSelection(action?.tagging, '輪播訊息')
    }

    if (Array.isArray(col?.actions)) {
      if (col.actions.length > 3) fail('輪播訊息：每個欄位按鈕最多 3 個')
      for (const btn of col.actions) {
        if (!String(btn?.label || '').trim()) fail('輪播訊息：按鈕文字為必填')
        if (btn?.type === 'uri' && !String(btn?.uri || '').trim()) fail('輪播訊息：按鈕網址為必填')
        if (btn?.type === 'message' && !String(btn?.text || '').trim()) fail('輪播訊息：按鈕傳送文字為必填')
        if (btn?.type === 'module' && !String(btn?.moduleId || '').trim()) {
          fail('輪播訊息：請選擇按鈕要觸發的機器人模組')
        }
        ensureTaggingSelection(btn?.tagging, '輪播訊息')
      }
    }
  }
}

function validateMessageByType(msg: any): void {
  const type = String(msg?.type || '').trim()
  if (!type) fail('訊息格式錯誤：缺少 type')

  if (type === 'text') {
    if (!String(msg?.text || '').trim()) fail('文字模組：回覆文字不可為空')
    validateTextLength(msg)
    validateTextButtons(msg)
    return
  }
  if (type === 'image') {
    if (!String(msg?.originalContentUrl || '').trim()) fail('圖片模組：缺少原圖網址')
    if (!String(msg?.previewImageUrl || '').trim()) fail('圖片模組：缺少預覽圖網址')
    return
  }
  if (type === 'video') {
    if (!String(msg?.originalContentUrl || '').trim()) fail('影片模組：缺少影片網址')
    if (!String(msg?.previewImageUrl || '').trim()) fail('影片模組：缺少預覽圖網址')
    return
  }
  if (type === 'quickReply') return validateQuickReply(msg)
  if (type === 'userInput') return validateUserInput(msg)
  if (type === 'richMessage') return validateRichMessage(msg)
  if (type === 'richMessageRef') {
    if (!String(msg?.richMessageId || '').trim()) fail('圖文訊息：請選擇已建立的圖文訊息')
    return
  }
  if (type === 'carousel') return validateCarousel(msg)
  if (type === 'imageCarousel') return validateImageCarousel(msg)
  if (type === 'flexImageCarousel') return validateFlexImageCarousel(msg)

  fail(`不支援的訊息類型：${type}`)
}

export function assertValidFlowMessages(messages: unknown): asserts messages is any[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    fail('請至少新增一則回覆訊息')
  }
  if (messages.length > FLOW_MESSAGE_LIMIT) {
    fail(`單一模組最多只能儲存 ${FLOW_MESSAGE_LIMIT} 則訊息`)
  }

  const quickReplyCount = messages.filter((item) => item?.type === 'quickReply').length
  const userInputCount = messages.filter((item) => item?.type === 'userInput').length
  if (quickReplyCount > 1) fail('快速回覆模組：每個流程只能有一個')
  if (userInputCount > 1) fail('用戶輸入卡片：每個流程只能有一張')
  if (quickReplyCount > 0 && userInputCount > 0) {
    fail('不能同時設定「快速回覆」與「用戶輸入卡片」')
  }
  if (userInputCount > 0 && messages[messages.length - 1]?.type !== 'userInput') {
    fail('用戶輸入卡片必須放在所有訊息的最結尾')
  }

  for (const msg of messages) {
    validateMessageByType(msg)
  }
}

export function assertValidFlowName(name: unknown): string {
  const trimmed = String(name || '').trim()
  if (!trimmed) fail('請輸入模組名稱')
  return trimmed
}
