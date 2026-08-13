/**
 * 是否跑在 Lambda（Amplify 的 SSR compute）上。
 *
 * 為什麼要判斷：Lambda 沒有長駐進程——**回應一送出，執行環境就被凍結**。
 * 所以以下兩種寫法在 Lambda 上都會把工作做死在半路：
 *   1. `setInterval` / croner 這類計時器（只在剛好有請求在處理時才醒得來）
 *   2. middleware 裡「不 await 就回應」的 fire-and-forget 背景工作
 *      （連 `.finally()` 都不會執行 → 用來防重入的旗標永遠卡在 true，
 *        那個容器之後再也不會做這件事）
 *
 * 2026-08-12 排程推播整批沒送出就是第 2 種：推播被認領成「發送中」之後凍死，
 * 永遠停在那個狀態（見 docs/STATUS.md `A-10`）。
 * 需要保證跑完的定期工作，一律走「等得到結果」的路：外部排程（Cloud Scheduler）
 * 打一支 API，或前端輪詢打一支 API。
 */
export function isLambdaRuntime(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT)
}
