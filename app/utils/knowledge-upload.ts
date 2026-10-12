/** 空檔（0 KB）收不了的原因：單份與一次好幾份共用同一句 */
export const EMPTY_FILE_HINT = '這是空的檔案（0 KB），裡面沒有內容可以整理'

/**
 * 檔案大小給人看（一次好幾份的清單、資料頁的原檔那一行共用；2026-10-12 code review：兩邊各寫一份）。
 * zero：0 要顯示什麼——清單上真的會有空檔（顯示 0 KB）；資料頁的 0 是「沒記到大小」（傳「大小未知」）。
 */
export function formatFileSize(bytes: number, opts: { zero?: string } = {}): string {
  if (!bytes) return opts.zero ?? '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 把檔案直傳到雲端儲存的簽名網址（知識庫匯入的單份與一次好幾份共用，`C-296`）。
 *
 * ⛔ 失敗時不可以把原始錯誤丟給畫面：那是一行「[PUT] "https://storage.googleapis.com/…": <no response> Failed to fetch」，
 *    店家看到只會以為檔案壞了。原始錯誤留在 console 給我們查，畫面只講「發生什麼、下一步」。
 * ⚠️ 原因要分得出來才講（2026-10-11 審查）：以前一律說「可能是網路中斷」，連雲端儲存回 403 也這樣講。
 *    沒有回應＝網路斷了或雲端儲存不收這個網址來的上傳（跨網域設定）——瀏覽器分不出這兩種，就只說「連不上」；
 *    有回應的才講是被拒絕。
 * 直打簽名網址（絕對網址）→ 用 $fetch，不要用會加 workspace／auth 標頭的 apiFetch。
 */
export async function putFileToSignedUrl(uploadUrl: string, file: File): Promise<void> {
  try {
    await $fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    })
  }
  catch (err) {
    console.warn('[knowledge-upload] 直傳雲端失敗：', err)
    throw new Error(uploadFailureMessage(err))
  }
}

/** 直傳失敗講給店家聽的那一句（抽出來好測） */
export function uploadFailureMessage(err: unknown): string {
  const e = err as { statusCode?: number, status?: number, response?: { status?: number } } | null
  const status = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
  if (!status) return '檔案上傳失敗（連不上雲端儲存）；請確認網路後再試一次，還是不行請聯絡我們'
  if (status === 403 || status === 401) return '檔案上傳被拒絕（上傳許可可能已經過期）；請再試一次，還是不行請聯絡我們'
  return `檔案上傳失敗（雲端儲存回了錯誤 ${status}）；請再試一次，還是不行請聯絡我們`
}
