<template>
  <AdminSplitLayout :is-empty="!selectedMenu && !isCreating">
    <template #sidebar-header>
      <span class="split-sidebar-title" data-tour="rm-title">圖文選單<AdminPageHelpButton :topics="['richmenu']" /></span>
      <el-button :icon="Plus" type="primary" size="small" data-tour="rm-new" @click="openCreate">新增</el-button>
    </template>

    <template #sidebar-list>
      <div v-if="loading && !menus.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!menus.length" class="split-sidebar-empty">
        <span>尚無圖文選單</span>
        <el-button size="small" type="primary" plain @click="openCreate">立即新增</el-button>
      </div>
      <div v-else ref="listEl" class="split-list" data-tour="rm-list" @scroll.passive="onSidebarListScroll">
        <AdminSplitListItem
          v-for="menu in sortedMenus"
          :key="menu.id"
          :title="menu.name"
          :active="selectedId === menu.id"
          time-in-title-row
          title-row-chip
          :chip-text="menu.isDefault ? '預設' : ''"
          chip-tone="success"
          :meta-text="`${menu.areas?.length ?? 0} 個區塊`"
          @select="selectMenu(menu)"
        />

        <div v-if="loadingMore" class="admin-sidebar-load-more">
          <div class="spinner" />
          <span>載入更多…</span>
        </div>
      </div>
    </template>

    <template #editor-empty>
      <el-icon class="empty-icon"><Grid /></el-icon>
      <h3>選擇一個圖文選單開始編輯</h3>
      <p>或點擊左側「新增」建立新的圖文選單</p>
      <div class="empty-actions">
        <el-button type="primary" @click="openCreate">新增圖文選單</el-button>
        <AdminPageHelpButton :topics="['richmenu']" label="第一次用？看一遍怎麼做" />
      </div>
    </template>

    <template #editor-header>
      <AdminEditorHeaderTitle
        v-model="form.name"
        field-label="選單名稱"
        create-prefix="新增圖文選單:"
        placeholder="請輸入選單名稱..."
        :caption="`版型：${form.layoutId} · 區塊 ${form.areas.length} 個`"
        :is-creating="isCreating"
      />
      <div class="flex gap-1 admin-header-actions">
        <el-button v-if="!isCreating && selectedMenu" :icon="Delete" type="danger" @click="deleteMenu">
          刪除
        </el-button>
        <el-button @click="cancelEdit">取消</el-button>
        <el-button type="primary" :loading="creating" data-tour="rm-save" @click="submitForm">
          {{ isCreating ? '建立圖文選單' : '儲存變更' }}
        </el-button>
      </div>
    </template>

    <template #editor-body>
      <el-form label-position="top" class="admin-form-vertical rm-editor-body" @submit.prevent>
        <div class="message-card rm-config-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">選單設定</span>
            </div>
          </div>
          <div class="card-section-stack rm-config-grid">
            <!-- 左欄：要填的東西（欄位不被寬螢幕拉成滿版） -->
            <div class="rm-config-col rm-config-col--fields">
              <div class="admin-field-group" data-tour="rm-chatbar">
                <AdminFieldLabel text="Chat Bar 文字" tight />
                <el-input v-model="form.chatBarText" placeholder="選單" />
              </div>

              <div class="admin-field-group">
                <AdminFieldLabel text="啟用" tight />
                <div class="admin-inline-control">
                  <el-switch v-model="form.selected" />
                  <span class="text-xs text-muted">{{ form.selected ? '啟用中' : '停用中' }}</span>
                </div>
              </div>

              <div class="admin-field-group" data-tour="rm-default">
                <AdminFieldLabel text="設為預設選單" tight />
                <div class="admin-inline-control">
                  <el-switch v-model="form.setAsDefault" />
                  <span class="text-xs text-muted">{{ form.setAsDefault ? '新加入好友預設顯示此選單' : '不設為預設選單' }}</span>
                </div>
              </div>

              <div class="admin-field-group" data-tour="rm-image">
                <AdminFieldLabel :text="`1. 上傳選單背景圖 (${isCreating ? '必要' : '選填，若不上傳則自動沿用舊圖'})`" tight />
                <FlowUploadZone
                  v-model="form.previewUrl"
                  type="image"
                  appearance="simple"
                  upload-mode="local"
                  hint="JPG / PNG · 最大 500KB（建議 2500x1686 或 2500x843）"
                  @file-selected="onRichMenuImageSelected"
                />
              </div>
            </div>

            <!-- 右欄：要看的東西（版型與預覽吃掉剩下的寬度） -->
            <div class="rm-config-col rm-config-col--visual">
              <div class="rm-layout-in-card admin-field-group" data-tour="rm-layout">
                <AdminLayoutPresetPicker
                  flat
                  title="圖文樣式"
                  :layouts="richMenuLayoutPresets"
                  :selected-id="form.layoutId"
                  @select="onSelectRichMenuLayout"
                />
              </div>

              <AdminAreaEditorSection
                v-if="form.previewUrl"
                :areas="form.areas"
                section-label="區塊預覽"
                :flat="true"
                :show-canvas="true"
                :show-action-cards="false"
                :show-header="true"
                :show-add-button="false"
                :allow-remove="false"
                :show-bounds="false"
                :min-bounds-size="0"
                :base-width="Number(form.width) || 2500"
                :base-height="Number(form.height) || 843"
                :area-colors="areaColors"
                :drag-area-index="dragState?.areaIndex ?? null"
                :overlap-set="overlapSet"
                :guide-lines="guideLines"
                :canvas-style="richMenuCanvasStyle"
                :canvas-image-url="form.previewUrl || undefined"
                :set-canvas-ref="setRichMenuCanvasRef"
                @start-drag="startDrag"
                @start-resize="startResize"
                @clamp="clampAreaByIndex"
              />
              <p v-else class="rm-preview-placeholder">
                可先選版型。上傳背景圖後，這裡會顯示可拖曳的區塊預覽。
              </p>
            </div>
          </div>
        </div>

        <!-- Areas Editor (only visible if image uploaded) -->
        <div v-if="form.previewUrl" class="message-card rm-area-editor">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">2. 區塊設定</span>
            </div>
            <span class="text-xs text-muted">共 {{ form.areas.length }} 個區塊 · 設定點下去要做什麼</span>
          </div>
          <div class="card-section-stack">
            <!--
              壞掉的區塊要在畫面上講（D-33 P0-4）。以前這件事只有兩個地方看得到：
              右下角小幫手的紅色異常，和「按了儲存」才擋——而客人早就在按那顆按鈕了。
              ⚠️三態：查不到模組清單時講「沒辦法幫你檢查」，⛔不可以當成沒問題。
            -->
            <AdminBlockStatus
              v-if="modulesLoadFailed"
              tone="unknown"
              title="這次沒能載入模組清單，沒辦法幫你檢查按鈕指向哪裡"
              detail="重新整理可以再試一次。這不代表沒問題，也不代表有問題。"
            />
            <AdminBlockStatus
              v-else-if="brokenAreas.length"
              tone="critical"
              :title="`有 ${brokenAreas.length} 個區塊按下去，客人收不到任何訊息`"
              :detail="brokenAreasDetail"
            />

            <AdminAreaEditorSection
              :areas="form.areas"
              section-label="區塊設定"
              :flat="true"
              :show-canvas="false"
              :show-action-cards="true"
              :show-header="false"
              :show-add-button="form.layoutId === 'custom'"
              :allow-remove="form.layoutId === 'custom'"
              :show-bounds="form.layoutId === 'custom'"
              :min-bounds-size="0"
              :base-width="Number(form.width) || 2500"
              :base-height="Number(form.height) || 843"
              :area-colors="areaColors"
              :drag-area-index="dragState?.areaIndex ?? null"
              :overlap-set="overlapSet"
              :guide-lines="guideLines"
              :canvas-style="{}"
              :set-canvas-ref="setRichMenuCanvasRef"
              @add="addArea"
              @remove="removeArea"
              @start-drag="startDrag"
              @start-resize="startResize"
              @clamp="clampAreaByIndex"
            >
              <!-- 那一格自己也要標出來：上面的狀態列講「有幾個」，這裡講「是這一格」 -->
              <template #action-error="{ index }">
                <AdminBlockStatus
                  v-if="brokenAreaTitle(index)"
                  tone="critical"
                  :title="brokenAreaTitle(index)"
                  detail="客人按下去收不到任何訊息，也不會看到錯誤提示。重新選一個模組再儲存。"
                />
              </template>
              <template #action-fields="{ area }">
                <AdminAreaActionEditor
                  :model-value="area.action"
                  :module-options="modules"
                  :tag-options="allTags"
                  :enable-tagging="true"
                  :taggable-action-types="['module', 'message', 'switch']"
                  :menu-options="menus"
                  :allow-switch="true"
                  :exclude-menu-id="selectedId"
                  @update:model-value="(next) => { area.action = next }"
                />
              </template>
            </AdminAreaEditorSection>
          </div>
        </div>
      </el-form>
    </template>
  </AdminSplitLayout>

