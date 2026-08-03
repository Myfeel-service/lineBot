/**
 * 等某個 selector 對應的元素出現在畫面上（用 rAF 輪詢，逾時就放棄）。
 *
 * 教學導覽有兩個地方要等：跨頁導覽時等新頁面渲染完、換步驟時等示範訊息卡渲染出來。
 * 兩邊共用同一份實作，逾時語意才不會一邊 2 秒一邊 3 秒地各自漂移。
 */
export function waitForElement(selector: string, timeout = 3000): Promise<HTMLElement | null> {
  if (typeof document === 'undefined' || !selector)
    return Promise.resolve(null)
  return new Promise((resolve) => {
    const start = performance.now()
    const tick = () => {
      const el = document.querySelector<HTMLElement>(selector)
      if (el)
        return resolve(el)
      if (performance.now() - start > timeout)
        return resolve(null)
      requestAnimationFrame(tick)
    }
    tick()
  })
}
