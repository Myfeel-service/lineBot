import { computed, onMounted, onUnmounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'

/** 與各編輯頁共用的離開／切換確認文案 */
export const UNSAVED_CHANGES_CONFIRM_MESSAGE =
  '您有未儲存的變更，離開將會遺失目前編輯內容，確定繼續嗎？'

export type UseUnsavedChangesOptions = {
  /** 可 JSON 序列化的編輯狀態（例如 `() => form.value`） */
  getSnapshot: () => unknown
  /** @default UNSAVED_CHANGES_CONFIRM_MESSAGE */
  message?: string
  /** 站內換頁時攔截（vue-router） */
  enableRouteLeave?: boolean
  /** 關閉分頁／重新整理前提示（瀏覽器只會顯示通用文案） */
  enableBeforeUnload?: boolean
}

/**
 * 以「序列化快照」比對是否與上次 `markClean()` 時不同，用於：
 * - 切換列表項目、新增、取消前的確認
 * - 站內路由離開前確認（可選）
 * - 關閉分頁前提示（可選）
 *
 * 初次呼叫 `markClean()` 前不視為髒狀態，避免一進頁就擋導向。
 */
export function useUnsavedChanges(opts: UseUnsavedChangesOptions) {
  const message = opts.message ?? UNSAVED_CHANGES_CONFIRM_MESSAGE
  const baselineJson = ref('')
  const forcedDirty = ref(false)

  function serializeCurrent(): string {
    try {
      return JSON.stringify(opts.getSnapshot())
    } catch {
      return ''
    }
  }

  const hasUnsavedChanges = computed(() => {
    if (forcedDirty.value) return true
    const b = baselineJson.value
    if (b === '') return false
    return serializeCurrent() !== b
  })

  /** 將「目前畫面上的值」設為已對齊基準（載入項目、儲存成功後請呼叫） */
  function markClean() {
    forcedDirty.value = false
    baselineJson.value = serializeCurrent()
  }

  /**
   * 明確標記為「有未儲存內容」。
   * 用於「畫面上已經是一份還沒存進資料庫的草稿」——從範本建立、AI 生成、複製一份。
   * 這種狀態不能用 markClean()：那等於宣告草稿已經安全，切走時不會攔，整份就消失了。
   */
  function markDirty() {
    forcedDirty.value = true
  }

  /** 若有未儲存變更則 `window.confirm`；回傳 `true` 表示可繼續離開／切換 */
  function confirmLeaveIfDirty(): boolean {
    if (!hasUnsavedChanges.value) return true
    return window.confirm(message)
  }

  if (opts.enableRouteLeave !== false) {
    onBeforeRouteLeave(() => {
      if (!hasUnsavedChanges.value) return true
      return window.confirm(message)
    })
  }

  if (opts.enableBeforeUnload) {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges.value) return
      e.preventDefault()
      e.returnValue = ''
    }
    onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
    onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload))
  }

  return {
    hasUnsavedChanges,
    markClean,
    markDirty,
    confirmLeaveIfDirty,
  }
}
