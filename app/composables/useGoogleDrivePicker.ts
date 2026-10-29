import { classifyDriveShareError, classifyGoogleAuthError, createSheetFailureMessage, googleSheetUrl, type DriveShareFailure } from '~~/shared/google-drive-share'

/**
 * 「從 Google 雲端硬碟挑一份試算表」（`C-299`）：Google 的挑檔視窗＋挑完自動共用給系統帳號。
 *
 * 三步都在店家的瀏覽器裡做，伺服器什麼都不知道：
 *   ① 跳 Google 授權視窗拿 `drive.file`（最輕的一級：只碰得到他在挑檔視窗選的那一份，Google 列為不敏感、不用審）
 *   ② Google 的挑檔視窗（Picker）選一份試算表
 *   ③ 用同一把授權呼叫 Drive `permissions.create`，把那一份共用給系統帳號（檢視者、不寄通知信）
 * 之後就是「貼上連結」那條路：判別、探測讀不讀得到、整理並加入、每小時同步，全部照舊用系統帳號。
 * ⛔ 授權只留在這個畫面的記憶體裡（約一小時、離開知識庫這頁或登出就沒了，見 held），不送伺服器、不存——
 *    不存才不必管換人接、失效、加密（報告 `docs/KB-IMPORT-DECISIONS-FOLLOWUP-EVAL-20261012.md` 第五節）。
 *
 * Google 那邊的設定（2026-10-29 做好，在 `linebot-e8dda`）：Picker／Drive API、同意畫面加 `drive.file`、
 * 網頁用戶端「MiniMe 試算表挑檔」、只准 Picker 的金鑰「MiniMe Sheets Picker」。三個值走環境變數
 * （`PUBLIC_GOOGLE_PICKER_*`，見 nuxt.config）；沒設就 `enabled=false`，畫面退回原本的三步手動共用。
 * ⚠️ 用戶端與金鑰都綁了網址（lineminime.com、www、bot.myfeel-tw.com、localhost:3000、localhost:3100）：
 *    換網域或本機換埠就跳不出來。
 */

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GIS_SRC = 'https://accounts.google.com/gsi/client'
const GAPI_SRC = 'https://apis.google.com/js/api.js'
/** 授權到期前這麼久就當作過期重拿：挑檔視窗開著慢慢挑，回來共用時才不會剛好過期 */
const TOKEN_MARGIN_MS = 5 * 60_000

export interface PickedSheet { id: string, name: string, url: string }

/**
 * - `shared`：挑好（或開好）、也共用好了
 * - `shareFailed`：挑好了、共用失敗（網址照樣給：說不定早就共用過，探測讀得到就沒事）
 * - `failed`：授權視窗沒成功、或新表沒開成（已經翻成一句話，手上沒有任何一份）
 * - null：他自己關掉授權視窗或挑檔視窗——安靜就好
 */
export type PickOutcome =
  | { kind: 'shared', sheet: PickedSheet }
  | { kind: 'shareFailed', sheet: PickedSheet, failure: DriveShareFailure }
  | { kind: 'failed', message: string }
  | null

/**
 * 「幫我開一份新的」那份的欄位名稱：跟問答範本（public/templates/faq-sheet-template.xlsx 的 FAQ 分頁）同一組。
 * ⛔ 只放欄位名稱、不放範本那三列示範答案——忘了刪的話，示範答案會被當成真的知識加進去。
 */
const NEW_SHEET_TAB = '常見問題'
const NEW_SHEET_HEADERS = ['客人會問的問題', '答案']

class GoogleAuthError extends Error {
  constructor(readonly type: string) { super(type) }
}

/** Google 給的一把授權：字串＋什麼時候該當作過期（已經扣掉 TOKEN_MARGIN_MS） */
interface Grant { token: string, expiresAt: number }

// ── 模組層狀態：只放「Google 的程式庫一頁只載一次」那些。⛔ 授權本身不放這裡（見 useGoogleDrivePicker 裡的 held） ──
const scriptLoads = new Map<string, Promise<void>>()
let ready: Promise<void> | null = null
let tokenClient: { requestAccessToken: (o?: { prompt?: string }) => void } | null = null
let pending: { resolve: (g: Grant) => void, reject: (e: unknown) => void } | null = null

function loadScript(src: string): Promise<void> {
  let p = scriptLoads.get(src)
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script')
      el.src = src
      el.async = true
      el.onload = () => resolve()
      el.onerror = () => {
        scriptLoads.delete(src) // 斷線之類的，下次按再載一次
        reject(new GoogleAuthError('script_failed'))
      }
      document.head.appendChild(el)
    })
    scriptLoads.set(src, p)
  }
  return p
}

