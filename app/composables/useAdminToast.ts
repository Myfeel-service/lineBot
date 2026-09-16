// 2026-09-16：補上 'info'。標籤頁早就在用它（「這顆標籤已經沒有人在等你決定了」那句），
// 型別沒有這一項＝typecheck 一直是紅的，而畫面上它會掉進沒有樣式的預設樣子。
export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface AdminToast {
  id: number
  msg: string
  type: ToastType
}

/** 全站共用 toast 佇列（須搭配 layout 內的 AdminToastHost） */
export function useAdminToast() {
  const toasts = useState<AdminToast[]>('admin-toasts', () => [])
  const toastId = useState('admin-toast-id', () => 0)

  const showToast = (msg: string, type: ToastType) => {
    const id = ++toastId.value
    toasts.value = [...toasts.value, { id, msg, type }]
    setTimeout(() => {
      toasts.value = toasts.value.filter((toast) => toast.id !== id)
    }, 3500)
  }

  return { toasts, showToast }
}
