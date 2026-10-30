<template>
  <!--
    `C-436`：商品目錄「照試算表排」——卡片不在這裡做，照試算表「放進LINE目錄」的勾排（`D-166` ⑤「商品的事都在試算表做」）。
    ⛔ 這一塊沒有任何開關：要加、拿掉、換順序都到試算表改；這裡只看、換圖。
    ⛔ 不畫「連接試算表」長相的東西（試算表圖示＋名稱＋更新鈕）——第二版就是被讀成「又要接一次」；出處只寫一行＋打開試算表。
  -->
  <div class="sheet-catalog-panel" data-tour="sheet-catalog-panel">
    <div class="carousel-card-top">
      <span class="badge badge-blue">照試算表排</span>
      <!-- `C-449`：單位一律「個」（提醒中心、模組清單都講幾個商品） -->
      <span v-if="view?.ready" class="sheet-catalog-count">目錄上 {{ cards.length }}／{{ view.max }} 個</span>
    </div>

    <div class="sheet-catalog-body">
      <p v-if="!sourceId" class="sheet-catalog-note">先在左邊選要照哪一份試算表排。</p>
      <p v-else-if="error" class="sheet-catalog-warn">{{ error }}</p>
      <p v-else-if="!view" class="sheet-catalog-note">讀取中…</p>

      <template v-else>
        <!-- `C-449`：哪一份表、照試算表排，上面都寫了——這裡只講要做的事 -->
        <div class="sheet-catalog-source">
          <span>要加、拿掉、換順序，都在試算表改：「放進LINE目錄」打勾的，照試算表由上到下排上來。</span>
          <div class="sheet-catalog-source-line">
            <span class="text-xs text-muted">LINE 一則目錄最多 {{ view.max }} 個<template v-if="lastFetchedLabel">・上次更新 {{ lastFetchedLabel }}</template></span>
            <a v-if="view.sheetUrl" :href="view.sheetUrl" target="_blank" rel="noopener" class="sheet-catalog-link">打開試算表 ↗</a>
          </div>
        </div>

        <p v-if="!view.ready" class="sheet-catalog-note">
          這份試算表還沒整理出商品清單：到知識庫按「立即更新」，或等下一次自動更新（每小時）。
        </p>
        <!-- `C-448`：缺欄的人多半也不知道表要長怎樣——旁邊直接給看範本 -->
        <div v-else-if="!view.catalogColumn" class="sheet-catalog-warn sheet-catalog-warn--row">
          <span>試算表上還沒有「放進LINE目錄」這一欄：加一欄，在要放進目錄的商品打勾。</span>
          <AdminFieldHelp id="productSheetFormat" />
        </div>

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
              <span v-if="g.key === 'rename'" class="sheet-catalog-meta">試算表上找不到了，同時多了{{ (p.renameCandidates ?? []).map(c => `「${c.title}」`).join('、') }}——是同一個商品改了名字嗎？</span>
              <span v-else-if="g.key === 'missing'" class="sheet-catalog-meta">試算表上找不到了，AI 也答不出它</span>
              <span v-else class="sheet-catalog-meta">
                <template v-if="p.image">{{ p.image.source === 'own' ? '自己換的圖' : '商品頁封面圖' }}</template>
                <template v-else>{{ sheetCoverStatusText(p) }}</template>
                <template v-if="p.tag">・點了貼「{{ p.tag.name }}」</template>
              </span>
              <!--
                `C-438`：試算表上找不到的商品，店家自己決定（規格 §5.2）——是改名就接到新的名字（圖、標籤跟著走），
                不賣了就拿掉（不再提醒）。還要留著讓 AI 回答的，到試算表把那一列加回來，這裡不用按。
                `C-449`：按鈕放在名字下面一排——以前放右邊、按鈕上寫整串新名字，把商品名擠成一行四五個字。
                新名字已經寫在上面那句；只有一個候選就叫「是，改名了」，好幾個才在按鈕上寫是哪一個。
              -->
              <div v-if="canEdit && (g.key === 'rename' || g.key === 'missing')" class="sheet-catalog-decide">
                <el-button
                  v-for="c in (p.renameCandidates ?? []).slice(0, 3)"
                  :key="c.id"
                  size="small"
                  type="primary"
                  plain
                  :loading="busyId === p.id"
                  @click="confirmRename(p, c)"
                >
                  {{ (p.renameCandidates ?? []).length > 1 ? `是，改成「${c.title}」` : '是，改名了' }}
                </el-button>
                <el-button size="small" :disabled="busyId === p.id" @click="retire(p)">不賣了，拿掉</el-button>
              </div>
            </div>
            <div v-if="canEdit && g.key !== 'rename' && g.key !== 'missing'" class="sheet-catalog-actions">
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
import { ElMessageBox } from 'element-plus'
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

