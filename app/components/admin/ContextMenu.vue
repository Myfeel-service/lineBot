<template>
  <!-- Teleport 到 body：側欄是 overflow 捲動容器，選單留在裡面會被裁掉半截 -->
  <Teleport to="body">
    <div
      v-if="props.visible"
      ref="menuEl"
      class="admin-context-menu"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <div v-if="trimmedTitle" class="admin-context-menu__title">{{ trimmedTitle }}</div>
      <button
        v-for="item in props.items"
        :key="item.key"
        type="button"
        class="admin-context-menu__item"
        :class="{ 'is-danger': item.danger }"
        role="menuitem"
        :disabled="item.disabled === true"
        @click="pick(item)"
      >
        <span v-if="item.icon" class="admin-context-menu__icon" aria-hidden="true">{{ item.icon }}</span>
        <span class="admin-context-menu__label">{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'

export interface AdminContextMenuItem {
  key: string
  label: string
  /** 選填的前導圖示（emoji 即可），純視覺 */
  icon?: string
  disabled?: boolean
  danger?: boolean
}

const props = withDefaults(defineProps<{
  visible: boolean
  /** 游標位置（clientX / clientY）；選單是 position: fixed，直接用視窗座標 */
  x: number
  y: number
  /** 選填的標頭，用來說明「這個選單是對誰下的」 */
  title?: string
  items: AdminContextMenuItem[]
}>(), {
  title: '',
})

const emit = defineEmits<{
  (e: 'select', key: string): void
  (e: 'update:visible', value: boolean): void
}>()

const menuEl = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })
const trimmedTitle = computed(() => String(props.title || '').trim())

/** 貼齊視窗邊界：在最下面／最右邊按右鍵時，選單要往回收，不能開到看不見的地方 */
const EDGE_MARGIN = 8
watch(
  () => [props.visible, props.x, props.y] as const,
  async ([visible, x, y]) => {
    if (!visible) return
    pos.value = { x, y }
    await nextTick()
    const el = menuEl.value
    if (!el || typeof window === 'undefined') return
    const rect = el.getBoundingClientRect()
    pos.value = {
      x: Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - rect.width - EDGE_MARGIN)),
      y: Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - rect.height - EDGE_MARGIN)),
    }
  },
  { immediate: true },
)

function close() {
  emit('update:visible', false)
}

function pick(item: AdminContextMenuItem) {
  if (item.disabled === true) return
  close()
  emit('select', item.key)
}

function onDocumentPointerDown(ev: MouseEvent) {
  if (menuEl.value?.contains(ev.target as Node)) return
  close()
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') close()
}

function bindGlobal(on: boolean) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const fn = on ? 'addEventListener' : 'removeEventListener'
  // capture：清單自己是捲動容器，冒泡階段收不到它的 scroll
  document[fn]('mousedown', onDocumentPointerDown as EventListener, true)
  document[fn]('scroll', close, true)
  document[fn]('keydown', onKeydown as EventListener)
  window[fn]('resize', close)
  window[fn]('blur', close)
}

watch(() => props.visible, visible => bindGlobal(visible))
onUnmounted(() => bindGlobal(false))
</script>