</template>

<script setup lang="ts">
import { Delete, Grid, Plus } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import {
  IMAGE_MAX_BYTES,
} from '~~/shared/upload-rules'
import {
  decodeTriggerModule,
  encodeTriggerMessage,
  encodeSwitchMenu,
  parseTriggerMessageData,
  parseTriggerModuleData,
  parseSwitchMenuData,
  encodeTriggerModule,
  validateUnifiedAction,
} from '~~/shared/action-schema'
import {
  RICH_LAYOUT_PRESETS,
  createPresetBounds,
  type RichLayoutId,
} from '~~/shared/rich-layout-presets'

definePageMeta({ middleware: 'auth', layout: 'default' })

const { apiFetch } = useWorkspace()

const { markClean, confirmLeaveIfDirty } = useUnsavedChanges({
  getSnapshot: () => form.value,
})

type LocalSelectedFile = {
  file: File
  dataUrl: string
  objectUrl: string
  contentType: string
  width?: number
  height?: number
}

// ── Data ──────────────────────────────────────────────────────
const {
  items: menus,
  loading,
  loadingMore,
  listEl,
  load: loadMenusList,
  onScroll: onSidebarListScroll,
} = useWorkspaceSidebarList<any>('/api/richmenu/list')
const selectedId = ref<string | null>(null)
const isCreating = ref(false)
const creating = ref(false)
const { showToast } = useAdminToast()
const { tags: allTags, loadTags } = useAdminTagList()
const selectedMenu = computed(() => menus.value.find((menu) => menu.id === selectedId.value) ?? null)