/**
 * 分組照「他要做什麼」排：要處理的在上面，不用管的收起來。
 * `C-449`：四組的名字跟提醒中心、模組清單最上面那一塊同一個字（目錄放不下／還沒有圖／試算表上找不到了／是改名嗎？），
 * 以前三個地方三種講法（「沒放上去」「抓不到圖」「少了」）。
 */
const openGroups = computed(() => [
  {
    // `C-438`：名字和商品頁網址一起換了，系統不猜——最上面問
    key: 'rename',
    title: '是改名嗎？',
    hint: '確認之前，目錄和回覆照用上一次讀到的內容',
    items: products.value.filter(p => p.placement === 'missing' && p.renameCandidates?.length),
  },
  {
    key: 'overflow',
    title: '目錄放不下',
    hint: `只放得下 ${props.view?.max ?? 10} 個：到試算表取消勾選，或把要放的往前排`,
    items: products.value.filter(p => p.placement === 'overflow'),
  },
  {
    key: 'noImage',
    title: '還沒有圖',
    hint: '先不放進目錄',
    items: products.value.filter(p => p.placement === 'noImage'),
  },
  {
    // `C-438`：以前收在下面——現在有提醒帶人來這裡，收著就找不到
    key: 'missing',
    title: '試算表上找不到了',
    hint: '還要讓客人問得到，把那一列加回試算表、不要勾「放進LINE目錄」；不要了就按「不賣了，拿掉」',
    items: products.value.filter(p => p.placement === 'missing' && !p.renameCandidates?.length),
  },
  { key: 'card', title: '在目錄上', hint: '', items: cards.value },
].filter(g => g.items.length))

const foldedGroups = computed(() => [
  { key: 'off', title: '不在目錄上的商品', items: products.value.filter(p => p.placement === 'off') },
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

// ── `C-438`：試算表上找不到的商品 ──
async function decide(p: SheetCatalogViewProduct, body: Record<string, unknown>, done: string) {
  busyId.value = p.id
  try {
    await apiFetch('/api/flow/create?part=sheet-product-decision', { method: 'POST', body: { sourceId: props.sourceId, productId: p.id, ...body } })
    showToast(done, 'success')
    emit('changed')
  }
  catch (err: any) {
    showToast(err?.data?.statusMessage || '沒改成，請再試一次', 'error')
  }
  finally {
    busyId.value = ''
  }
}

function confirmRename(p: SheetCatalogViewProduct, c: { id: string, title: string }) {
  void decide(p, { action: 'rename', newId: c.id }, `接上了：「${p.title}」改名成「${c.title}」，圖和標籤照舊`)
}

async function retire(p: SheetCatalogViewProduct) {
  try {
    await ElMessageBox.confirm(
      `「${p.title}」會從商品目錄拿掉、不再提醒。之後試算表又加回這一列，會當成新的商品（封面圖重新抓）。`,
      '不賣了，拿掉？',
      { confirmButtonText: '拿掉', cancelButtonText: '取消', type: 'warning' },
    )
  }
  catch {
    return
  }
  await decide(p, { action: 'retire' }, `「${p.title}」拿掉了`)
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
