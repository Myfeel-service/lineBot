<template>
  <aside class="fmp" :class="{ 'fmp--bare': bare }" aria-label="訊息預覽">
    <!--
      `D-128`：預覽裡標黃色的是範例（王小明），這一句講清楚。呼叫端用 previewVariableNote 給。
      ⛔ 放在手機**上面**：放底下會被右下角的小幫手浮鈕蓋住（實機截圖看到；推播頁那句也是這樣搬上去的）
    -->
    <p v-if="variableNote" class="fmp-var-note">{{ variableNote }}</p>
    <div class="fmp-frame">
      <!--
        `bare`：只畫泡泡，不要自己的聊天室外框（`C-256`）。
        ⛔ 存在的理由不是彈性：圖文選單的試按是把訊息畫進**它自己那個聊天室**裡，
           不 bare 的話會變成「聊天室裡面又有一個聊天室」，還多一條假的輸入列。
      -->
      <div v-if="!bare" class="fmp-chat-head">
        <span class="fmp-avatar">{{ oaInitial }}</span>
        <div class="fmp-chat-meta">
          <span class="fmp-chat-name">{{ oaName || '官方帳號' }}</span>
          <span class="fmp-chat-sub">預覽・實際以 LINE 為準</span>
        </div>
      </div>
      <div class="fmp-body">
        <div v-if="!messages.length" class="fmp-empty">
          <el-icon class="fmp-empty-icon" aria-hidden="true"><ChatDotRound /></el-icon>
          <p>左側新增訊息後，<br>這裡會即時顯示在 LINE 裡的樣子</p>
        </div>

        <div v-for="(msg, i) in messages" :key="i" class="fmp-row">
          <!-- 文字（無按鈕＝純氣泡；有按鈕＝卡片，`C-397` 前是按鈕範本） -->
          <template v-if="msg.type === 'text'">
            <!--
              `C-416` 文字加了圖＝一張卡：跟卡片訊息的單張卡同一個樣子，圖照原比例不裁、按鈕沒存樣式算綠色。
              比例、按鈕樣式都吃 `shared/text-image-card.ts`，跟送出端同一份。
            -->
            <div v-if="textImageUrl(msg)" class="fmp-carousel">
              <div class="fmp-cc fmp-cc--card fmp-cc--single">
                <div class="fmp-cc-img fmp-cc-img--fit" :style="{ aspectRatio: textImageAspect(msg.imageWidth, msg.imageHeight).css }">
                  <img :src="textImageUrl(msg)" alt="">
                </div>
                <div class="fmp-cc-body">
                  <p v-if="cardText(msg.title)" class="fmp-cc-title"><PreviewText :text="cardText(msg.title)" /></p>
                  <p class="fmp-cc-text"><PreviewText :text="cardText(keptText(msg))" /></p>
                  <div v-if="droppedText(msg)" class="fmp-card-cut">
                    <span class="fmp-card-cut-label">↓ 以下 {{ visibleLength(droppedText(msg)) }} 字送不出去（LINE 單則文字只收 {{ textMeasure(msg).limit }} 字）</span>
                    <p class="fmp-card-cut-text"><PreviewText :text="droppedText(msg)" /></p>
                  </div>
                </div>
                <div v-if="hasButtons(msg)" class="fmp-cc-btns">
                  <span
                    v-for="(b, bi) in msg.buttons"
                    :key="bi"
                    class="fmp-btn"
                    :class="{ 'fmp-btn--primary': textImageButtonStyle(b) === 'primary' }"
                  ><PreviewText :text="b.label || '按鈕'" /></span>
                </div>
              </div>
            </div>
            <!--
              ⛔ 純文字氣泡也要講被丟掉的那一段（`C-229` 補）。原本這裡只畫 `keptText`，
              超過 5000 字的部分**在預覽裡無聲消失**——看起來一切正常，客人卻收到半截，
              跟 `H-27` 當初那條「有按鈕時只收 160 字」是同一個病，只是躲在另一個分支。
              ⚠️ 推播的純文字欄位沒有字數上限，所以這條路是真的走得到的。
            -->
            <template v-else-if="!hasButtons(msg)">
              <div class="fmp-bubble"><PreviewText :text="keptText(msg)" /></div>
              <div v-if="droppedText(msg)" class="fmp-bubble-cut">
                <span class="fmp-card-cut-label">↓ 以下 {{ visibleLength(droppedText(msg)) }} 字送不出去（LINE 單則文字只收 {{ textMeasure(msg).limit }} 字）</span>
                <p class="fmp-card-cut-text"><PreviewText :text="droppedText(msg)" /></p>
              </div>
            </template>
            <div v-else class="fmp-card">
              <p class="fmp-card-text"><PreviewText :text="keptText(msg)" /></p>
              <!-- 超過上限的部分：照樣顯示，但明講「送不出去」（推播的系統卡還是按鈕範本，上限 160） -->
              <div v-if="droppedText(msg)" class="fmp-card-cut">
                <span class="fmp-card-cut-label">↓ 以下 {{ visibleLength(droppedText(msg)) }} 字送不出去（這張卡 LINE 只收 {{ textMeasure(msg).limit }} 字）</span>
                <p class="fmp-card-cut-text"><PreviewText :text="droppedText(msg)" /></p>
              </div>
              <div class="fmp-btns">
                <span v-for="(b, bi) in msg.buttons" :key="bi" class="fmp-btn"><PreviewText :text="b.label || '按鈕'" /></span>
              </div>
            </div>
          </template>

          <!-- 圖片 -->
          <div v-else-if="msg.type === 'image'" class="fmp-media">
            <img v-if="imgUrl(msg)" :src="imgUrl(msg)" class="fmp-media-img" alt="">
            <div v-else class="fmp-media-ph"><el-icon><Picture /></el-icon> 圖片</div>
          </div>

          <!-- 影片 -->
          <div v-else-if="msg.type === 'video'" class="fmp-media fmp-media--video">
            <img v-if="msg.previewImageUrl" :src="msg.previewImageUrl" class="fmp-media-img" alt="">
            <div v-else class="fmp-media-ph"><el-icon><VideoCamera /></el-icon> 影片</div>
            <span class="fmp-play" aria-hidden="true">▶</span>
          </div>

          <!-- 圖文訊息（imagemap 大圖＋可點區塊）／舊版引用 -->
          <div v-else-if="msg.type === 'richMessage' || msg.type === 'richMessageRef'" class="fmp-imagemap" :style="imagemapStyle(msg)">
            <img v-if="heroOf(msg)" :src="heroOf(msg)" class="fmp-imagemap-img" alt="">
            <div v-else class="fmp-media-ph fmp-imagemap-ph"><el-icon><Postcard /></el-icon> 圖文訊息</div>
            <span v-for="(r, ri) in regionsOf(msg)" :key="ri" class="fmp-region" :style="regionStyle(r)" />
          </div>

          <!-- 輪播（縮圖＋標題＋內文＋按鈕） -->
          <div v-else-if="msg.type === 'carousel'" class="fmp-carousel">
            <div v-for="(col, ci) in cols(msg)" :key="ci" class="fmp-cc">
              <div class="fmp-cc-img" :style="{ aspectRatio: carouselAspect(msg) }">
                <img v-if="col.thumbnailImageUrl" :src="col.thumbnailImageUrl" alt="">
                <div v-else class="fmp-media-ph"><el-icon><Picture /></el-icon></div>
              </div>
              <div class="fmp-cc-body">
                <p class="fmp-cc-title"><PreviewText :text="col.title || '標題'" /></p>
                <p v-if="col.text" class="fmp-cc-text"><PreviewText :text="col.text" /></p>
              </div>
              <div class="fmp-cc-btns">
                <span v-for="(a, ai) in (col.actions || [])" :key="ai" class="fmp-btn"><PreviewText :text="a.label || '按鈕'" /></span>
              </div>
            </div>
          </div>

          <!-- 圖片輪播（純圖卡，整張可點） -->
          <div v-else-if="msg.type === 'imageCarousel'" class="fmp-carousel">
            <div v-for="(col, ci) in cols(msg)" :key="ci" class="fmp-cc fmp-cc--imageonly">
              <div class="fmp-cc-img fmp-cc-img--square">
                <img v-if="col.imageUrl" :src="col.imageUrl" alt="">
                <div v-else class="fmp-media-ph"><el-icon><Picture /></el-icon></div>
              </div>
            </div>
          </div>

          <!--
            卡片訊息（`C-398` 以前叫輪播訊息：可關圖＋標題＋內文＋底部按鈕）。
            字全部照 LINE 那樣換行顯示（⛔ 以前標題一行、內文兩行就截掉，預覽看不到客人會看到的字）；只有一張時畫寬一點
          -->
          <div v-else-if="msg.type === 'flexImageCarousel'" class="fmp-carousel">
            <div v-for="(col, ci) in cols(msg)" :key="ci" class="fmp-cc fmp-cc--card" :class="{ 'fmp-cc--single': cols(msg).length === 1 }">
              <div v-if="flexUsesImage(msg)" class="fmp-cc-img" :style="{ aspectRatio: flexAspect(msg) }">
                <img v-if="col.imageUrl" :src="col.imageUrl" alt="">
                <div v-else class="fmp-media-ph"><el-icon><Picture /></el-icon></div>
              </div>
              <!-- 送出端會去掉頭尾空行（handler.ts 的 .trim()），預覽跟著去，不然多畫一行客人看不到的空白 -->
              <div v-if="cardText(col.title) || cardText(col.text)" class="fmp-cc-body">
                <p v-if="cardText(col.title)" class="fmp-cc-title"><PreviewText :text="cardText(col.title)" /></p>
                <p v-if="cardText(col.text)" class="fmp-cc-text"><PreviewText :text="cardText(col.text)" /></p>
              </div>
              <div v-if="(col.actions || []).length" class="fmp-cc-btns">
                <span
                  v-for="(a, ai) in col.actions"
                  :key="ai"
                  class="fmp-btn"
                  :class="{ 'fmp-btn--primary': cardButtonStyle(a) === 'primary' }"
                ><PreviewText :text="a.label || '按鈕'" /></span>
              </div>
            </div>
          </div>

          <!-- 快速回覆（氣泡＋下方膠囊列） -->
          <template v-else-if="msg.type === 'quickReply'">
            <div class="fmp-bubble"><PreviewText :text="msg.text || '（文字內容）'" /></div>
            <div class="fmp-qr">
              <span v-for="(q, qi) in (msg.quickReplies || [])" :key="qi" class="fmp-qr-pill">
                <img v-if="q.imageUrl" :src="q.imageUrl" class="fmp-qr-icon" alt="">
                <PreviewText :text="q.action?.label || '選項'" />
              </span>
            </div>
          </template>

          <!-- 用戶輸入卡片（對用戶＝一則提問氣泡） -->
          <div v-else-if="msg.type === 'userInput'" class="fmp-bubble"><PreviewText :text="msg.text || '（提問文字）'" /></div>

          <!-- 其他 -->
          <div v-else class="fmp-bubble fmp-bubble--muted">{{ msg.type }}</div>
        </div>
      </div>
      <div v-if="!bare" class="fmp-inputbar" aria-hidden="true">
        <span class="fmp-input-fake">Aa</span>
        <span class="fmp-input-send">➤</span>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ChatDotRound, Picture, Postcard, VideoCamera } from '@element-plus/icons-vue'