const sortedMenus = computed(() => {
  return [...menus.value].sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return 0;
  });
})

// ── Canvas drag / resize ──────────────────────────────────────
const canvasRef = ref<HTMLElement | null>(null)

const areaColors = [
  'rgba(6,199,85,0.6)',
  'rgba(59,130,246,0.6)',
  'rgba(245,158,11,0.6)',
  'rgba(239,68,68,0.6)',
  'rgba(168,85,247,0.6)',
  'rgba(236,72,153,0.6)',
]

const defaultForm = () => ({
  name: '',
  chatBarText: '選單',
  layoutId: 'custom' as RichLayoutId,
  width: 0,
  height: 0,
  imageBase64: '',
  contentType: '',
  previewUrl: '',
  selected: true,
  setAsDefault: false,
  areas: [] as any[],
})
const form = ref(defaultForm())
const richMenuAreas = computed(() => form.value.areas as any[])

/**
 * 指向已刪除／已停用模組的區塊（D-33 P0-4）。
 *
 * 判定跟後端 `findBrokenModuleRefs` 同一把尺（模組不在清單＝missing、`isActive === false`＝
 * inactive），這樣畫面上標紅的那幾格，就是小幫手那顆紅色異常算的那幾格——⛔兩邊口徑不同
 * 就會變成「小幫手說有問題、頁面上每一格都正常」。
 */
interface BrokenArea { index: number, reason: 'missing' | 'inactive' }

