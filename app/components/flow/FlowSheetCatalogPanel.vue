<template>
  <!--
    `C-436`：商品目錄「照試算表排」——卡片不在這裡做，照試算表「放進LINE目錄」的勾排（`D-166` ⑤「商品的事都在試算表做」）。
    ⛔ 這一塊沒有任何開關：要加、拿掉、換順序都到試算表改；這裡只看、換圖。
    ⛔ 不畫「連接試算表」長相的東西（試算表圖示＋名稱＋更新鈕）——第二版就是被讀成「又要接一次」；出處只寫一行＋打開試算表。
  -->
  <div class="sheet-catalog-panel" data-tour="sheet-catalog-panel">
    <div class="carousel-card-top">
      <span class="badge badge-blue">照試算表排</span>
      <span v-if="view?.ready" class="sheet-catalog-count">目錄 {{ cards.length }}／{{ view.max }} 張</span>
    </div>

    <div class="sheet-catalog-body">
      <p v-if="!sourceId" class="sheet-catalog-note">先在左邊選要照哪一份試算表排。</p>
      <p v-else-if="error" class="sheet-catalog-warn">{{ error }}</p>
      <p v-else-if="!view" class="sheet-catalog-note">讀取中…</p>

      <template v-else>
        <div class="sheet-catalog-source">
          <span>照試算表「{{ view.sourceName }}」排：「放進LINE目錄」打勾的商品，照試算表的順序。要加、拿掉、換順序，都到試算表改。</span>
          <div class="sheet-catalog-source-line">
            <span class="text-xs text-muted">LINE 一則目錄最多 {{ view.max }} 張<template v-if="lastFetchedLabel">・上次更新 {{ lastFetchedLabel }}</template></span>
            <a v-if="view.sheetUrl" :href="view.sheetUrl" target="_blank" rel="noopener" class="sheet-catalog-link">打開試算表 ↗</a>
          </div>
        </div>

        <p v-if="!view.ready" class="sheet-catalog-note">
          這份試算表還沒整理出商品清單：到知識庫按「立即更新」，或等下一次自動更新（每小時）。
        </p>
        <p v-else-if="!view.catalogColumn" class="sheet-catalog-warn">
          試算表上還沒有「放進LINE目錄」這一欄：加一欄，在要放進目錄的商品打勾。
        </p>

        <div v-if="changeLines.length" class="sheet-catalog-changes">
          <b>試算表最近的變動</b>
          <span v-for="c in changeLines" :key="c.key">{{ c.text }}</span>
        </div>

        <section v-for="g in openGroups" :key="g.key" class="sheet-catalog-group" :class="`is-${g.key}`">
          <h4 class="sheet-catalog-group-title">
            {{ g.title }}<span v-if="g.hint" class="text-xs text-muted">{{ g.hint }}</span>
          </h4>
          <div v-for="p in g.items" :key="p.id" class="sheet-catalog-row">
            <img v-if="p.image" :src="p.image.url" :alt="p.title" class="sheet-catalog-thumb">
            <span v-else class="sheet-catalog-thumb is-empty">沒有圖</span>
            <div class="sheet-catalog-name">
              <span class="sheet-catalog-title">{{ p.title }}</span>
              <span class="sheet-catalog-meta">
                <template v-if="p.image">{{ p.image.source === 'own' ? '自己換的圖' : '商品頁封面圖' }}</template>
                <template v-else>{{ sheetCoverStatusText(p) }}</template>
                <template v-if="p.tag">・點了貼「{{ p.tag.name }}」</template>
              </span>
            </div>
            <div v-if="canEdit" class="sheet-catalog-actions">
              <el-button size="small" :loading="busyId === p.id" @click="pickImage(p)">{{ p.image ? '換圖' : '上傳圖片' }}</el-button>
              <el-button
                v-if="p.image?.source === 'own'"
                link
                size="small"
                :disabled="busyId === p.id"
                @click="revertImage(p)"
              >
                改回商品頁封面圖
              </el-button>
            </div>
          </div>
        </section>

        <details v-for="g in foldedGroups" :key="g.key" class="sheet-catalog-folded">
          <summary>{{ g.title }}（{{ g.items.length }}）</summary>
          <div v-for="p in g.items" :key="p.id" class="sheet-catalog-row is-dim">
            <img v-if="p.image" :src="p.image.url" :alt="p.title" class="sheet-catalog-thumb">
            <span v-else class="sheet-catalog-thumb is-empty">沒有圖</span>
            <div class="sheet-catalog-name">
              <span class="sheet-catalog-title">{{ p.title }}</span>
            </div>
          </div>
        </details>
      </template>
      <input ref="fileInput" type="file" accept="image/jpeg,image/png" class="sheet-catalog-file" @change="onFile">
    </div>
  </div>
