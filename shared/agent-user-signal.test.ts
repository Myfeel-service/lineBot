/**
 * 「使用者這句話，夠不夠決定要動什麼」（`C-192`）。
 *
 * 這兩個判斷是從 2026-09-16 的實測長出來的：
 * ① 助理問完「想先關閉哪一個？」，使用者回一個「做」，模型就自己挑了清單第一條。
 * ② 使用者一個數字都沒講，模型直接提議一組勿擾時段。
 * 兩題在 prompt 裡都早就寫了「⛔不要自己補」，照樣中——所以改成機制。
 */
import { describe, expect, it } from 'vitest'
import { broadcastAudienceIssue, broadcastTextIssue, clockFieldsChangedBeyondUserWords, hasNumberSignal, isBareAssent, userAuthoredTextIssue } from './agent-user-signal'

describe('只有同意、沒講要動哪一個', () => {
  it('🔴 實測踩到的那一句：「做」', () => {
    expect(isBareAssent('做')).toBe(true)
  })

  it('包著虛字也算：那就做吧／好了啦／就這樣吧', () => {
    for (const s of ['那就做吧', '好了啦', '就這樣吧', '嗯嗯', '好的！'])
      expect(isBareAssent(s), s).toBe(true)
  })

  it('把決定權丟回來的也要問，⛔不可以替他挑', () => {
    for (const s of ['都可以', '隨便', '你決定', '你看著辦'])
      expect(isBareAssent(s), s).toBe(true)
  })

  it('只剩標點或空白＝什麼都沒講', () => {
    for (const s of ['.', '。', '？？', '   '])
      expect(isBareAssent(s), s).toBe(true)
  })

  it('英文的同意詞', () => {
    for (const s of ['ok', 'OK!', 'yes', 'sure', 'go ahead', 'do it'])
      expect(isBareAssent(s), s).toBe(true)
  })

  it('⛔ 講清楚了要動哪一個就不可以擋——即使開頭有「好」', () => {
    for (const s of ['好，把查詢訂單關掉', '第二條', '把第二條關掉', '關掉更改地址', '改成 30 分鐘'])
      expect(isBareAssent(s), s).toBe(false)
  })

  it('⛔ 整句比對不是關鍵字包含：「好不好用」不是同意', () => {
    expect(isBareAssent('好不好用')).toBe(false)
  })
})

describe('有沒有講到數值', () => {
  it('🔴 實測踩到的那一句：「幫我設一下」的「一」不是數值', () => {
    expect(hasNumberSignal(['晚上太晚有人敲我 受不了 幫我設一下'])).toBe(false)
  })

  it('沒給數字的抱怨一律算沒講', () => {
    for (const s of ['晚上不要吵我', '客人等太久那個提醒 我覺得太慢了', '調短一點'])
      expect(hasNumberSignal([s]), s).toBe(false)
  })

  it('阿拉伯數字、中文數字＋單位都算講了', () => {
    for (const s of ['11點到早上9點', '晚上十一點到早上九點', '客人等超過十分鐘就提醒我', '改成兩倍快', '一個小時', '半小時'])
      expect(hasNumberSignal([s]), s).toBe(true)
  })

  it('⛔「幾點」是他在問，不是他給了值', () => {
    expect(hasNumberSignal(['要改成幾點？'])).toBe(false)
  })

  it('先前輪次他自己講過也算', () => {
    expect(hasNumberSignal(['晚上不要吵我', '11點到9點'])).toBe(true)
  })
})

/**
 * 2026-09-18 回歸實測：上一張卡是「勿擾 23:00–09:00」，使用者只說「剛剛那個改成早上十點」，
 * 出來的卻是「勿擾 **22:00**–10:00」——晚上那端被一起改了，而他從頭到尾沒提過晚上。
 */
describe('接續修改時，動到的時間格比他講的多', () => {
  const before = { mode: 'dnd', start: '23:00', end: '09:00' }

  it('🔴 他只講一個時間，兩端卻都變了 → 回報多動的那幾格', () => {
    const extra = clockFieldsChangedBeyondUserWords('剛剛那個改成早上十點', before, { mode: 'dnd', start: '22:00', end: '10:00' })
    expect(extra).toEqual(['start', 'end'])
  })

  it('只改他講的那一格 → 沒有多動', () => {
    expect(clockFieldsChangedBeyondUserWords('剛剛那個改成早上十點', before, { mode: 'dnd', start: '23:00', end: '10:00' })).toEqual([])
  })

  it('他講了兩個時間，兩端都變是對的', () => {
    expect(clockFieldsChangedBeyondUserWords('改成晚上十點到早上八點', before, { mode: 'dnd', start: '22:00', end: '08:00' })).toEqual([])
    expect(clockFieldsChangedBeyondUserWords('改成 22:00 到 08:00', before, { mode: 'dnd', start: '22:00', end: '08:00' })).toEqual([])
  })

  it('沒有上一張卡（不是接續修改）→ 不判', () => {
    expect(clockFieldsChangedBeyondUserWords('改成早上十點', undefined, { start: '10:00' })).toEqual([])
  })

  it('動的不是時間格（例如週末休不休）→ 不判', () => {
    expect(clockFieldsChangedBeyondUserWords('週末也要休息', before, { ...before, weekendOff: true })).toEqual([])
  })
})

/**
 * 推播草稿：客人會看到的字、發給誰，都要是使用者講過的（`D-116`，2026-10-08 實測）。
 * ① 節慶卡「幫我擬一則「國慶日」的推播草稿」→ 它自己寫「國慶日快樂！」、沒問就發全部 9,076 人
 * ② 「中秋節快到了，幫我弄個活動」→ 這句指令被原封不動當成推播內容
 */