const brokenAreas = computed<BrokenArea[]>(() => {
  if (modulesLoadFailed.value)
    return []
  const byId = new Map<string, any>(modules.value.map((m: any) => [String(m.id), m]))
  const out: BrokenArea[] = []
  richMenuAreas.value.forEach((area: any, index: number) => {
    if (area?.action?.type !== 'module')
      return
    const id = String(area.action.moduleId || '')
    // 還沒選模組不算壞掉（那是「還沒設完」，存檔時本來就會擋）
    if (!id)
      return
    const target = byId.get(id)
    if (!target)
      out.push({ index, reason: 'missing' })
    else if (target.isActive === false)
      out.push({ index, reason: 'inactive' })
  })
  return out
})

const brokenAreaByIndex = computed(() => new Map(brokenAreas.value.map(b => [b.index, b])))

/** 那一格自己的標題（空字串＝這一格沒事）。⛔用函式不用 map.get()!——Vue 模板不吃 TS 的 `!` */
function brokenAreaTitle(index: number): string {
  const hit = brokenAreaByIndex.value.get(index)
  if (!hit)
    return ''
  return hit.reason === 'missing' ? '這一格指向的模組已經被刪除' : '這一格指向的模組已經停用'
}

/** 講「是哪幾格」用區塊編號（畫面上每張卡的標題就是「區塊 N」，對得起來） */
const brokenAreasDetail = computed(() => {
  const nums = brokenAreas.value.map(b => `區塊 ${b.index + 1}`).join('、')
  return `${nums}——往下捲會看到那幾格被標紅。重新選一個還在的模組再儲存。`
})

const {
  dragState,
  guideLines,
  overlapSet,
  clampArea: clampAreaByIndex,
  clampAllAreas: clampAllAreasByEditor,
  startDrag: startAreaDrag,
  startResize: startAreaResize,
  stopDrag,
  bindWindowListeners,
  unbindWindowListeners,
} = useAreaEditor<any>({
  areas: richMenuAreas,
  canvasRef,
  canvasWidth: () => Number(form.value.width) || 2500,
  canvasHeight: () => Number(form.value.height) || 843,
  minSize: 80,
  snapPx: 8,
  enableSnap: true,
  getBounds: (area) => area.bounds,
  setBounds: (area, bounds) => {
    area.bounds = bounds
  },
})

const richMenuCanvasStyle = computed(() => {
  const w = Math.max(1, Number(form.value.width) || 2500)
  const h = Math.max(1, Number(form.value.height) || 843)
  const d = dragState.value
  return {
    aspectRatio: `${w} / ${h}`,
    width: '100%',
    minHeight: '120px',
    userSelect: d ? 'none' : 'auto',
    cursor: d?.type === 'move' ? 'grabbing' : 'default',
  }
})

function setRichMenuCanvasRef(el: HTMLElement | null) {
  canvasRef.value = el
}

const modules = ref<any[]>([])
/**
 * 模組清單這次載到了沒有（D-33 P0-4）。
 *
 * ⛔ 一定要有這個旗標：壞掉的判斷是「這個 moduleId 不在清單裡」，載入失敗時清單是空的，
 * 直接判會把每一格都標成壞掉（假警報），或反過來寫成「查不到就算沒事」（假綠燈）。
 * 兩種都比不檢查更糟，所以第三態要現形。
 */
const modulesLoadFailed = ref(false)
const richMenuLayoutPresets = RICH_LAYOUT_PRESETS
const fixedLayoutIds = richMenuLayoutPresets
  .map((layout) => layout.id)
  .filter((id): id is Exclude<RichLayoutId, 'custom'> => id !== 'custom')

function getMenuWidth() {
  return Number(form.value.width) || 2500
}

function getMenuHeight() {
  return Number(form.value.height) || 843
}

