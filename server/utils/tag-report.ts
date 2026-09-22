/**
 * 客群分析報告的「產生－存檔－沿用」（`D-28` 鐵律①）。
 *
 * 沿用 `takeoverSummary` 的形狀：**按需產生、產生完存起來、下次直接沿用**。
 * ⛔ 不是每次開頁重算——一份報告約三四千次 Firestore 讀取＋一次 LLM，
 *   掛在開頁上就是 08-11 讀取費暴衝重演。
 *
 * 擺法：頂層集合 `tagReports`、doc id = workspaceId，只留**最新一份**。
 * ⛔ 刻意不存歷史版本：Phase 1 沒有任何畫面讀得到歷史，寫進去就是沒人讀的資料
 *   （要做「上個月 vs 這個月」是 Phase 2 的趨勢層，那時再連同口徑一起設計）。
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { generateText, runWithLlmBudget } from '~~/server/utils/gemini'
import { computeTagInsights } from '~~/server/utils/tag-insights-compute'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { storeProfileForPrompt } from '~~/shared/types/store-profile'
import {
  buildTagSummaryPrompt,
  isTooThinForSummary,
  rejectTagSummary,
  TAG_SUMMARY_MAX,
  type TagInsightsPayload,
  type TagReportDoc,
  type TagSummarySkip,
} from '~~/shared/tag-report'

export const TAG_REPORT_COLLECTION = 'tagReports'

/** 讀最近一份報告；沒有就回 `null`（＝還沒產生過，⛔ 不是「沒有資料」） */
export async function getTagReport(db: Firestore, workspaceId: string): Promise<TagReportDoc | null> {
  const snap = await db.collection(TAG_REPORT_COLLECTION).doc(workspaceId).get()
  if (!snap.exists) return null
  const d = snap.data() as Partial<TagReportDoc> | undefined
  if (!d?.payload || !d.generatedAtMs) return null
  return {
    generatedAtMs: Number(d.generatedAtMs),
    generatedBy: String(d.generatedBy ?? ''),
    payload: d.payload as TagInsightsPayload,
    summary: String(d.summary ?? ''),
    summarySkip: (d.summarySkip ?? null) as TagSummarySkip | null,
  }
}

/**
 * 產生一份新的報告並存檔。
 *
 * ⛔ **冷卻由呼叫端（端點）判斷**，這支一被呼叫就是真的要算——
 *   把閘門放在這裡會讓「強制重算」之類的需求偷偷繞過去。
 */
export async function generateTagReport(
  db: Firestore,
  workspaceId: string,
  generatedBy: string,
): Promise<TagReportDoc> {
  const payload = await computeTagInsights(db, workspaceId)

  let summary = ''
  let summarySkip: TagSummarySkip | null = null

  if (isTooThinForSummary(payload)) {
    // 鐵律③：薄資料整段不出現，⛔ 不硬生一句「建議多累積資料」
    summarySkip = 'too_thin'
  }
  else {
    try {
      // 輪廓有的話帶一句進去，總結才講得出「你賣的東西」；沒有也能寫
      const profile = await getStoreProfile(workspaceId, db).catch(() => null)
      const storeLine = profile ? storeProfileForPrompt(profile).split('\n').join('；') : ''

      const res = await runWithLlmBudget(workspaceId, () =>
        generateText(buildTagSummaryPrompt(payload, storeLine), {
          // 這是把數字翻成人話，不是創作：溫度壓低
          temperature: 0.2,
          maxOutputTokens: 900,
          thinkingBudget: 0,
        }))
      const text = String(res.text ?? '').trim().slice(0, TAG_SUMMARY_MAX * 2)
      const bad = rejectTagSummary(text, payload)
      if (bad) {
        // 鐵律②：一段話裡有一個假數字，其他句的可信度也一起沒了 → 整段退掉
        console.warn('[tag-report] 總結沒通過檢查：', workspaceId, bad, text.slice(0, 120))
        summarySkip = 'rejected'
      }
      else {
        summary = text
      }
    }
    catch (e) {
      // ⛔ 生成失敗不可以讓整份報告不見：數字是程式算的，本來就不受影響
      console.warn('[tag-report] 總結生成失敗：', workspaceId, e)
      summarySkip = 'llm_failed'
    }
  }

  const doc: TagReportDoc = { generatedAtMs: Date.now(), generatedBy, payload, summary, summarySkip }
  await db.collection(TAG_REPORT_COLLECTION).doc(workspaceId).set({
    ...doc,
    workspaceId,
    updatedAt: FieldValue.serverTimestamp(),
  })
  return doc
}
