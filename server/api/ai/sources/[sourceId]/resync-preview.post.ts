/**
 * POST /api/ai/sources/:sourceId/resync-preview 【已停用】
 *
 * 舊的同步式重新同步:一個請求裡做完「重抓網頁 + LLM 重切卡 + 比對」,大頁面必撞閘道
 * 逾時(使用者只看到「取得差異失敗」)。已改由 POST /api/ai/sources/:id/resync-jobs
 * 建背景工作、輪詢 GET /api/ai/knowledge/preview-jobs/:jobId 推進。
 *
 * 這裡不直接刪檔而回 410:部署後仍開著舊分頁的使用者會打到這支,410 帶明確訊息
 * 比 404 更好懂。也避免留著第二套 diff 實作要跟著維護(它沒有新的內容縮水防護)。
 */
export default defineEventHandler(() => {
  throw createError({
    statusCode: 410,
    statusMessage: '重新同步已改版；請重新整理頁面後再試一次',
  })
})
