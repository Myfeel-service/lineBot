/**
 * 匯完知識後「試問一題」的判語（D-40 交棒卡）。
 *
 * 為什麼抽成純函式：這段的價值全在**答不出來時照實說**——報喜不報憂的話，
 * 使用者會帶著「已經學會了」的假安心離開，而客人隔天問到就是一句答不出來。
 * 判語寫在元件裡沒有東西守得住它，抽出來才測得到。
 *
 * ⛔ 三種「沒有」要分開講，下一步完全不同（見記憶：過濾掉東西要說得出丟了什麼）：
 *    - 逾時＝不知道學會沒有，不能說「沒學會」
 *    - 答不出來＝真的沒學會，要給下一步（補問法／看細節）
 *    - 試問本身失敗＝系統問題，跟知識沒關係，要講清楚「不影響已匯入的知識」
 */
export type KbVerifyTone = 'ok' | 'warn'

export interface KbVerifyOutcome {
  tone: KbVerifyTone
  text: string
}

export interface KbVerifyInput {
  /** 試問用的句子（會出現在判語裡讓人對得起來問了什麼） */
  query: string
  /** 後端試答結果；errored＝這支 API 本身沒跑成功 */
  timedOut?: boolean
  decision?: string
  errored?: boolean
}

export function kbVerifyOutcome({ query, timedOut, decision, errored }: KbVerifyInput): KbVerifyOutcome {
  if (errored)
    return { tone: 'warn', text: '試問沒跑成功（不影響已匯入的知識），稍後可到「測試對話」自己問一次。' }

  if (timedOut)
    return { tone: 'warn', text: '這次試問等太久沒有結果——不代表沒學會，可以再試一次，或到「測試對話」看細節。' }

  if (decision === 'answered')
    return { tone: 'ok', text: `答得出來 ✓ AI 已經會用這批知識回答「${query}」這類問題了。` }

  if (decision === 'disambiguate')
    return { tone: 'ok', text: '學會了。這題和既有內容相近，AI 會先問客人是指哪一個再回答。' }

  return {
    tone: 'warn',
    text: '知識已經進庫，但試問這題 AI 還答不出來——建議到那一條補上「客人可能怎麼問」，或到「測試對話」看細節。',
  }
}

/**
 * 試問要用哪一句：**優先拿客人問法**（那才是客人真的會打的句子），沒有就退回標題。
 * 跟知識庫頁存檔後的就地試答同一個判斷，不要各寫一套。
 */
export function pickKbVerifyQuery(
  chunks: ReadonlyArray<{ included?: boolean; title: string; questions?: string[] }>,
): string {
  const picked = chunks.filter(c => c.included !== false && c.title.trim())
  for (const c of picked) {
    const q = (c.questions ?? []).map(s => s.trim()).find(Boolean)
    if (q) return q
  }
  return picked[0]?.title.trim() ?? ''
}
