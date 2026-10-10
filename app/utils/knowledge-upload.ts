/**
 * 把檔案直傳到雲端儲存的簽名網址（知識庫匯入的單份與一次好幾份共用，`C-296`）。
 *
 * ⛔ 失敗時不可以把原始錯誤丟給畫面：那是一行「[PUT] "https://storage.googleapis.com/…": <no response> Failed to fetch」，
 *    店家看到只會以為檔案壞了。最常見的原因是網路中斷，其次是雲端儲存不收這個網址來的上傳（跨網域設定）；
 *    兩種他都修不了，講清楚「再試一次、還是不行就找我們」，原始錯誤留在 console 給我們查。
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
    throw new Error('檔案上傳失敗（連不上雲端儲存，可能是網路中斷）；請再試一次，還是不行請聯絡我們')
  }
}
