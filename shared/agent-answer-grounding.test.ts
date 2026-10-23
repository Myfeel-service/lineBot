import { describe, expect, it } from 'vitest'
import { answerGroundingIssue, groundingToolToRun } from './agent-answer-grounding'

const ok = (p: Parameters<typeof answerGroundingIssue>[0]) => answerGroundingIssue(p) === null

describe('answerGroundingIssue（沒查就講的回答要退回去）', () => {
  it('🔴 一個工具都沒查卻報數字 → 擋下來，訊息要講「先去查」', () => {
    const issue = answerGroundingIssue({
      text: '這個月 AI 總共回覆了 123 則訊息，其中有 45 次轉給真人客服處理。',
      sources: ['這個月 AI 花了我多少錢？'],
      calledTools: [],
    })
    expect(issue).toContain('123')
    expect(issue).toContain('先用對應的工具查')
  })

  it('數字在工具結果裡找得到 → 放行', () => {
    expect(ok({
      text: '這個月用了 110 則。',
      sources: ['get_plan_quota({}) → {"used":110,"unlimited":true}'],
      calledTools: ['get_plan_quota'],
    })).toBe(true)
  })

  it('使用者自己講過的數字 → 放行（⛔覆述他的話不算編造）', () => {
    expect(ok({
      text: '你說的是把提醒改成 30 分鐘對嗎？',
      sources: ['幫我把提醒改成 30 分鐘'],
      calledTools: [],
    })).toBe(true)
  })

  it('提示裡給過的日期 → 放行（2026-09 不是它編的）', () => {
    expect(ok({
      text: '這是 2026-09 的數字。',
      sources: ['get_ai_usage({}) → {"month":"2026-09"}', '2026-09-18', '2026-09'],
      calledTools: ['get_ai_usage'],
    })).toBe(true)
  })

  /**
   * `E-40`（2026-10-18）：日期原本跟其他出處混在一起。10/18 那天模型沒查就講「現在是 09:00–18:00」，
   * 18 撞到今天、09 撞到上個月 → 整句被當成有出處放行，單元測試就在那天紅了。
   */
  describe('提示裡的日期只能證明「寫成日期的數字」', () => {
    const dateSources = ['2026-10-18', '2026-10-17', '2026-10-10', '2026-10-11', '2026-10', '2026-09']

    it('🔴 10/18 憑空講「現在是 09:00–18:00」→ 擋（18、09 撞到日期不算出處）', () => {
      const issue = answerGroundingIssue({ text: '現在是 09:00–18:00，你要改成幾點？', sources: ['晚上太晚有人敲我 幫我設一下'], dateSources, calledTools: [] })
      expect(issue).toContain('18')
    })

    it('寫成日期的照樣放行：2026-10-18、10/11–10/17、9 月、18 號', () => {
      for (const text of ['今天是 2026-10-18。', '上週是 10/11–10/17。', '上個月（9 月）的數字我去查。', '今天 18 號。']) {
        expect(ok({ text, sources: [], dateSources, calledTools: [] }), text).toBe(true)
      }
    })

    it('同一個數字有真的出處就放行（工具查到 18 則）', () => {
      expect(ok({ text: '今天有 18 則。', sources: ['get_ai_usage({}) → {"answered":18}'], dateSources, calledTools: ['get_ai_usage'] })).toBe(true)
    })
  })

  /** ⛔ 這句誤擋的代價最大：它是**每一次拒絕批次**都會講的話 */
  it('⛔ 不可以誤擋「我一次只能處理一個」這種話', () => {
    expect(ok({
      text: '我一次只能處理一件事，請問您要先做哪一個？',
      sources: [],
      calledTools: [],
    })).toBe(true)
  })

  it('🔴 沒查異常卻說「沒有要處理的」→ 擋下來', () => {
    const issue = answerGroundingIssue({
      text: '目前沒有需要處理的異常狀況。',
      sources: ['get_ai_usage({}) → {"invocations":236}'],
      calledTools: ['get_ai_usage'],
    })
    expect(issue).toContain('get_current_alerts')
  })

  it('查過異常再說「沒有異常」→ 放行', () => {
    expect(ok({
      text: '目前沒有異常。',
      sources: ['get_current_alerts({}) → []'],
      calledTools: ['get_current_alerts'],
    })).toBe(true)
  })

  it('空回答不判（那條路有自己的罐頭句）', () => {
    expect(ok({ text: '   ', sources: [], calledTools: [] })).toBe(true)
  })

  // `D-116`（2026-10-08 實測）：數字那道擋不到文字——它沒查就說「AI 的語氣目前設定為『專業簡潔』」（其實是自己寫的指示），
  // 「晚上不要吵我」沒查就問「勿擾要幾點到幾點」（其實本來就設好了）
  it('🔴 沒查設定就講 AI 設定的現況 → 擋下來，叫它先查', () => {
    const issue = answerGroundingIssue({ text: 'AI 的語氣目前設定為「專業簡潔」，要換嗎？', sources: [], calledTools: [] })
    expect(issue).toContain('get_ai_settings')
  })

  it('🔴 沒查設定就反問「勿擾要幾點到幾點」→ 也要擋（先講現在是多少）', () => {
    expect(answerGroundingIssue({ text: '請問您希望勿擾時段從幾點到幾點呢？', sources: [], calledTools: [] })).toContain('get_ai_settings')
  })

  it('查過設定再講 → 放行', () => {
    expect(ok({ text: '已經是這樣了：服務時間以外就是勿擾時段，你不會被吵。', sources: [], calledTools: ['get_ai_settings'] })).toBe(true)
  })

  it('🔴 把服務時間講成 AI 的上班時間 → 擋（兩輪實測都中：「目前 AI 自動回覆的服務時間設定為…」）', () => {
    const say = (text: string) => answerGroundingIssue({ text, sources: [], calledTools: ['get_ai_settings'] })
    expect(say('目前 AI 自動回覆的服務時間設定為平日白天，週末是勿擾時段')).toContain('不是 AI 的上班時間')
    expect(say('勿擾時段 AI 不會回客人')).toContain('不是 AI 的上班時間')
    // 對的講法不擋
    expect(say('服務時間以外是勿擾時段，AI 在服務時間以外照常回答。')).toBeNull()
  })

  it('⛔ 講對話統計的「等太久」不算設定話題（收了會一直白查一次）', () => {
    expect(ok({ text: '昨天有客人等太久才有人回，要不要去看看？', sources: [], calledTools: ['get_conversation_stats'] })).toBe(true)
  })

  // 2026-10-22 實測原句：沒查就編了一句「現在的回覆」
  it('🔴 沒查自動回應就引用「現在回給客人的話」→ 擋下來，叫它先查 list_scripts', () => {
    const made = '目前「退換貨」這條自動回應的回覆內容是：\n「您好，關於退換貨問題，請參考我們的退換貨政策：[連結]」\n\n請問你希望客人收到哪一句完整的訊息？'
    expect(answerGroundingIssue({ text: made, sources: [], calledTools: [] })).toContain('list_scripts')
    // 查過再引用：放行（同一天實測的好例子）
    expect(ok({ text: '「退換貨查詢」這條自動回應目前回給客人的話是：「已收到您的訂單 ［訂單編號］，謝謝您」。請問你要改成什麼內容呢？', sources: [], calledTools: ['list_scripts'] })).toBe(true)
  })

  // `D-151` 第三輪實測原句；老闆 10-22：「我們做這個流程不是就是為了讓大家在 LINE 上面完成嗎」
  it('🔴 叫他把客人帶去外面填表單 → 擋下來，改成在 LINE 上一題一題問；⚠️ 網址是他自己給的不擋', () => {
    const out = '請問這條自動回應要讓客人填什麼表單？以及表單的連結是什麼？我會幫你建立一條自動回應，讓客人在對話中點擊連結填寫表單。'
    expect(answerGroundingIssue({ text: out, sources: [], calledTools: [], userTexts: ['建一條自動回應讓客人先填表單'] })).toContain('在 LINE 上')
    expect(answerGroundingIssue({ text: out, sources: [], calledTools: [], userTexts: ['回覆改成請填寫保固登錄表單：https://example.com/w'] })).toBeNull()
    // 不是在叫人去外面填的：照常
    expect(ok({ text: '要客人留哪些資料？我幫你擬一條自動回應，客人直接在 LINE 上一題一題回答，不用另外做表單。', sources: [], calledTools: [] })).toBe(true)
  })

  // `C-395` code review：它照提示講「不用去填表單或點連結」、或講新的回覆要改成什麼，也被退回，把唯一一次退回用掉
  it('🔴 否定句、講「新的回覆是」：⛔ 不擋；同一段裡另一句真的叫人去外面填的照擋', () => {
    expect(ok({ text: '客人不用去填表單或點連結，直接在 LINE 上回答就好。', sources: [], calledTools: [] })).toBe(true)
    expect(ok({ text: '不需要另外做問卷連結，我幫你在這條多問一題。', sources: [], calledTools: [] })).toBe(true)
    expect(answerGroundingIssue({ text: '不用改流程。請把表單的連結貼給客人點擊填寫。', sources: [], calledTools: [], userTexts: [] })).toContain('在 LINE 上')

    expect(ok({ text: '好的，新的回覆是「已收到，我們會盡快處理」，你確認一下。', sources: [], calledTools: [] })).toBe(true)
    expect(ok({ text: '改成的回覆是：「請先拍照」，對嗎？', sources: [], calledTools: [] })).toBe(true)
    expect(groundingToolToRun({ text: '新的回覆是「已收到」', calledTools: [] })).toBeNull()
    // 講現在那句的照擋
    expect(answerGroundingIssue({ text: '這條現在的回覆是「您好」。', sources: [], calledTools: [] })).toContain('list_scripts')
  })

  // `D-151`（2026-10-23）：只退回不夠——「改提醒時間」被退回之後它照樣不查，第二次的「目前是 0 分鐘」就放行了
  it('被退回時該查卻沒查的那一支：系統替它查（設定／自動回應／異常）', () => {
    expect(groundingToolToRun({ text: '請問提醒時間要改成幾分鐘？目前是 0 分鐘', calledTools: [] })).toBe('get_ai_settings')
    expect(groundingToolToRun({ text: '目前這條的回覆內容是：「您好」', calledTools: [] })).toBe('list_scripts')
    expect(groundingToolToRun({ text: '目前沒有異常', calledTools: [] })).toBe('get_current_alerts')
    expect(groundingToolToRun({ text: '請問提醒時間要改成幾分鐘？', calledTools: ['get_ai_settings'] })).toBeNull()
    expect(groundingToolToRun({ text: '好的', calledTools: [] })).toBeNull()
  })
})