function prepare(clientId: string): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await Promise.all([loadScript(GIS_SRC), loadScript(GAPI_SRC)])
      const w = window as any
      await new Promise<void>((resolve, reject) => w.gapi.load('picker', { callback: resolve, onerror: () => reject(new GoogleAuthError('script_failed')) }))
      tokenClient = w.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_FILE_SCOPE,
        callback: (resp: any) => {
          const p = pending
          pending = null
          if (!p) return
          if (resp?.error) return p.reject(new GoogleAuthError(String(resp.error)))
          // 新版同意畫面可以只勾一部分權限：沒勾到 drive.file 等於沒授權
          if (!w.google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_FILE_SCOPE)) return p.reject(new GoogleAuthError('scope_not_granted'))
          p.resolve({ token: String(resp.access_token), expiresAt: Date.now() + Number(resp.expires_in ?? 3600) * 1000 - TOKEN_MARGIN_MS })
        },
        error_callback: (e: any) => {
          const p = pending
          pending = null
          p?.reject(new GoogleAuthError(String(e?.type ?? 'unknown')))
        },
      })
    })().catch((e) => {
      ready = null
      throw e
    })
  }
  return ready
}

/** 跳 Google 授權視窗要一把新的。⛔ 會開視窗，所以呼叫鏈上不能先 await 別的東西（見 pickAndShare） */
function requestGrant(): Promise<Grant> {
  return new Promise<Grant>((resolve, reject) => {
    // 上一次的視窗被他晾著沒回應：當作關掉了，換這一次
    pending?.reject(new GoogleAuthError('popup_closed'))
    pending = { resolve, reject }
    tokenClient!.requestAccessToken({ prompt: '' })
  })
}

function openPicker(token: string, apiKey: string, appId: string): Promise<PickedSheet | null> {
  return new Promise((resolve) => {
    const g = (window as any).google.picker
    const view = new g.DocsView(g.ViewId.SPREADSHEETS).setMode(g.DocsViewMode.LIST)
    new g.PickerBuilder()
      .addView(view)
      .enableFeature(g.Feature.SUPPORT_DRIVES) // 公司的共用雲端硬碟裡的也挑得到
      .setOAuthToken(token)
      .setDeveloperKey(apiKey)
      // ⛔ 一定要帶專案編號：drive.file 是靠它認「這一份是在我們的 App 裡挑的」，沒帶的話挑完照樣碰不到那一份
      .setAppId(appId)
      .setLocale('zh-TW')
      .setTitle('選一份試算表')
      .setCallback((data: any) => {
        const action = data[g.Response.ACTION]
        if (action === g.Action.PICKED) {
          const doc = data[g.Response.DOCUMENTS]?.[0]
          const id = String(doc?.[g.Document.ID] ?? '')
          resolve(id ? { id, name: String(doc?.[g.Document.NAME] ?? ''), url: googleSheetUrl(id) } : null)
        }
        else if (action === g.Action.CANCEL) {
          resolve(null)
        }
      })
      .build()
      .setVisible(true)
  })
}

