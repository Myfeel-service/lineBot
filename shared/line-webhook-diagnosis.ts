/**
 * 「LINE 收訊接得通嗎」的單一判讀來源。
 *
 * 為什麼要有這份：同一個檢查結果原本在兩個地方各判一次——設定頁的狀態徽章判得對
 * （401 → Channel Secret 貼錯），小幫手對話卻用字串比對 /HTTP 401/ 一律說成
 * 「Channel Access Token 貼錯」並叫人重貼 Token。兩個 401 根本是不同的病：
 *
 *   ① 我們拿 Token 去問 LINE，LINE 回 401 ＝ LINE 不認得這把 Token（第一把鑰匙的事）
 *   ② LINE 拿測試訊息打我們的網址，回 401 ＝ 我們的簽章驗不過（第二把鑰匙 Channel Secret 的事）
 *
 * 混在一起的後果不是講得不夠好，是**把人指去改一個不是病因的地方**，而且改完再驗還是同一句話。
 * 所以「是什麼病」只在這裡判一次，各畫面只決定「怎麼說」。
 *
 * ⚠️ 判讀順序有意義，不要隨手調：網址不一致時，LINE 測試打的是**別人的網址**，
 * 那個 401 跟我們的簽章無關——所以 mismatch 必須排在測試結果前面。
 */

/** line-webhook-verify 回應中，判讀真的用得到的欄位（完整型別在該端點檔） */
export interface LineWebhookVerifyLike {
  getOk: boolean
  getStatus?: number
  getMessage?: string
  lineEndpoint?: string | null
  lineActive?: boolean | null
  urlMatchesCompare?: boolean | null
  endpointUnreachable?: boolean | null
  test?: { success: boolean, reason?: string, statusCode?: number | null } | null
  testSkipped?: boolean
  testError?: string
}

export type LineWebhookCause =
  /** LINE 不認得我們的 Channel Access Token（第一把鑰匙） */
  | 'token'
  /** LINE 後台還沒填收訊網址 */
  | 'nourl'
  /** 問不到 LINE 的狀態：不下結論（查不到 ≠ 壞掉） */
  | 'unknown'
  /** Use webhook 開關沒打開 */
  | 'inactive'
  /** LINE 填的不是這套系統的網址，且那個網址已經連不上 */
  | 'mismatchDead'
  /** LINE 填的不是這套系統的網址，但還連得到 */
  | 'mismatch'
  /** 網址是我們沒錯，但我們把 LINE 的測試訊息擋掉了＝Channel Secret（第二把鑰匙）對不上 */
  | 'signature'
  /** 測試沒過，但講不出更精確的病因 */
  | 'testFailed'
  | 'ok'

export interface LineWebhookVerdict {
  cause: LineWebhookCause
  /** 設定頁徽章的一眼結論 */
  badge: string
  tone: 'success' | 'warning' | 'danger'
  /** 設定頁徽章的一句白話「怎麼辦」 */
  hint: string
}

export function diagnoseLineWebhook(r: LineWebhookVerifyLike): LineWebhookVerdict {
  // ① 連 LINE 都問不到：401 是 Token 的事，404 是還沒填網址，其他不下結論
  if (!r.getOk) {
    if (r.getStatus === 401) {
      return {
        cause: 'token',
        badge: '✕ LINE 不認得這把鑰匙',
        tone: 'danger',
        hint: 'LINE 不認得這頁存的 Channel Access Token（多半是在 LINE 後台被重新發過一次）。到 LINE Developers 重發一組貼回這頁，再按儲存。',
      }
    }
    if (r.getStatus === 404) {
      return {
        cause: 'nourl',
        badge: '✕ LINE 後台還沒填網址',
        tone: 'danger',
        hint: 'LINE 那邊還沒設定 Webhook 網址，客人的訊息不知道要送去哪。把上面那格「Webhook 網址」複製、貼到 LINE Developers 存檔。',
      }
    }
    return {
      cause: 'unknown',
      badge: '✕ 問不到狀態',
      tone: 'danger',
      hint: r.getMessage || '目前問不到 LINE，稍後再試，或確認 Token 是否正確。',
    }
  }

  // ② 網址不一致要排在測試結果前面：測試打的是 LINE 填的那個網址，
  //    那不是我們的系統，它回什麼都不能拿來診斷我們這邊的設定
  if (r.urlMatchesCompare === false) {
    if (r.endpointUnreachable) {
      return {
        cause: 'mismatchDead',
        badge: '✕ LINE 填的網址已連不上',
        tone: 'danger',
        hint: 'LINE 現在把訊息送往一個已經連不上的網址（多半是舊網域停用了），客人傳什麼都收不到。把上面那格「Webhook 網址」複製、貼到 LINE 後台覆蓋掉。',
      }
    }
    return {
      cause: 'mismatch',
      badge: '✕ 網址不一致（填的是舊網址）',
      tone: 'danger',
      hint: 'LINE 那邊填的不是這套系統的正式網址。訊息目前還進得來，但那個網址一停用就會無聲斷線。趁還沒斷，把上面那格「Webhook 網址」複製、貼到 LINE 後台覆蓋掉。',
    }
  }

  // ③ 開關沒開：網址對也沒用，訊息不會送出來
  if (r.lineActive === false) {
    return {
      cause: 'inactive',
      badge: '⚠ Webhook 沒開',
      tone: 'warning',
      hint: 'LINE 後台的 Webhook 開關沒打開，這樣收不到訊息 —— 到 LINE Developers 把它打開。',
    }
  }

  // ④ 走到這裡＝LINE 打的就是我們自己的網址，測試結果才有診斷價值
  if (r.testSkipped !== true && (r.testError || (r.test && !r.test.success))) {
    if (r.test?.statusCode === 401) {
      return {
        cause: 'signature',
        badge: '✕ 訊息被我們自己擋下來',
        tone: 'danger',
        hint: 'LINE 連到你的系統了，但被擋下來 —— 多半是這頁的 Channel Secret 跟 LINE 後台不是同一組，重貼一次再存。',
      }
    }
    return {
      cause: 'testFailed',
      badge: '✕ 測試沒過',
      tone: 'danger',
      hint: 'LINE 連你的系統時失敗了。確認網址對外連得到、開頭是 https。',
    }
  }

  if (r.testSkipped !== true && r.test?.success) {
    return {
      cause: 'ok',
      badge: '✓ 一切正常',
      tone: 'success',
      hint: 'LINE 連得到你的系統，訊息收發沒問題。',
    }
  }
  return {
    cause: 'ok',
    badge: '✓ 看起來正常',
    tone: 'success',
    hint: '想再確認的話，按上方「測試連線」實跑一次。',
  }
}
