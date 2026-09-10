<template>
  <aside class="fmp" aria-label="訊息預覽">
    <div class="fmp-frame">
      <div class="fmp-chat-head">
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
          <!-- 文字（無按鈕＝純氣泡；有按鈕＝按鈕範本卡） -->
          <template v-if="msg.type === 'text'">
            <div v-if="!hasButtons(msg)" class="fmp-bubble">{{ keptText(msg) }}</div>
            <div v-else class="fmp-card">
              <p class="fmp-card-text">{{ keptText(msg) }}</p>
              <!-- 超過 160 字的部分：照樣顯示，但明講「送不出去」 -->
              <div v-if="droppedText(msg)" class="fmp-card-cut">
                <span class="fmp-card-cut-label">↓ 以下 {{ droppedText(msg).length }} 字送不出去（有按鈕時 LINE 只收 160 字）</span>
                <p class="fmp-card-cut-text">{{ droppedText(msg) }}</p>
              </div>
              <div class="fmp-btns">
                <span v-for="(b, bi) in msg.buttons" :key="bi" class="fmp-btn">{{ b.label || '按鈕' }}</span>
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
                <p class="fmp-cc-title">{{ col.title || '標題' }}</p>
                <p v-if="col.text" class="fmp-cc-text">{{ col.text }}</p>
              </div>
              <div class="fmp-cc-btns">
                <span v-for="(a, ai) in (col.actions || [])" :key="ai" class="fmp-btn">{{ a.label || '按鈕' }}</span>
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

          <!-- 輪播訊息（新版：可關圖＋標題＋內文＋底部按鈕） -->
          <div v-else-if="msg.type === 'flexImageCarousel'" class="fmp-carousel">
            <div v-for="(col, ci) in cols(msg)" :key="ci" class="fmp-cc">
              <div v-if="flexUsesImage(msg)" class="fmp-cc-img" :style="{ aspectRatio: flexAspect(msg) }">
                <img v-if="col.imageUrl" :src="col.imageUrl" alt="">
                <div v-else class="fmp-media-ph"><el-icon><Picture /></el-icon></div>
              </div>
              <div v-if="col.title || col.text" class="fmp-cc-body">
                <p v-if="col.title" class="fmp-cc-title">{{ col.title }}</p>
                <p v-if="col.text" class="fmp-cc-text">{{ col.text }}</p>
              </div>
              <div v-if="(col.actions || []).length" class="fmp-cc-btns">
                <span v-for="(a, ai) in col.actions" :key="ai" class="fmp-btn">{{ a.label || '按鈕' }}</span>
              </div>
            </div>
          </div>

          <!-- 快速回覆（氣泡＋下方膠囊列） -->
          <template v-else-if="msg.type === 'quickReply'">
            <div class="fmp-bubble">{{ msg.text || '（文字內容）' }}</div>
            <div class="fmp-qr">
              <span v-for="(q, qi) in (msg.quickReplies || [])" :key="qi" class="fmp-qr-pill">
                <img v-if="q.imageUrl" :src="q.imageUrl" class="fmp-qr-icon" alt="">
                {{ q.action?.label || '選項' }}
              </span>
            </div>
          </template>

          <!-- 用戶輸入卡片（對用戶＝一則提問氣泡） -->
          <div v-else-if="msg.type === 'userInput'" class="fmp-bubble">{{ msg.text || '（提問文字）' }}</div>

          <!-- 其他 -->
          <div v-else class="fmp-bubble fmp-bubble--muted">{{ msg.type }}</div>
        </div>
      </div>
      <div class="fmp-inputbar" aria-hidden="true">
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
import { measureLineText, messageHasButtons } from '~~/shared/line-text-limits'

const props = defineProps<{ messages: any[]; richMessages?: any[]; oaName?: string }>()

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
 */
function textMeasure(msg: any) {
  return measureLineText(String(msg?.text || ''), hasButtons(msg))
}
function keptText(msg: any): string {
  return textMeasure(msg).kept || '（文字內容）'
}
function droppedText(msg: any): string {
  return textMeasure(msg).dropped
}
function imgUrl(msg: any): string {
  return msg.previewImageUrl || msg.originalContentUrl || ''
}
function cols(msg: any): any[] {
  return Array.isArray(msg.columns) ? msg.columns : []
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
