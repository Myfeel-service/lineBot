/**
 * 本機 Nitro scheduledTasks 的總閘門。
 *
 * 生產環境的維護輪一律走 `/api/cron/run-tasks`（Cloud Scheduler 每 10 分鐘）——Amplify
 * 的 aws-amplify preset **不會把 Nitro tasks 打包進 compute bundle**，所以 server/tasks/*
 * 實際上只會在本機 `nuxt dev` 執行。
 *
 * 問題是 dev 讀的是 `.env`，那是**正式** Firestore 憑證與**正式** LINE channel token：
 * 筆電上開著 `npm run dev`，就等於替正式環境多開一個排程執行者，會真的動正式資料、
 * 真的推播給客服與客人，而且與 Cloud Scheduler 同輪 → 同一件事做兩次。
 *
 * 2026-08-07 現場：客服收到的「真人客服請求（已等超過 30 分鐘沒人接手）」每則都收到兩份，
 * 就是本機 dev 的 `conversation:handoff-sla` 與 Cloud Scheduler 同時跑造成的。
 * （SLA 提醒本身另外加了 Firestore 交易認領，重複執行也只會發一則；這個閘門是更上游的一層：
 *  排程推播、自動交還機器人、LLM 重切卡等工作沒有全部都有那種保護，而且花的是真的錢。）
 *
 * 預設關閉。要在本機驗排程行為時才設 `LOCAL_SCHEDULED_TASKS=true`，
 * 並請先確認 `.env` 指向測試租戶而不是正式租戶。
 */
export function localScheduledTasksEnabled(): boolean {
  return String(process.env.LOCAL_SCHEDULED_TASKS ?? '').trim().toLowerCase() === 'true'
}

/**
 * 未開啟時 defineTask.run() 的統一回傳（讓 dev log 看得出是被閘門擋掉，不是壞掉）。
 * 刻意標成寬鬆型別：defineTask 的回傳型別會被第一個 return 釘住，用 `as const`
 * 會讓各 task 真正的 result 型別對不上。
 */
export const LOCAL_SCHEDULED_TASK_SKIPPED: Record<string, unknown> = {
  skipped: 'LOCAL_SCHEDULED_TASKS 未設為 true：本機排程已停用，避免對正式資料重複執行',
}
