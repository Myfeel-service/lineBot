import QRCode from 'qrcode'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { issueMemberLineBindCode } from '~~/server/utils/member-line-bind'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/admin/workspaces/:workspaceId/line-notify/self-code
 * 「把我的手機加進來」（`D-103`④）：幫**自己**產一組綁定碼，連 QR 一起回。
 * 手機相機掃 QR → LINE 打開官方帳號的聊天室、訊息已打好 → 按送出就綁好並加進通知名單。
 *
 * 客服起跳（第 3 題拍板：客服可以加自己）。⛔ 只能產自己的；幫別人產是
 * `members/:uid/line-bind-code`（管理員，「傳連結給他」那顆）。
 * 沒有成員資格的人（組織管理員、超管）沒有成員文件可以綁 → 404，畫面上那顆鈕本來就不顯示。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'notify.self')
  const result = await issueMemberLineBindCode(workspaceId, uid, 'self')

  // 拿不到官方帳號 ID（bindUrl 空的）就沒有 QR：畫面退回「在聊天室傳這行字」
  let qrDataUrl = ''
  if (result.bindUrl) {
    try {
      qrDataUrl = await QRCode.toDataURL(result.bindUrl, {
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
        color: { dark: '#303133', light: '#ffffff' },
      })
    }
    catch (err) {
      console.warn('[line-notify] qr failed:', err)
    }
  }

  // 稽核（同 `line-bind-code`）：碼在有效期內誰拿到就能綁成這位成員。⛔ 碼本身不寫進紀錄
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'member.lineBindCode',
    targetId: uid,
    note: '成員自己產了一組綁定碼，要把自己的手機加進 LINE 通知（碼本身不留在紀錄裡）',
  })

  return { ...result, qrDataUrl }
})