async function shareWithViewer(fileId: string, email: string, token: string): Promise<DriveShareFailure | null> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`
    + '?supportsAllDrives=true&sendNotificationEmail=false&fields=id'
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: email }),
    })
  }
  catch {
    return classifyDriveShareError(0, null)
  }
  if (res.ok) return null
  return failureOf(res)
}

async function failureOf(res: Response): Promise<DriveShareFailure> {
  return classifyDriveShareError(res.status, await res.json().catch(() => null))
}

/**
 * 在他自己的雲端硬碟開一份新試算表（`drive.file` 開得了：自己這個 App 建的檔本來就碰得到）。
 * 欄位名稱那列加粗、凍結，兩欄先拉寬——他打開就知道要往哪裡填。
 */
async function createSheet(title: string, token: string): Promise<PickedSheet | DriveShareFailure> {
  const header = (text: string) => ({ userEnteredValue: { stringValue: text }, userEnteredFormat: { textFormat: { bold: true } } })
  let res: Response
  try {
    res = await fetch('https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: { title, locale: 'zh_TW' },
        sheets: [{
          properties: { title: NEW_SHEET_TAB, gridProperties: { frozenRowCount: 1 } },
          data: [{
            startRow: 0,
            startColumn: 0,
            rowData: [{ values: NEW_SHEET_HEADERS.map(header) }],
            columnMetadata: [{ pixelSize: 280 }, { pixelSize: 520 }],
          }],
        }],
      }),
    })
  }
  catch {
    return classifyDriveShareError(0, null)
  }
  if (!res.ok) return failureOf(res)
  const id = String((await res.json().catch(() => null))?.spreadsheetId ?? '')
  return id ? { id, name: title, url: googleSheetUrl(id) } : classifyDriveShareError(500, null)
}

export function useGoogleDrivePicker() {
  const cfg = useRuntimeConfig().public
  const clientId = String(cfg.googlePickerClientId || '')
  const apiKey = String(cfg.googlePickerApiKey || '')
  const appId = String(cfg.googlePickerAppId || '')
  const enabled = !!(clientId && apiKey && appId)
  const { $auth } = useNuxtApp()

  /**
   * 手上這把授權。⛔ 放在這個畫面自己身上、不放模組層，而且記著是哪個後台帳號拿的（2026-10-29 `/code-review`）：
   * 登出只換頁、不重新載入網頁，放模組層的話，共用電腦上 A 挑過表、登出，B 一小時內登入按挑檔，
   * 不會再跳授權視窗、直接打開 A 的雲端硬碟，還能把 A 的表接進 B 的帳號。
   * 現在離開知識庫這頁（登出一定會離開）就跟著消失；同一頁裡換了登入的人也不認。
   */
  let held: Grant & { uid: string } = { token: '', expiresAt: 0, uid: '' }
  const currentUid = () => String(($auth as { currentUser?: { uid?: string } | null })?.currentUser?.uid ?? '')

  /** 先把 Google 的程式庫載好（打開試算表那一格時呼叫）：按下去才載的話，授權視窗會被瀏覽器當成彈出廣告擋掉 */
  function warmUp() {
    if (enabled && import.meta.client) void prepare(clientId).catch(() => {})
  }

  /**
   * 跳授權 → 挑一份 → 共用給 `shareWith`（檢視者）。
   * ⛔ 一定要在按鈕的 click 裡直接呼叫，而且這裡**第一個 await 之前**就叫出授權視窗：
   *    中間隔了 await，瀏覽器就不認為是「他按了按鈕才開的」而擋掉（所以才要 warmUp 先載好）。
   */
  async function pickAndShare(shareWith: string): Promise<PickOutcome> {
    const token = await authorize()
    if (typeof token !== 'string') return token
    const sheet = await openPicker(token, apiKey, appId)
    if (!sheet) return null
    return share(sheet, shareWith, token)
  }

  /** 「還沒有表？幫我開一份新的」：開一份只有欄位名稱的新表 → 共用給 `shareWith`。呼叫規矩同 pickAndShare */
  async function createAndShare(shareWith: string, title: string): Promise<PickOutcome> {
    const token = await authorize()
    if (typeof token !== 'string') return token
    const made = await createSheet(title, token)
    if (!('id' in made)) {
      if (made.kind === 'expired') forget()
      return { kind: 'failed', message: createSheetFailureMessage(made) }
    }
    return share(made, shareWith, token)
  }

  /**
   * 挑好了、共用沒成功（Google 暫時出狀況、授權過期、猜不出原因）→ 同一份再共用一次，不用再開挑檔視窗重挑。
   * 那一份在他挑的時候就交給我們這個 App 了（`drive.file` 認的是 App，不是哪一把授權），換一把新的也碰得到。
   * 呼叫規矩同 pickAndShare：授權過期的話要開視窗重拿，只能在按鈕裡叫。
   */
  async function shareAgain(sheet: PickedSheet, shareWith: string): Promise<PickOutcome> {
    const token = await authorize()
    if (typeof token !== 'string') return token
    return share(sheet, shareWith, token)
  }

  async function share(sheet: PickedSheet, shareWith: string, token: string): Promise<PickOutcome> {
    const failure = await shareWithViewer(sheet.id, shareWith, token)
    // 過期的那把丟掉：他按「再試一次」時才會跳視窗拿新的（背景重拿會被瀏覽器當彈出廣告擋掉，所以不偷偷重試）
    if (failure?.kind === 'expired') forget()
    return failure ? { kind: 'shareFailed', sheet, failure } : { kind: 'shared', sheet }
  }

  function forget() {
    held = { token: '', expiresAt: 0, uid: '' }
  }

  /** 拿授權；拿不到就回成畫面要的結果（一句話，或 null＝他自己關掉）。⛔ 這裡第一行就要叫出視窗，前面不能有 await */
  async function authorize(): Promise<string | Exclude<PickOutcome, { kind: 'shared' | 'shareFailed' }>> {
    const uid = currentUid()
    const reusable = !!held.token && held.uid === uid && Date.now() < held.expiresAt
    const grantP = reusable ? null : (tokenClient ? requestGrant() : prepare(clientId).then(requestGrant))
    if (!grantP) return held.token
    try {
      const grant = await grantP
      held = { ...grant, uid }
      return grant.token
    }
    catch (e) {
      const type = e instanceof GoogleAuthError ? e.type : 'unknown'
      if (type === 'script_failed') return { kind: 'failed', message: '連不到 Google（可能是網路或擋廣告的外掛擋住了），請再按一次。' }
      const message = classifyGoogleAuthError(type)
      return message ? { kind: 'failed', message } : null
    }
  }

  return { enabled, warmUp, pickAndShare, createAndShare, shareAgain }
}
