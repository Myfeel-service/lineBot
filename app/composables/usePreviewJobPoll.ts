/**
 * 知識庫背景工作（preview job）的輪詢協定 —— 匯入與「重新同步」共用同一份。
 *
 * 伺服器端每次輪詢只推進「一個有界單位」（一批 OCR / 幾段整理 / finalize），
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

/**
 * 等太久而放棄輪詢時，錯誤會帶這個代碼。
 *
 * 「等太久」跟「失敗」要分得出來：逾時的時候伺服器那份工作**還活著**（1 小時內都在），
 * 呼叫端可以把續接記號留著、下次進來接著跑；真的失敗才該把記號丟掉。
 */
export const PREVIEW_JOB_DEADLINE = '__deadline__'

export function usePreviewJobPoll() {
  const { apiFetch } = useWorkspace()
  const progress = ref<PreviewJobProgress | null>(null)
  let cancelled = false

  /** 大型密文件最壞情況（OCR 逐批 + 逐段整理）可到數分鐘；伺服器端 job 存活 1 小時 */
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
    /**
     * ⛔ 這句話只能講「畫面不等了、伺服器那份還在」，**不可以承諾下一步會發生什麼**。
     *
     * 2026-09-03 第一版寫成「還在背景整理；好了會在知識庫這一頁告訴你」，當天 code review
     * 抓到：這支 composable 有三個呼叫端，那句承諾只有「單筆匯入」那一個成立——
     * 重新同步的結果只活在前端（排程做完沒有人收），整站匯入的每一頁也是（`bulk-create`
     * 只在那個 worker 裡呼叫）。而重新同步那個呼叫端還會在後面接一句「可以再試一次」，
     * 兩句話直接自相矛盾。下一步一律由呼叫端自己補。
     */
    throw Object.assign(
      new Error('等太久了，畫面先不等（伺服器那份工作還在）'),
      { code: PREVIEW_JOB_DEADLINE },
    )
  }

  return { progress, poll, cancel, reset }
}
