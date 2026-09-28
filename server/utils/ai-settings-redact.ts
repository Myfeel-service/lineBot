/**
 * AI 設定「讀出去之前」依角色拿掉看不該看的欄位（`G-103`）。
 *
 * 為什麼要有：畫面早就照角色藏了，但 `GET /api/ai/settings` 是觀察者級、整包回傳——
 * 直接打 API（或開 DevTools）就拿得到回答模型、回覆長度、每月 token 上限，
 * 連觀察者進不去的 LINE 通知頁上那份名單都拿得到。只藏畫面不擋 API 等於沒擋。
 *
 * 三層，各自對上一條既有的政策，⛔不在這裡另訂一套角色：
 *  1. 模型／embedding 模型／回覆長度：**只有超管**（2026-08-05 成本可見性收歸平台；
 *     存檔那支 `settings.put.ts` 對非超管也是直接丟掉這三格，讀跟寫同一條線）。
 *  2. 每月 token 上限：**改得動的人（ai.settings.write）才看得到**。那是店家自己設來保護自己的，
 *     管理員要看得到才改得了；客服與觀察者的畫面本來就不顯示這一格。
 *  3. LINE 通知名單（LINE userId 與顯示名稱）：**收得到通知的角色（notify.self）才看得到**。
 *     觀察者連「設定 → LINE 通知」都進不去，卻從這裡拿得到名單，是這次查到的洞。
 *     ⚠️ 拿掉名單之後改給 `recipientCount`：畫面上「有沒有人在收」只需要人數，
 *        ⛔不可以回一個空陣列頂替——那是在說「沒有人收」，跟「你看不到」是兩件事。
 *
 * ⛔ 一律**複製**再拿掉，不可以在原物件上 delete：`getAiSettings` 回的是這台機器快取裡的
 *    同一個物件，改到它＝接下來 60 秒整台機器的 AI 都讀到被拿掉欄位的設定。
 */
import type { AiSettingsDoc } from '~~/shared/types/ai-knowledge'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import { can } from '~~/shared/permissions'

type PlatformOnlyKey = 'answerModel' | 'embeddingModel' | 'replyMaxLen'

export type AiSettingsView =
  Omit<AiSettingsDoc, PlatformOnlyKey | 'quota' | 'handoffNotify'>
  & Partial<Pick<AiSettingsDoc, PlatformOnlyKey>>
  & {
    quota: Omit<AiSettingsDoc['quota'], 'monthlyTokenCap'> & { monthlyTokenCap?: number }
    handoffNotify: Omit<AiSettingsDoc['handoffNotify'], 'lineUserIds' | 'displayNames'>
      & Partial<Pick<AiSettingsDoc['handoffNotify'], 'lineUserIds' | 'displayNames'>>
      & {
        /** 名單上有幾個人：每個角色都有，看不到名單的人也知道「有沒有人在收」 */
        recipientCount: number
      }
  }

export function redactAiSettingsForRole(
  settings: AiSettingsDoc,
  viewer: { role: WorkspaceMemberRole | null | undefined, isSuperAdmin: boolean },
): AiSettingsView {
  const { role, isSuperAdmin } = viewer
  const { answerModel, embeddingModel, replyMaxLen, quota, handoffNotify, ...rest } = settings
  const { lineUserIds, displayNames, ...notifyRest } = handoffNotify ?? ({} as AiSettingsDoc['handoffNotify'])
  const { monthlyTokenCap, ...quotaRest } = quota ?? ({} as AiSettingsDoc['quota'])

  const seeNotifyList = isSuperAdmin || can(role, 'notify.self')
  const seeTokenCap = isSuperAdmin || can(role, 'ai.settings.write')

  return {
    ...rest,
    ...(isSuperAdmin ? { answerModel, embeddingModel, replyMaxLen } : {}),
    quota: { ...quotaRest, ...(seeTokenCap ? { monthlyTokenCap } : {}) },
    handoffNotify: {
      ...notifyRest,
      recipientCount: (lineUserIds ?? []).length,
      ...(seeNotifyList
        ? { lineUserIds: [...(lineUserIds ?? [])], ...(displayNames ? { displayNames: { ...displayNames } } : {}) }
        : {}),
    },
  }
}
