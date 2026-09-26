/**
 * 每日摘要的文案與排版已搬到 `shared/daily-digest-message.ts`（2026-09-27 `C-270`）：
 * 後台「設定 → LINE 通知」的手機預覽要畫出同一則，⛔ 不另寫一份。
 * 這支只轉出，排程與舊測試的 import 不用改。改文案請改 shared 那一支。
 * ⚠️ 用相對路徑：Nitro 自動匯入掃 server/utils 時解析不了 `~~` 別名（會警告 skip scanning）。
 */
export * from '../../shared/daily-digest-message'
