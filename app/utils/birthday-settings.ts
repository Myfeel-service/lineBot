import { normalizeBirthdaySettings, type BirthdaySettings } from '~~/shared/birthday'

/**
 * 生日設定的讀寫（`C-468` code review 第 7 條）：**三個畫面同一條路**。
 *
 * 為什麼要收成一支：讀設定（GET `/api/ai/settings` → `normalizeBirthdaySettings`）原本在
 * 「生日」框、邀請卡框、開帳精靈各寫一份，打開開關的 PUT 寫了兩份。同一輪 code review 抓到的
 * 三個毛病（整包送回去會蓋掉生日禮、錯誤訊息沒用 `apiErrorText`、少了「什麼情況不附」的但書）
 * 每一個都得改兩三個地方，漏掉一處就是那個畫面繼續壞——跟 `shared/birthday.ts` 收文案同一個理由。
 *
 * ⛔ 這裡只管「怎麼跟伺服器要／存」。畫面狀態（loading、錯誤那句、代號防護）留在各自的元件裡，
 *   因為三個畫面要的行為本來就不一樣（框裡要顯示「讀不到設定」，精靈是安靜跳過）。
 */

/** 各處的 `apiFetch`（`useWorkspace()`／`useWorkspaceApiFetch()`）都符合這個形狀 */
export type BirthdayApiFetch = <T>(url: string, options?: Parameters<typeof $fetch>[1]) => Promise<T>

const SETTINGS_URL = '/api/ai/settings'

/**
 * 讀現在的設定。
 * ⛔ 讀不到回 `null`，**不要自己造一份預設值當成「現況」**：那會讓「讀不到」看起來像「關著」，
 *   於是畫面去問一件它根本不知道現況的事（精靈那一題就是這樣，第 2 條）。
 */
export async function readBirthdaySettings(apiFetch: BirthdayApiFetch): Promise<BirthdaySettings | null> {
  try {
    const s = await apiFetch<{ birthday?: Partial<BirthdaySettings> }>(SETTINGS_URL)
    return normalizeBirthdaySettings(s?.birthday)
  }
  catch {
    return null
  }
}

/**
 * 只把開關打開。
 *
 * ⛔ **只送 `enabled`**（第 3 條）：伺服器對 `birthday` 是深合併
 * （`server/utils/ai-settings.ts` 的 `birthday: { ...current.birthday, ...partial.birthday }`），
 * 把讀到當下的整包送回去反而會蓋掉——店家在「生日」框或另一個分頁剛寫好的生日禮會被洗成空白，
 * 客人收到的卡片與回覆從此不再提那個禮物，而且沒有任何提示。
 * ⚠️ 失敗會丟出來，呼叫端自己決定怎麼跟店家講（一律用 `apiErrorText`）。
 */
export async function enableBirthday(apiFetch: BirthdayApiFetch): Promise<void> {
  await apiFetch(SETTINGS_URL, { method: 'PUT', body: { birthday: { enabled: true } } })
}

/**
 * 存整包（開關＋生日禮）。只有「生日」框該用這支：那兩格都是人在那個框裡編的，
 * 整包送才是他看到的狀態；別的地方要打開開關一律走 `enableBirthday()`。
 * 回存完之後伺服器認定的狀態（它可能正規化過）。
 */
export async function saveBirthdaySettings(
  apiFetch: BirthdayApiFetch,
  next: BirthdaySettings,
): Promise<BirthdaySettings> {
  const body = normalizeBirthdaySettings(next)
  const r = await apiFetch<{ birthday?: Partial<BirthdaySettings> }>(SETTINGS_URL, {
    method: 'PUT',
    body: { birthday: body },
  })
  return normalizeBirthdaySettings(r?.birthday ?? body)
}
