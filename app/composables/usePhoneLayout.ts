/**
 * 現在是不是手機版面（視窗 ≤ 720px）——`E-13`／`D-105`。
 *
 * ⚠️ 這一刀跟 `_main.scss`（外殼側欄改成左上角選單）、`_split-layout.scss`（`mobileStack` 清單↔內容一次看一邊）
 *    同一條線。CSS 管得到的（排版）就交給 CSS；這支只給「手機上要換一個元件」的地方用
 *    （例：對話頁右側客人檔案在手機上改成按了才滑出來的抽屜，電腦版那一欄就不掛，免得背景多讀一次）。
 *
 * ⛔ 初值在 setup 當下就量（後台是 `ssr: false`，拿得到 window）：等 onMounted 才量的話，
 *    第一個畫面會先照電腦版排一次再跳成手機版——從通知連結點進來就會先閃一下清單。
 */
export const PHONE_LAYOUT_MAX_PX = 720

export function usePhoneLayout() {
  const query = `(max-width: ${PHONE_LAYOUT_MAX_PX}px)`
  const mql = import.meta.client && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
  const isPhone = ref(!!mql?.matches)
  const sync = () => { isPhone.value = !!mql?.matches }
  onMounted(() => {
    sync()
    mql?.addEventListener('change', sync)
  })
  onBeforeUnmount(() => mql?.removeEventListener('change', sync))
  return isPhone
}
