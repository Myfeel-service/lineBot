<template>
  <div
    class="split-layout"
    :class="{
      'split-layout--solo': solo,
      'split-layout--readonly': isViewer,
      'split-layout--stack': mobileStack,
      'split-layout--picked': !isEmpty,
    }"
  >
    <!-- ── Left Sidebar ─────────────────────────────── -->
    <aside v-if="!solo" class="split-sidebar" :style="{ width: sidebarWidth + 'px' }">
      <div class="split-sidebar-header">
        <slot name="sidebar-header" />
      </div>

      <!-- Scrollable list container -->
      <div class="split-list-container">
        <slot name="sidebar-list" />
      </div>
    </aside>

    <!-- ── Resize Handle ────────────────────────────── -->
    <div
      v-if="!solo"
      class="split-resizer"
      :class="{ 'is-active': isResizing }"
      role="separator"
      aria-orientation="vertical"
      aria-label="調整側欄寬度"
      title="拖曳調整寬度，雙擊還原"
      @pointerdown="startResize"
      @dblclick="resetWidth"
    />

    <!-- ── Right Editor ───────────────────────────── -->
    <main class="split-editor">
      <div v-if="isEmpty" class="split-empty-state">
        <slot name="editor-empty" />
      </div>

      <div v-else class="split-editor-inner">
        <!-- 手機一次只看一邊（mobileStack）：點進來之後要有路回清單，電腦版這顆是 display:none -->
        <button v-if="mobileStack" type="button" class="split-mobile-back" @click="emit('mobileBack')">
          <el-icon><ArrowLeft /></el-icon>{{ mobileBackLabel }}
        </button>

        <!-- Editor Header -->
        <div class="split-editor-header">
          <slot name="editor-header" />
        </div>

        <!-- Editor Body -->
        <div class="split-editor-body">
          <slot name="editor-body" />
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft } from '@element-plus/icons-vue'

// 唯讀樣式是「觀察者模式」這個身分的外觀（跟頂端那條觀察者提示同一件事），不是某個功能的權限——
// 所以看角色本身，不走 can()（`G-109`）。哪一顆按鈕能不能按，由各頁照那顆按鈕的能力決定。
const { isViewer } = useWorkspace()

const props = defineProps({
  /** 隱藏左側欄，右側編輯區全寬（標籤／好友等列表頁與 split-editor 視覺一致） */
  solo: {
    type: Boolean,
    default: false,
  },
  isEmpty: {
    type: Boolean,
    default: false,
  },
  /** localStorage 鍵：不同頁可各自記住側欄寬度，預設共用一個 */
  storageKey: {
    type: String,
    default: 'admin-split-sidebar-width',
  },
  /**
   * 手機上一次只看一邊（`E-13` 第一步，2026-10-12 知識庫先接）：沒選東西看清單、選了看內容，
   * 內容上面多一顆回清單。⛔ 要頁面自己接 `mobileBack`（把選取清掉），所以是一頁一頁打開、不是預設：
   * 沒接的頁打開它＝手機上點進去就回不來。
   */
  mobileStack: {
    type: Boolean,
    default: false,
  },
  mobileBackLabel: {
    type: String,
    default: '回清單',
  },
})

const emit = defineEmits<{ mobileBack: [] }>()

const MIN_WIDTH = 200
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 240

const sidebarWidth = ref(DEFAULT_WIDTH)
const isResizing = ref(false)

const clamp = (px: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)))

onMounted(() => {
  const saved = Number(localStorage.getItem(props.storageKey))
  if (saved) sidebarWidth.value = clamp(saved)
})

let startX = 0
let startWidth = 0

function onResize(e: PointerEvent) {
  sidebarWidth.value = clamp(startWidth + (e.clientX - startX))
}

function stopResize() {
  isResizing.value = false
  window.removeEventListener('pointermove', onResize)
  window.removeEventListener('pointerup', stopResize)
  document.body.classList.remove('is-resizing-split')
  localStorage.setItem(props.storageKey, String(sidebarWidth.value))
}

function startResize(e: PointerEvent) {
  isResizing.value = true
  startX = e.clientX
  startWidth = sidebarWidth.value
  window.addEventListener('pointermove', onResize)
  window.addEventListener('pointerup', stopResize)
  document.body.classList.add('is-resizing-split')
  e.preventDefault()
}

function resetWidth() {
  sidebarWidth.value = DEFAULT_WIDTH
  localStorage.setItem(props.storageKey, String(DEFAULT_WIDTH))
}

onBeforeUnmount(stopResize)
</script>