import { resolveCarouselImageAspectRatio, resolveFlexImageCarouselAspectRatio } from '~~/shared/line-image-spec'
import { PRESET_BOUNDS_PCT } from '~~/shared/rich-layout-presets'
import { LINE_TEXT_MESSAGE_MAX, measureLineText, messageHasButtons } from '~~/shared/line-text-limits'
import { cardButtonStyle } from '~~/shared/card-message'
import { textImageAspect, textImageButtonStyle, textMessageImageUrl } from '~~/shared/text-image-card'
import { splitPreviewMarks } from '~~/shared/preview-variables'

const props = defineProps<{
  messages: any[]
  richMessages?: any[]
  oaName?: string
  /** 預覽底下那一句（「標黃色的是範例：…」）；空的就不畫 */
  variableNote?: string
  /** 只畫泡泡：不要聊天室標題列、不要假的輸入列、不要外框（要嵌進別人的聊天室裡時用） */
  bare?: boolean
}>()

const oaInitial = computed(() => (props.oaName || '官').trim().charAt(0).toUpperCase())

function hasButtons(msg: any) {
  return messageHasButtons(msg)
}

/*
 * ⛔ 預覽的文字一定要照送出端的規則截斷（`H-27`）。
 * 原本這裡原封渲染 `msg.text`，掛按鈕的長文在預覽裡看起來好好的、客人卻只收到前
 * 160 字——**預覽在說謊**比沒有預覽更糟。截斷法與 `buildLineMessages` 共用
 * `shared/line-text-limits`，兩邊保證切在同一格。
 * 被切掉的那段不是不顯示，而是另外標出來——過濾掉東西要說得出丟了什麼。
 * 上限：模組的文字（有沒有按鈕）都是 5000（`C-397`）；推播的系統卡是按鈕範本，
 * 由 `lineMessagesToPreviewMessages` 帶 `textLimit: 160` 進來。
 */
