/**
 * 知識庫背景工作（preview job）的輪詢協定 —— 匯入與「重新同步」共用同一份。
 *
 * 伺服器端每次輪詢只推進「一個有界單位」（一批 OCR / 幾段切卡 / finalize），
 * 所以這裡永遠拿到短回應；閘道偶發 504/502/408 是「某一步剛好較久」，
 * 吞掉繼續輪詢即可（伺服器端的 lease 會讓下一輪重接那一步），不可一次抖動就整個失敗。
 *
 * 兩個呼叫端各自複製一份的話，之後改重試碼、逾時、加續跑機制都得改兩處（且已經開始分歧），
 * 所以收斂成這支 composable。
 */
export interface PreviewJobProgress {
  done: number
  total: number
  label: string
}

/** 使用者按取消時丟出的識別錯誤；呼叫端據此顯示「已取消」而不是失敗 */
export const PREVIEW_JOB_CANCELLED = '__cancelled__'

export function usePreviewJobPoll() {
  const { apiFetch } = useWorkspace()
  const progress = ref<PreviewJobProgress | null>(null)
  let cancelled = false

  /** 大型密文件最壞情況（OCR 逐批 + 逐段切卡）可到數分鐘；伺服器端 job 存活 1 小時 */
  const DEADLINE_MS = 8 * 60 * 1000
  const INTERVAL_MS = 1200

  function cancel() {
    cancelled = true
  }

  function reset() {
    cancelled = false
    progress.value = null
  }

  /** 輪詢到 done / error；使用者取消時丟出 PREVIEW_JOB_CANCELLED */
  async function poll<T>(jobId: string): Promise<T> {
    const deadline = Date.now() + DEADLINE_MS
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
      if (cancelled) throw new Error(PREVIEW_JOB_CANCELLED)
      let res: any
      try {
        res = await apiFetch<any>(`/api/ai/knowledge/preview-jobs/${encodeURIComponent(jobId)}`)
      }
      catch (e: any) {
        const code = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
        if (code === 504 || code === 502 || code === 408 || code === 0) continue
        throw e
      }
      // await 前後都要檢查：使用者常在最慢的那一步按取消，只檢查前面的話
      // 這個 done 回應仍會把他帶進後續流程
      if (cancelled) throw new Error(PREVIEW_JOB_CANCELLED)
      if (res.status === 'done') return res as T
      if (res.status === 'error') throw new Error(res.error || '處理失敗')
      progress.value = res.progress ?? null
    }
    throw new Error('處理逾時')
  }

  return { progress, poll, cancel, reset }
}