describe('推播草稿的內容是不是他講的', () => {
  it('🔴 實測那一句：只講了節日，內容「國慶日快樂！」是它自己寫的 → 擋，叫它去問', () => {
    const issue = broadcastTextIssue('國慶日快樂！', ['幫我擬一則「國慶日」的推播草稿'])
    expect(issue).toContain('不是使用者講的')
    expect(issue).toContain('要跟客人說什麼')
  })

  it('🔴 實測那一句：把他對小幫手下的指令當成內容 → 擋（就算每個字都是他講的）', () => {
    const said = ['中秋節快到了，幫我弄個活動']
    expect(broadcastTextIssue('中秋節快到了，幫我弄個活動', said)).toContain('指令')
  })

  it('照他講的話寫（潤飾一下標點、加日期格式）→ 放行', () => {
    const said = ['連假 10/10–10/12 照常出貨，全館 9 折。發給全部']
    expect(broadcastTextIssue('連假 10/10–10/12 照常出貨，全館 9 折！', said)).toBeNull()
  })

  it('內容是前幾句講的也算（他先回答「要說什麼」，下一句才講發給誰）', () => {
    const said = ['幫我擬國慶日的推播', '連假照常出貨，全館九折', '發給全部好友']
    expect(broadcastTextIssue('連假照常出貨，全館九折', said)).toBeNull()
  })

  it('⛔ 他講了一點、它加了一大段促銷詞 → 擋', () => {
    const said = ['連假照常出貨']
    expect(broadcastTextIssue('連假照常出貨！把握機會，全館滿千再送精美好禮，數量有限送完為止', said)).not.toBeNull()
  })

  it('🔴 審查抓到：他口述的內容剛好有「幫忙」「推播」→ 照樣放行（以前怎麼重試都建不成）', () => {
    const said = ['內容寫：感謝大家幫忙，本週推播限定滿千送百，發給全部好友']
    expect(broadcastTextIssue('感謝大家幫忙，本週推播限定滿千送百', said)).toBeNull()
    expect(broadcastTextIssue('請大家幫忙轉發給朋友', ['內容：請大家幫忙轉發給朋友'])).toBeNull()
  })

  it('對小幫手下指令的說法照樣擋（中間有空白也一樣）', () => {
    for (const s of ['幫我擬一則國慶日的推播', '中秋節快到了，幫我弄個活動', '發一則推播給大家', '幫 我 寫 一則'])
      expect(broadcastTextIssue(s, [s]), s).toContain('指令')
  })
})

describe('知識卡答案／回覆字是不是他講的（userAuthoredTextIssue）', () => {
  it('🔴 佔位句「請提供正確的運費資訊。」不是他講的 → 擋', () => {
    expect(userAuthoredTextIssue('請提供正確的運費資訊。', ['有客人問運費，AI 回的價格是錯的'], '要回答的內容', '正確答案')).toContain('不可以用「請提供…」')
  })

  it('他講的答案（哪怕只有兩個字）→ 放行', () => {
    expect(userAuthoredTextIssue('不行', ['新增一個常見問題：可以寄到國外嗎？不行'], '要回答的內容', '正確答案')).toBeNull()
  })
})

describe('推播草稿發給誰是不是他講的', () => {
  it('🔴 沒講對象 → 擋：⛔ 不可以自己選全部好友', () => {
    const issue = broadcastAudienceIssue(undefined, ['幫我擬一則國慶日的推播', '連假照常出貨'])
    expect(issue).toContain('還沒講要發給誰')
  })

  it('講了「全部／所有人／大家」→ 放行', () => {
    for (const s of ['發給全部', '所有好友都發', '發給大家', '全體會員', '所有人', 'send to everyone'])
      expect(broadcastAudienceIssue(undefined, [s]), s).toBeNull()
  })

  it('被問「發給全部還是某個標籤」只回一兩個字 → 放行', () => {
    for (const s of ['全部', '大家', '全部吧', '都發'])
      expect(broadcastAudienceIssue(undefined, ['幫我擬推播：連假照常出貨', s]), s).toBeNull()
  })

  it('🔴 審查抓到：「大家」「所有」只出現在推播內容裡、沒講發給誰 → 擋（以前預設發給全部好友）', () => {
    const said = ['幫我擬一則推播：大家好！週年慶所有商品八折']
    expect(broadcastAudienceIssue(undefined, said, '大家好！週年慶所有商品八折')).toContain('還沒講要發給誰')
    // 沒把內容傳進來也一樣擋：「大家好」「所有商品」不是講對象的說法
    expect(broadcastAudienceIssue(undefined, said)).toContain('還沒講要發給誰')
    // 內容裡有「所有會員享八折」：扣掉內容之後就沒有講對象了
    expect(broadcastAudienceIssue(undefined, ['擬推播：所有會員享八折'], '所有會員享八折')).toContain('還沒講要發給誰')
  })

  it('⛔ 英文單字裡的 all（small、mall、call）不算', () => {
    expect(broadcastAudienceIssue(undefined, ['新品上市 small size 現貨，mall 也有'])).toContain('還沒講要發給誰')
  })

  it('標籤要是他講過的名字；它自己挑的 → 擋', () => {
    expect(broadcastAudienceIssue('VIP', ['只發給 VIP'])).toBeNull()
    expect(broadcastAudienceIssue('VIP', ['發給老客人'])).toContain('沒有講過「VIP」')
  })
})