function detectLayoutByAreas(areas: any[], width: number, height: number): RichLayoutId {
  if (!Array.isArray(areas) || areas.length === 0) return 'custom'
  const tolerance = 3
  for (const layoutId of fixedLayoutIds) {
    const preset = createPresetBounds(layoutId, width, height)
    if (preset.length !== areas.length) continue
    const matched = preset.every((expected, idx) => {
      const actual = areas[idx]?.bounds
      if (!actual) return false
      return Math.abs((actual.x ?? 0) - expected.x) <= tolerance
        && Math.abs((actual.y ?? 0) - expected.y) <= tolerance
        && Math.abs((actual.width ?? 0) - expected.width) <= tolerance
        && Math.abs((actual.height ?? 0) - expected.height) <= tolerance
    })
    if (matched) return layoutId
  }
  return 'custom'
}

function applyRichMenuLayout(layoutId: RichLayoutId) {
  form.value.layoutId = layoutId
  if (layoutId === 'custom') {
    if (form.value.areas.length === 0) addArea()
    return
  }
  const width = getMenuWidth()
  const height = getMenuHeight()
  const boundsList = createPresetBounds(layoutId, width, height)
  const nextAreas = boundsList.map((bounds, index) => ({
    bounds,
    action: form.value.areas[index]?.action
      ? { ...form.value.areas[index].action }
      : { type: 'module', moduleId: '', tagging: { enabled: false, addTagIds: [] } },
  }))
  form.value.areas = nextAreas
}

function onSelectRichMenuLayout(layoutId: string) {
  applyRichMenuLayout(layoutId as RichLayoutId)
}

/** LINE 與 upload-validator 僅接受 jpeg / png；沿用原始檔位元組，避免 canvas 轉 PNG 暴肥導致儲存失敗 */
function normalizeRichMenuImageContentType(mime: string): string {
  const t = (mime || '').trim().toLowerCase()
  return t === 'image/png' ? 'image/png' : 'image/jpeg'
}

// ── Fetch ─────────────────────────────────────────────────────
async function loadMenus() {
  try {
    const [_, modulesData, tagOk] = await Promise.all([
      loadMenusList(true),
      apiFetch<any[]>('/api/flow/list'),
      loadTags({ status: 'active' }),
    ])
    modules.value = modulesData ?? []
    modulesLoadFailed.value = false
    if (!tagOk) showToast('載入標籤失敗', 'error')
  }
  catch {
    modules.value = []
    // ⛔別只清空就算了：空清單會讓「按鈕指向的模組還在嗎」這個檢查全部誤判
    modulesLoadFailed.value = true
    showToast('載入圖文選單失敗', 'error')
  }
}
onMounted(() => {
  loadMenus()
  bindWindowListeners()
})
onBeforeUnmount(() => {
  unbindWindowListeners()
})

// ── Select / Create ───────────────────────────────────────────
function openCreate() {
  if (!confirmLeaveIfDirty()) return
  selectedId.value = null
  isCreating.value = true
  form.value = defaultForm()
  markClean()
}