function textMeasure(msg: any) {
  return measureLineText(String(msg?.text || ''), Number(msg?.textLimit) || LINE_TEXT_MESSAGE_MAX)
}
function keptText(msg: any): string {
  return textMeasure(msg).kept || '（文字內容）'
}
function droppedText(msg: any): string {
  return textMeasure(msg).dropped
}
/** 字數不算範例的標記（`D-128`：預覽的範例值前後夾了看不見的記號，`PreviewText` 用來標黃色） */
function visibleLength(s: string): number {
  return splitPreviewMarks(s).reduce((n, seg) => n + seg.text.length, 0)
}
function textImageUrl(msg: any): string {
  return textMessageImageUrl(msg)
}
function imgUrl(msg: any): string {
  return msg.previewImageUrl || msg.originalContentUrl || ''
}
function cols(msg: any): any[] {
  return Array.isArray(msg.columns) ? msg.columns : []
}
function cardText(s: unknown): string {
  return String(s ?? '').trim()
}
function flexUsesImage(msg: any): boolean {
  return msg.enableImage !== false
}
function carouselAspect(msg: any): string {
  const { width, height } = resolveCarouselImageAspectRatio(msg?.imageAspectRatio)
  return `${width} / ${height}`
}
function flexAspect(msg: any): string {
  const { widthRatio, heightRatio } = resolveFlexImageCarouselAspectRatio(msg?.imageAspectRatio)
  return `${widthRatio} / ${heightRatio}`
}
// richMessageRef 需要用 id 去清單查出實際內容；richMessage 本身即內容
function resolved(msg: any): any {
  if (msg.type === 'richMessageRef') {
    /*
     * `C-246`：訊息自己帶著 `payload` 時**優先用它**。
     * 推播送出時會把當時的圖文訊息連內容一起存進推播紀錄（送出端 hydrate 過的那一份），
     * 回頭查「我那天發了什麼」畫的必須是**當時那張圖**；改用現在的清單去查，
     * 圖被換過就會畫出一張從來沒送出去的圖，等於換個地方繼續說謊。
     */
    if (msg.payload && typeof msg.payload === 'object') return msg.payload
    return (props.richMessages || []).find((r: any) => r.id === msg.richMessageId) || null
  }
  return msg
}
function heroOf(msg: any): string {
  return resolved(msg)?.heroImageUrl || ''
}
function imagemapStyle(msg: any) {
  const r = resolved(msg)
  const w = Number(r?.heroImageWidth) || 0
  const h = Number(r?.heroImageHeight) || 0
  return { aspectRatio: w && h ? `${w} / ${h}` : '1 / 1' }
}
// 回傳可點區塊（百分比座標）：custom 由 bounds(px) 換算，其餘用版型預設百分比表
function regionsOf(msg: any): Array<{ x: number; y: number; w: number; h: number }> {
  const r = resolved(msg)
  if (!r) return []
  const layoutId = r.layoutId || 'single'
  if (layoutId === 'custom') {
    const w = Number(r.heroImageWidth) || 1040
    const h = Number(r.heroImageHeight) || 1040
    const canvasW = 1040
    const canvasH = canvasW * (h / w)
    return (Array.isArray(r.actions) ? r.actions : [])
      .filter((a: any) => a?.bounds)
      .map((a: any) => ({
        x: (a.bounds.x / canvasW) * 100,
        y: (a.bounds.y / canvasH) * 100,
        w: (a.bounds.width / canvasW) * 100,
        h: (a.bounds.height / canvasH) * 100,
      }))
  }
  const preset = (PRESET_BOUNDS_PCT as Record<string, Array<{ x: number; y: number; w: number; h: number }>>)[layoutId]
  return Array.isArray(preset) ? preset.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h })) : []
}
function regionStyle(r: { x: number; y: number; w: number; h: number }) {
  return { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }
}
</script>