</template>

<script setup lang="ts">
import { sheetCoverStatusText, sheetProductChangeText, type SheetCatalogView, type SheetCatalogViewProduct } from '~~/shared/sheet-catalog'

const props = defineProps<{
  sourceId: string
  view: SheetCatalogView | null
  error?: string
  canEdit: boolean
}>()

const emit = defineEmits<{
  /** 換了圖：重讀一次（目錄、預覽一起換） */
  changed: []
}>()

const { apiFetch } = useWorkspace()
const { showToast } = useAdminToast()
const { validateFile, uploadToStorage } = useMediaUpload()

const products = computed(() => props.view?.products ?? [])
const cards = computed(() => products.value.filter(p => p.placement === 'card'))

/** 分組照「他要做什麼」排：要處理的在上面，不用管的收起來 */
const openGroups = computed(() => [
  {
    key: 'overflow',
    title: '沒放上去：目錄只放得下 10 張',
    hint: '到試算表取消勾選，或把要放的往前排',
    items: products.value.filter(p => p.placement === 'overflow'),
  },
  {
    key: 'noImage',
    title: '還沒有圖，先不放進目錄',
    hint: '',
    items: products.value.filter(p => p.placement === 'noImage'),
  },
  { key: 'card', title: '在目錄上', hint: '', items: cards.value },
].filter(g => g.items.length))

const foldedGroups = computed(() => [
  { key: 'off', title: '不在目錄上的商品', items: products.value.filter(p => p.placement === 'off') },
  { key: 'missing', title: '試算表上找不到的商品', items: products.value.filter(p => p.placement === 'missing') },
].filter(g => g.items.length))

const changeLines = computed(() => (props.view?.changes ?? []).slice(0, 5).map((c, i) => ({
  key: `${c.at}-${i}`,
  text: `${formatShort(c.at)} ${sheetProductChangeText(c)}`,
})))

const lastFetchedLabel = computed(() => (props.view?.lastFetchedAt ? formatShort(props.view.lastFetchedAt) : ''))

function formatShort(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const fileInput = ref<HTMLInputElement | null>(null)
const busyId = ref('')
let pickingFor: SheetCatalogViewProduct | null = null

function pickImage(p: SheetCatalogViewProduct) {
  pickingFor = p
  if (fileInput.value) {
    fileInput.value.value = ''
    fileInput.value.click()
  }
}

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  const p = pickingFor
  pickingFor = null
  if (!file || !p) return
  const check = validateFile(file, 'image')
  if (!check.ok) {
    showToast(check.message, 'error')
    return
  }
  busyId.value = p.id
  try {
    const url = await uploadToStorage(file)
    await apiFetch('/api/flow/create?part=sheet-product-image', { method: 'POST', body: { sourceId: props.sourceId, productId: p.id, url } })
    showToast(`「${p.title}」換好圖了，目錄和商品資訊卡都用這張`, 'success')
    emit('changed')
  }
  catch (err: any) {
    showToast(err?.data?.statusMessage || '圖片沒換成，請再試一次', 'error')
  }
  finally {
    busyId.value = ''
  }
}

async function revertImage(p: SheetCatalogViewProduct) {
  busyId.value = p.id
  try {
    await apiFetch('/api/flow/create?part=sheet-product-image', { method: 'POST', body: { sourceId: props.sourceId, productId: p.id, revert: true } })
    showToast(p.hasCover ? `「${p.title}」改回商品頁的封面圖` : `「${p.title}」拿掉了自己換的圖，商品頁封面圖抓到之前先不放進目錄`, 'success')
    emit('changed')
  }
  catch (err: any) {
    showToast(err?.data?.statusMessage || '沒改成，請再試一次', 'error')
  }
  finally {
    busyId.value = ''
  }
}
</script>