function buildFormFromMenu(menu: any) {
  const normalizedAreas = JSON.parse(JSON.stringify(menu.areas || [])).map((a: any) => {
    const data = String(a?.action?.data || '')
    if (a.action.type === 'postback' && data.startsWith('switchMenu=')) {
      const parsed = parseSwitchMenuData(data)
      const targetMenuId = parsed.targetMenuId || data.replace('switchMenu=', '').split('&')[0]
      return {
        ...a,
        action: {
          type: 'switch',
          data: `switchMenu=${targetMenuId}`,
          tagging: {
            enabled: parsed.tagIds.length > 0,
            addTagIds: parsed.tagIds,
          },
        },
      }
    }
    if (a.action.type === 'postback' && decodeTriggerModule(data)) {
      const parsed = parseTriggerModuleData(data)
      return {
        ...a,
        action: {
          type: 'module',
          moduleId: parsed.moduleId,
          tagging: {
            enabled: parsed.tagIds.length > 0,
            addTagIds: parsed.tagIds,
          },
        },
      }
    }
    if (a.action.type === 'postback' && parseTriggerMessageData(data).text) {
      const parsed = parseTriggerMessageData(data)
      return {
        ...a,
        action: {
          type: 'message',
          text: parsed.text,
          tagging: {
            enabled: parsed.tagIds.length > 0,
            addTagIds: parsed.tagIds,
          },
        },
      }
    }
    if (a.action.type === 'postback') {
      return { ...a, action: { type: 'module', moduleId: '', tagging: { enabled: false, addTagIds: [] } } }
    }
    if (a.action.type === 'richmenuswitch') {
      const richMenuAliasId: string = a.action.richMenuAliasId ?? ''
      const targetMenu = menus.value.find(m => m.aliasId === richMenuAliasId)
      const parsed = parseSwitchMenuData(String(a.action.data || ''))
      const targetFirestoreId = targetMenu?.id ?? parsed.targetMenuId ?? ''
      return {
        ...a,
        action: {
          type: 'switch',
          data: `switchMenu=${targetFirestoreId}`,
          tagging: {
            enabled: parsed.tagIds.length > 0,
            addTagIds: parsed.tagIds,
          },
        },
      }
    }
    return a
  })
  const width = menu.size?.width || 2500
  const height = menu.size?.height || 843
  return {
    name: menu.name || '',
    chatBarText: menu.chatBarText || '選單',
    layoutId: detectLayoutByAreas(normalizedAreas, width, height),
    width,
    height,
    imageBase64: '',
    contentType: '',
    previewUrl: menu.imageUrl || '',
    selected: typeof menu.selected === 'boolean' ? menu.selected : true,
    setAsDefault: menu.isDefault || false,
    areas: normalizedAreas,
  }
}

function selectMenu(menu: any, opts?: { skipDiscardConfirm?: boolean }) {
  if (!opts?.skipDiscardConfirm && !confirmLeaveIfDirty()) return
  selectedId.value = menu.id
  isCreating.value = false
  form.value = buildFormFromMenu(menu)
  markClean()
}

function cancelEdit() {
  if (!confirmLeaveIfDirty()) return
  if (selectedMenu.value) {
    const current = selectedMenu.value
    selectedId.value = current.id
    isCreating.value = false
    form.value = buildFormFromMenu(current)
    markClean()
    return
  }
  isCreating.value = false
  selectedId.value = null
  form.value = defaultForm()
  markClean()
}

async function onRichMenuImageSelected(payload: LocalSelectedFile) {
  if (payload.file.size > IMAGE_MAX_BYTES) {
    showToast('圖片不能超過 500KB', 'error')
    return
  }
  const W = Number(payload.width || 0)
  const H = Number(payload.height || 0)
  if (!W || !H) {
    showToast('圖片處理失敗，請重試', 'error')
    return
  }
  if (W < 800 || W > 2500 || H < 250 || (W / H) < 1.45) {
    showToast(`尺寸不符規範 (W:800~2500, H>=250, W/H>=1.45)。目前：${W}x${H}`, 'error')
    return
  }

  form.value.width = W
  form.value.height = H
  form.value.previewUrl = payload.objectUrl
  applyRichMenuLayout(form.value.layoutId)

  const comma = payload.dataUrl.indexOf(',')
  form.value.imageBase64 = comma >= 0 ? payload.dataUrl.slice(comma + 1) : payload.dataUrl
  form.value.contentType = normalizeRichMenuImageContentType(
    payload.contentType || payload.file.type,
  )
}

function addArea() {
  if (form.value.layoutId !== 'custom') {
    showToast('預設版型不可手動新增，請切換為「自訂區域」', 'error')
    return
  }
  if (form.value.areas.length >= 6) {
    showToast('區塊最多 6 個', 'error')
    return
  }
  const W = Number(form.value.width) || 2500
  const H = Number(form.value.height) || 843
  form.value.areas.push({
    bounds: { x: 0, y: 0, width: Math.floor(W / 3), height: H },
    action: { type: 'module', moduleId: '', tagging: { enabled: false, addTagIds: [] } },
  })
}

function removeArea(i: number) {
  if (form.value.layoutId !== 'custom') {
    showToast('預設版型不可手動移除，請切換為「自訂區域」', 'error')
    return
  }
  if (form.value.areas.length <= 1) {
    showToast('至少需保留 1 個區塊', 'error')
    return
  }
  form.value.areas.splice(i, 1)
}

