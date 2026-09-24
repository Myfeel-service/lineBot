<template>
  <div class="flow-rich-message-areas">
    <template v-if="hasHeroImage">
    <AdminAreaEditorSection
      :areas="msg.actions"
      section-label="區塊設定"
      :flat="flat ?? true"
      :show-canvas="showCanvas ?? false"
      :show-action-cards="showActionCards ?? true"
      :show-header="showHeader ?? true"
      :show-add-button="isCustomLayout"
      :allow-remove="isCustomLayout"
      :show-bounds="isCustomLayout"
      :min-bounds-size="RICH_MESSAGE_MIN_BOUNDS"
      :base-width="canvasSize.width"
      :base-height="canvasSize.height"
      :area-colors="areaColors"
      :drag-area-index="areaDragState?.areaIndex ?? null"
      :overlap-set="customOverlapSet"
      :guide-lines="areaGuideLines"
      :canvas-style="richMessageCanvasStyle"
      :canvas-image-url="String(msg.heroImageUrl || '').trim() || undefined"
      :set-canvas-ref="setRichMessageCanvasRef"
      @add="addCustomArea"
      @remove="removeCustomArea"
      @start-drag="startCustomDrag"
      @start-resize="startCustomResize"
      @clamp="clampCustomArea"
    >
      <template #action-fields="{ area }">
        <AdminAreaActionEditor
          :model-value="area"
          :module-options="moduleOptions"
          :tag-options="tagOptions || []"
          :enable-tagging="Boolean(enableTagging)"
          :error-message="actionError(area) || ''"
          @update:model-value="(next) => Object.assign(area, next)"
        />
      </template>
    </AdminAreaEditorSection>
    </template>
  </div>
</template>

<script setup lang="ts">
import {
  SLOT_LABELS as ACTION_SLOT_LABELS,
  validateUnifiedAction,
} from '~~/shared/action-schema'
import {
  type RichLayoutId,
} from '~~/shared/rich-layout-presets'
import {
  getRichMessageCanvasSize,
} from '~~/shared/line-image-spec'
import {
  RICH_MESSAGE_MIN_BOUNDS,
  normalizeRichMessageActions,
  newRichMessageAction,
  presetBoundsToCanvas,
  clampRichMessageBounds,
  defaultBoundsByIndex,
  type RichMessageEditorAction,
} from '~~/shared/rich-message-editor-helpers'

const props = defineProps<{
  msg: any
  moduleOptions: Array<{ id: string; name: string }>
  tagOptions?: Array<{ id: string; name: string; color?: string }>
  enableTagging?: boolean
  flat?: boolean
  showCanvas?: boolean
  showActionCards?: boolean
  showHeader?: boolean
}>()

const hasHeroImage = computed(() => {
  const u = props.msg?.heroImageUrl
  return typeof u === 'string' && u.trim().length > 0
})

const { showToast } = useAdminToast()

/** ⛔ 唯一來源在 `AREA_EDITOR_COLORS`（為什麼不能有紅色、為什麼不能再加深，都寫在那裡） */
const areaColors = AREA_EDITOR_COLORS as string[]

const customCanvasRef = ref<HTMLElement | null>(null)
const customAreas = computed(() => props.msg.actions as RichMessageEditorAction[])

const isCustomLayout = computed(() => props.msg.layoutId === 'custom')

const canvasSize = computed(() => getRichMessageCanvasSize(
  Number(props.msg?.heroImageWidth) || undefined,
  Number(props.msg?.heroImageHeight) || undefined,
))

const {
  dragState: areaDragState,
  guideLines: areaGuideLines,
  overlapSet: customOverlapSet,
  startDrag: startAreaDrag,
  startResize: startAreaResize,
  bindWindowListeners: bindAreaWindowListeners,
  unbindWindowListeners: unbindAreaWindowListeners,
} = useAreaEditor<RichMessageEditorAction>({
  areas: customAreas,
  canvasRef: customCanvasRef,
  canvasWidth: () => canvasSize.value.width,
  canvasHeight: () => canvasSize.value.height,
  minSize: RICH_MESSAGE_MIN_BOUNDS,
  snapPx: 8,
  enableSnap: true,
  getBounds: (action) => action.bounds ?? defaultBoundsByIndex(0),
  setBounds: (action, bounds) => {
    action.bounds = bounds
  },
})

const richMessageCanvasStyle = computed(() => {
  const { width, height } = canvasSize.value
  const d = areaDragState.value
  return {
    aspectRatio: `${width} / ${height}`,
    width: '100%',
    minHeight: '180px',
    cursor: d?.type === 'move' ? 'grabbing' : 'default',
    userSelect: d ? 'none' : 'auto',
  }
})

function setRichMessageCanvasRef(el: HTMLElement | null) {
  customCanvasRef.value = el
}

function switchPresetToCustom() {
  if (isCustomLayout.value) return
  const prevLayout = props.msg.layoutId as RichLayoutId
  const next = props.msg.actions.map((action: RichMessageEditorAction, idx: number) => ({
    ...action,
    bounds: presetBoundsToCanvas(prevLayout, idx, canvasSize.value.width, canvasSize.value.height),
  }))
  props.msg.layoutId = 'custom'
  props.msg.actions = normalizeRichMessageActions(
    'custom',
    next,
    Number(props.msg?.heroImageWidth) || undefined,
    Number(props.msg?.heroImageHeight) || undefined,
  )
}

function addCustomArea() {
  if (!isCustomLayout.value) return
  if (props.msg.actions.length >= ACTION_SLOT_LABELS.length) {
    showToast('自訂區域最多 6 個', 'error')
    return
  }
  props.msg.actions = normalizeRichMessageActions(
    'custom',
    [...props.msg.actions, newRichMessageAction(
      '',
      props.msg.actions.length,
      true,
      canvasSize.value.width,
      canvasSize.value.height,
    )],
    Number(props.msg?.heroImageWidth) || undefined,
    Number(props.msg?.heroImageHeight) || undefined,
  )
}

function removeCustomArea(index: number) {
  if (!isCustomLayout.value) return
  if (props.msg.actions.length <= 1) return
  props.msg.actions = normalizeRichMessageActions(
    'custom',
    props.msg.actions.filter((_: any, idx: number) => idx !== index),
    Number(props.msg?.heroImageWidth) || undefined,
    Number(props.msg?.heroImageHeight) || undefined,
  )
}

function clampCustomArea(index: number) {
  if (!isCustomLayout.value) return
  const action = props.msg.actions[index]
  if (!action?.bounds) return
  action.bounds = clampRichMessageBounds(
    action.bounds,
    canvasSize.value.width,
    canvasSize.value.height,
  )
}

function actionError(action: RichMessageEditorAction) {
  return validateUnifiedAction({
    slot: action.slot,
    type: action.type,
    uri: action.uri,
    text: action.text,
    moduleId: action.moduleId,
    tagging: {
      enabled: action?.tagging?.enabled === true,
      addTagIds: Array.isArray(action?.tagging?.addTagIds) ? action.tagging.addTagIds : [],
    },
  })
}

function startCustomDrag(e: MouseEvent, actionIndex: number) {
  if (!isCustomLayout.value) return
  startAreaDrag(e, actionIndex)
}

function startCustomResize(e: MouseEvent, actionIndex: number, handle: string) {
  if (!isCustomLayout.value) {
    switchPresetToCustom()
    nextTick(() => startAreaResize(e, actionIndex, handle))
    return
  }
  startAreaResize(e, actionIndex, handle)
}

onMounted(() => {
  bindAreaWindowListeners()
})

onBeforeUnmount(() => {
  unbindAreaWindowListeners()
})
</script>
