import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { channelConflictDetail, checkLineChannelConflict } from '~~/server/utils/workspace-alerts'

/**
 * GET /api/admin/line-channel-check
 *
 * 「同一個官方帳號接在兩個工作區」的**窄探針**：只回這一件事的狀態。
 *
 * 為什麼要有這支（2026-08-27 code review）：修復劇本的驗證迴圈原本打
 * `/api/admin/alerts?force=1` 來讀這一個布林——那會讓**整個工作區所有 probe 全部跳快取重跑**
 * （問 LINE、逐個 LIFF 的外部請求、額度、佇列掃描…）。使用者一邊等同事處理一邊按五次
 * 「幫我檢查」就是五輪全量重探。判定本體共用 `checkLineChannelConflict`，口徑仍只有一份。
 *
 * state 三態誠實：active＝真的接在兩邊；clear＝只接在這一邊（含還沒接 LINE）；
 * unknown＝這次問不到官方帳號身分，**不等於沒問題**。
 */
export default defineEventHandler(async (event) => {
  // 與異常註冊表同一把尺：lineChannelConflict 是 settings 級
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const c = await checkLineChannelConflict(getDb(), workspaceId)
  if (c.kind === 'conflict')
    return { state: 'active' as const, detail: channelConflictDetail(c.names) }
  if (c.kind === 'unknown')
    return { state: 'unknown' as const, detail: '' }
  return { state: 'clear' as const, detail: '' }
})