function clampAllAreas() {
  if (form.value.width < 100) form.value.width = 100
  if (form.value.height < 100) form.value.height = 100
  clampAllAreasByEditor()
}

function startDrag(e: MouseEvent, index: number) {
  e.preventDefault()
  startAreaDrag(e, index)
}

function startResize(e: MouseEvent, index: number, handle: string) {
  e.preventDefault()
  startAreaResize(e, index, handle)
}

watch([isCreating, selectedId], ([creatingNow, currentId]) => {
  if (!creatingNow && !currentId) stopDrag()
})

async function submitForm() {
  if (!form.value.previewUrl) return showToast('請先上傳圖片', 'error')
  if (!form.value.name || !form.value.areas.length) return showToast('請填寫名稱並新增至少一個區塊', 'error')
  if (form.value.areas.length > 6) return showToast('區塊最多 6 個', 'error')
  if (overlapSet.value.size > 0) return showToast('區塊有重疊，請調整後再部署', 'error')

  const W = Number(form.value.width) || 2500
  const H = Number(form.value.height) || 843
  const isOutOfBounds = form.value.areas.some(a =>
    a.bounds.x < 0 || a.bounds.y < 0 ||
    (a.bounds.x + a.bounds.width) > W ||
    (a.bounds.y + a.bounds.height) > H
  )
  if (isOutOfBounds) {
    clampAllAreas()
    return showToast('發現超出邊界的區塊，已自動為您修正！請重新確認後再送出', 'error')
  }

  for (const [index, area] of form.value.areas.entries()) {
    const actionType = area?.action?.type
    if (actionType === 'switch') {
      if (!area?.action?.data) return showToast(`區塊 ${index + 1}：請選擇要切換的選單`, 'error')
      if (area?.action?.tagging?.enabled === true && (!Array.isArray(area?.action?.tagging?.addTagIds) || area.action.tagging.addTagIds.length === 0)) {
        return showToast(`區塊 ${index + 1}：已啟用貼標，請至少選擇一個標籤`, 'error')
      }
      continue
    }
    const err = validateUnifiedAction({
      slot: String(index + 1),
      type: actionType === 'message' || actionType === 'module' ? actionType : 'uri',
      uri: area?.action?.uri || '',
      text: area?.action?.text || '',
      moduleId: area?.action?.moduleId || '',
      tagging: {
        enabled: area?.action?.tagging?.enabled === true,
        addTagIds: Array.isArray(area?.action?.tagging?.addTagIds) ? area.action.tagging.addTagIds : [],
      },
    })
    if (err) return showToast(`區塊 ${index + 1}：${err}`, 'error')
  }

  const apiAreas = form.value.areas.map(a => {
    if (a.action.type === 'module') {
      const tagIds = a?.action?.tagging?.enabled
        ? (Array.isArray(a.action.tagging.addTagIds) ? a.action.tagging.addTagIds : [])
        : []
      return { ...a, action: { type: 'postback', data: encodeTriggerModule(a.action.moduleId, tagIds) } }
    }
    if (a.action.type === 'message') {
      const tagIds = a?.action?.tagging?.enabled
        ? (Array.isArray(a.action.tagging.addTagIds) ? a.action.tagging.addTagIds : [])
        : []
      if (tagIds.length > 0) {
        return {
          ...a,
          action: {
            type: 'postback',
            data: encodeTriggerMessage(String(a.action.text || ' ').slice(0, 300), tagIds),
            displayText: String(a.action.text || ' ').slice(0, 300),
          },
        }
      }
    }
    if (a.action.type === 'switch' || a.action.type === 'richmenuswitch') {
      const switchParsed = parseSwitchMenuData(String(a.action.data || ''))
      const targetFirestoreId = switchParsed.targetMenuId
      const targetMenu = menus.value.find(m => m.id === targetFirestoreId)
      if (!targetMenu) {
        throw new Error(`切換選單目標「${targetFirestoreId}」已不存在，請重新選擇目標選單再儲存`)
      }
      if (!targetMenu.aliasId) {
        throw new Error(`目標選單「${targetMenu.name}」尚未建立快速切換別名，請先上傳圖片再試一次`)
      }
      const tagIds = a?.action?.tagging?.enabled
        ? (Array.isArray(a.action.tagging.addTagIds) ? a.action.tagging.addTagIds : [])
        : []
      return {
        ...a,
        action: {
          type: 'richmenuswitch',
          richMenuAliasId: targetMenu.aliasId,
          data: encodeSwitchMenu(targetFirestoreId, tagIds),
        },
      }
    }
    return a
  })

  // 建立＝第一次上線到 LINE，會立即對所有好友生效 → 部署前確認一次
  if (isCreating.value) {
    try {
      await ElMessageBox.confirm(
        '建立後會立即部署到 LINE，所有好友的圖文選單會即時更新。確定要部署嗎？',
        '確認部署',
        { confirmButtonText: '建立並部署', cancelButtonText: '再檢查一下', type: 'warning' },
      )
    }
    catch { return }
  }

  creating.value = true
  let createdFirestoreId = ''
  try {
    if (!isCreating.value && selectedId.value) {
      await apiFetch(`/api/richmenu/${selectedId.value}`, {
        method: 'PUT',
        body: {
          name: form.value.name,
          chatBarText: form.value.chatBarText,
          size: { width: form.value.width, height: form.value.height },
          selected: form.value.selected,
          areas: apiAreas,
          setAsDefault: form.value.setAsDefault,
          imageBase64: form.value.imageBase64,
          contentType: form.value.contentType,
        },
      })
      showToast('圖文選單已成功更新', 'success')
    } else {
      const docResponse = await apiFetch<any>('/api/richmenu/create', {
        method: 'POST',
        body: {
          name: form.value.name,
          chatBarText: form.value.chatBarText,
          size: { width: form.value.width, height: form.value.height },
          selected: form.value.selected,
          areas: apiAreas,
          setAsDefault: form.value.setAsDefault,
        },
      })
      createdFirestoreId = String(docResponse?.id || '')

      await apiFetch('/api/richmenu/upload', {
        method: 'POST',
        body: {
          richMenuId: docResponse.richMenuId,
          firestoreId: docResponse.id,
          imageBase64: form.value.imageBase64,
          contentType: form.value.contentType,
        },
      })
      showToast('圖文選單已成功建立與部署', 'success')
    }

    await loadMenusList(true)
    if (isCreating.value) {
      isCreating.value = false
      const latest = menus.value.find((menu) => menu.id === createdFirestoreId) ?? menus.value[0]
      if (latest) selectMenu(latest, { skipDiscardConfirm: true })
    } else if (selectedId.value) {
      const next = menus.value.find((menu) => menu.id === selectedId.value)
      if (next) selectMenu(next, { skipDiscardConfirm: true })
    }
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage ?? e?.message ?? '建立失敗', 'error')
  }
  finally {
    creating.value = false
  }
}

async function setAsDefault(menu: any) {
  try {
    await apiFetch('/api/richmenu/setDefault', {
      method: 'POST',
      body: { richMenuId: menu.richMenuId, firestoreId: menu.id },
    })
    showToast('已設為預設選單', 'success')
    await loadMenusList(true)
  }
  catch {
    showToast('設定失敗', 'error')
  }
}

async function deleteMenu() {
  if (!selectedId.value) return
  const menuName = form.value.name
  try {
    await ElMessageBox.confirm(`確定刪除「${menuName}」？此動作無法復原。`, '刪除確認', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/richmenu/${selectedId.value}`, { method: 'DELETE' })
    showToast('已刪除', 'success')
    selectedId.value = null
    isCreating.value = false
    form.value = defaultForm()
    markClean()
    await loadMenusList(true)
  }
  catch {
    showToast('刪除失敗', 'error')
  }
}

function getActionLabel(action: any) {
  if (!action) return '—'
  return action.text ?? action.uri ?? action.data ?? action.richMenuAliasId ?? '—'
}
</script>
