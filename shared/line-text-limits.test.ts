import { describe, expect, it } from 'vitest'
import {
  LINE_BUTTONS_TEMPLATE_TEXT_MAX,
  LINE_TEXT_MESSAGE_MAX,
  lineTextLimit,
  lineTextOverflowMessage,
  measureLineText,
  messageHasButtons,
  truncateLineText,
} from './line-text-limits'

/**
 * 真實案例（`H-27`）：鼴究室「飛利浦AC0510｜預熱」那則推播的原文。
 * 276 字、掛一顆按鈕，實際發出去時被切在「這台是飛利浦史上最小的空氣清淨機／體積」。
 * 這一段是從正式資料（linebot-e8dda）撈出來的原文，改壞了測試就會紅。
 */
const REAL_BROADCAST_TEXT = `感謝大家的熱情敲碗與等待 🩵
飛利浦個人空氣清淨機（AC0510）
將於明晚 9 點在嘖嘖正式上市啦 🎊

提前公布問卷專屬 VIP 的折扣碼 ⚠️
AC200（大小寫都可以）
AC200（大小寫都可以）
AC200（大小寫都可以）
輸入「AC200」即可再折 $200 元

這台是飛利浦史上最小的空氣清淨機
體積很小，但規格一點也不簡單！

■ 最適合桌面使用的清淨範圍
■ 迷你體積，放在桌上不佔位
■ 三層 NanoProtect HEPA 奈米級濾淨
■ 搭載活性碳濾網除去異味
■ 最低僅 12dB 的專注模式
■ 長效濾網，3 年一換`

describe('上限本身：掛按鈕就從 5000 掉到 160', () => {
  it('沒按鈕 5000、有按鈕 160', () => {
    expect(lineTextLimit(false)).toBe(LINE_TEXT_MESSAGE_MAX)
    expect(lineTextLimit(true)).toBe(LINE_BUTTONS_TEMPLATE_TEXT_MAX)
  })

  it('空的 buttons 陣列不算有按鈕（否則只是把按鈕刪光的訊息會被誤判成 160 上限）', () => {
    expect(messageHasButtons({ buttons: [] })).toBe(false)
    expect(messageHasButtons({})).toBe(false)
    expect(messageHasButtons(null)).toBe(false)
    expect(messageHasButtons({ buttons: [{ type: 'uri' }] })).toBe(true)
  })
})

describe('真實那則推播：量得出「客人收到什麼、丟了什麼」', () => {
  const measure = measureLineText(REAL_BROADCAST_TEXT, true)

  it('原文 276 字、上限 160、超出 116 字', () => {
    expect(measure.length).toBe(276)
    expect(measure.limit).toBe(160)
    expect(measure.overflow).toBe(116)
    expect(measure.willTruncate).toBe(true)
  })

  it('客人看得到的最後一句正是「體積」——與 LINE 上實際被切的位置相同', () => {
    expect(measure.kept.endsWith('這台是飛利浦史上最小的空氣清淨機\n體積')).toBe(true)
  })

  it('被丟掉的是六條產品規格，而且拿得到、可以顯示給人看', () => {
    expect(measure.dropped.startsWith('很小，但規格一點也不簡單！')).toBe(true)
    expect(measure.dropped).toContain('■ 長效濾網，3 年一換')
    // ⛔ 丟掉的東西必須說得出來，不能只回一個布林值
    expect(measure.kept + measure.dropped).toBe(REAL_BROADCAST_TEXT)
  })

  it('同一則文字若把按鈕拿掉就一字不缺（＝上限是被按鈕帶下來的，不是文字太長）', () => {
    const noButtons = measureLineText(REAL_BROADCAST_TEXT, false)
    expect(noButtons.willTruncate).toBe(false)
    expect(noButtons.dropped).toBe('')
  })
})

describe('剛好卡在邊界', () => {
  it('160 字整不算超出（用 > 不是 >=，差一個字就是誤擋）', () => {
    const exactly = 'a'.repeat(160)
    const m = measureLineText(exactly, true)
    expect(m.willTruncate).toBe(false)
    expect(m.overflow).toBe(0)
    expect(m.kept).toBe(exactly)
  })

  it('161 字就要擋，且只丟一個字', () => {
    const m = measureLineText('a'.repeat(161), true)
    expect(m.willTruncate).toBe(true)
    expect(m.overflow).toBe(1)
    expect(m.dropped).toBe('a')
  })

  it('空字串／undefined 不會炸', () => {
    expect(measureLineText('', true).willTruncate).toBe(false)
    expect(measureLineText(undefined as unknown as string, true).length).toBe(0)
  })
})

describe('emoji 不可以被切成半個', () => {
  /**
   * emoji 佔 2 個 UTF-16 格。若上限剛好落在 emoji 中間，硬切會留下半個代理對＝亂碼字元。
   * ⛔ 這裡退一格寧可少一格也不要送出亂碼。
   */
  it('上限落在 emoji 中間時退一格，切出來的字串不含孤兒代理對', () => {
    const text = 'a'.repeat(159) + '🎊' + 'b'
    const m = measureLineText(text, true)
    expect(m.kept).toBe('a'.repeat(159))
    expect(m.kept.length).toBe(159)
    // 沒有落單的高位代理
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(m.kept)).toBe(false)
    expect(m.dropped).toBe('🎊b')
    expect(m.kept + m.dropped).toBe(text)
  })

  it('emoji 完整落在上限內就照常保留', () => {
    const text = 'a'.repeat(158) + '🎊' + 'b'
    const m = measureLineText(text, true)
    expect(m.kept).toBe('a'.repeat(158) + '🎊')
    expect(m.dropped).toBe('b')
  })
})

describe('送出端與預覽端切在同一格', () => {
  it('truncateLineText 的結果就是 measureLineText 的 kept', () => {
    for (const text of [REAL_BROADCAST_TEXT, 'a'.repeat(159) + '🎊b', '短短一句', '']) {
      expect(truncateLineText(text, LINE_BUTTONS_TEMPLATE_TEXT_MAX))
        .toBe(measureLineText(text, true).kept)
    }
  })
})

describe('擋下來時給人看的那句話', () => {
  it('有按鈕：說得出現在幾字、要刪幾字，以及「拿掉按鈕就能寫長文」這條出路', () => {
    const msg = lineTextOverflowMessage(measureLineText(REAL_BROADCAST_TEXT, true))
    expect(msg).toContain('160')
    expect(msg).toContain('目前 276 字')
    expect(msg).toContain('請刪掉 116 字')
    expect(msg).toContain('把按鈕移除')
  })

  it('沒按鈕（超過 5000）不會叫人去移除按鈕——那是句廢話', () => {
    const msg = lineTextOverflowMessage(measureLineText('a'.repeat(5001), false))
    expect(msg).toContain('5000')
    expect(msg).not.toContain('把按鈕移除')
  })
})
