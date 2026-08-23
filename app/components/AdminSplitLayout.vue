<template>
  <div class="split-layout" :class="{ 'split-layout--solo': solo, 'split-layout--readonly': !canOperate }">
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
const { canOperate } = useWorkspace()

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
})

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
