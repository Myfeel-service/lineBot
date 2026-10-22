import { describe, expect, it } from 'vitest'
import { displayTokenFor, toDisplayText, toStoredText, toBracketText, VAR_TOKEN_EDGE, variableLabel, variableSegments, variableTokenRanges } from './variable-tokens'

const NAME = displayTokenFor('displayName')

describe('客人資料變數：存的格式 ↔ 輸入框裡的膠囊（`D-128`）', () => {
  it('{{displayName}} 顯示成膠囊「LINE 名稱」，換回來是原樣', () => {
    const stored = 'Hi {{displayName}}\n\n恭喜你成功登記專屬開賣優惠通知！'
    const display = toDisplayText(stored)
    expect(display).toBe(`Hi ${NAME}\n\n恭喜你成功登記專屬開賣優惠通知！`)
    expect(display).not.toContain('{{')
    expect(toStoredText(display)).toBe(stored)
  })

  it('舊資料裡有空白的寫法（{{ displayName }}）也認得；換回來統一成沒空白的', () => {
    expect(toStoredText(toDisplayText('{{ displayName }}您好'))).toBe('{{displayName}}您好')
  })

  it('收集到的欄位（phone）膠囊上寫欄位名，來回一樣', () => {
    const stored = '電話 {{phone}} 已收到，{{displayName}}'
    expect(toStoredText(toDisplayText(stored))).toBe(stored)
    expect(toDisplayText(stored)).toContain(`${VAR_TOKEN_EDGE}phone${VAR_TOKEN_EDGE}`)
  })

  it('自己打「［LINE 名稱］」或「[LINE名稱]」＝插入名字；打 {{displayName}} 也算', () => {
    expect(toStoredText('［LINE 名稱］你好')).toBe('{{displayName}}你好')
    expect(toStoredText('[LINE名稱]你好')).toBe('{{displayName}}你好')
    expect(toStoredText('{{displayName}} 你好')).toBe('{{displayName}} 你好')
  })

  it('⛔ 括號裡不是已知的名稱＝照原字（「［SALE］」是要客人看到這幾個字，當成變數會送出空白）', () => {
    expect(toStoredText('［SALE］今晚結束')).toBe('［SALE］今晚結束')
    expect(toStoredText('［phone］')).toBe('［phone］')
    // 這一頁收集得到 phone 才算
    expect(toStoredText('［phone］', 'send', ['phone'])).toBe('{{phone}}')
  })

  it('⛔ 模組（send）只認英文變數名：中文的 {{姓名}} 送出端不換，這裡也不顯示成膠囊；自動回應（script）才認', () => {
    expect(toDisplayText('{{姓名}} 您好')).toBe('{{姓名}} 您好')
    const script = toDisplayText('{{姓名}} 您好', 'script')
    expect(script).toBe(`${VAR_TOKEN_EDGE}姓名${VAR_TOKEN_EDGE} 您好`)
    expect(toStoredText(script, 'script')).toBe('{{姓名}} 您好')
  })

  it('刪掉一半的膠囊（選一段剪掉）：剩下的字當一般文字，邊界字元不留', () => {
    const display = `Hi ${NAME}`
    const half = display.slice(0, display.length - 3)
    const stored = toStoredText(half)
    expect(stored).not.toContain(VAR_TOKEN_EDGE)
    expect(stored.startsWith('Hi LINE')).toBe(true)
  })

  it('膠囊的位置：游標跳過、退格整顆刪掉用', () => {
    const display = `Hi ${NAME}，${toDisplayText('{{phone}}')}`
    const ranges = variableTokenRanges(display)
    expect(ranges.map(r => r.key)).toEqual(['displayName', 'phone'])
    expect(display.slice(ranges[0]!.start, ranges[0]!.end)).toBe(NAME)
  })

  it('不是字串（表單還沒填）照原樣回、不丟錯', () => {
    expect(toDisplayText(undefined as unknown as string)).toBeUndefined()
    expect(toStoredText(undefined as unknown as string)).toBeUndefined()
    expect(variableTokenRanges(undefined as unknown as string)).toEqual([])
  })
})

describe('自動回應的常用欄位：膠囊上講中文、存的照舊（`D-138`④）', () => {
  const ORDER = `${VAR_TOKEN_EDGE}訂單編號${VAR_TOKEN_EDGE}`

  it('{{order_id}} 顯示成「訂單編號」，換回來是原樣（不露出 order_id）', () => {
    const stored = '已收到您的訂單 {{order_id}}，電話 {{phone}}'
    const display = toDisplayText(stored, 'script')
    expect(display).toBe(`已收到您的訂單 ${ORDER}，電話 ${VAR_TOKEN_EDGE}電話${VAR_TOKEN_EDGE}`)
    expect(display).not.toContain('order_id')
    expect(toStoredText(display, 'script', ['order_id', 'phone'])).toBe(stored)
  })

  it('自己打［訂單編號］也算（這一頁收得到 order_id 時）', () => {
    expect(toStoredText('編號是［訂單編號］', 'script', ['order_id'])).toBe('編號是{{order_id}}')
  })

  it('⛔ 店家自己把欄位取名叫「訂單編號」（中文名）→ 換回它自己，不被當成 order_id', () => {
    const stored = '已收到 {{訂單編號}}'
    const display = toDisplayText(stored, 'script')
    expect(toStoredText(display, 'script', ['訂單編號'])).toBe(stored)
  })

  it('⛔ 模組／推播（send 模式）不換：那邊送出端只認英文 key，照舊顯示欄位名', () => {
    expect(toDisplayText('{{order_id}}')).toBe(`${VAR_TOKEN_EDGE}order_id${VAR_TOKEN_EDGE}`)
  })
})

describe('只看不改的地方：存的格式切成字／變數幾段（小幫手確認卡）', () => {
  it('{{order_id}} 切成一段「訂單編號」，前後的字原樣；接起來不露出程式碼', () => {
    const segs = variableSegments('已收到您的訂單 {{order_id}}，{{displayName}} 謝謝您', 'script')
    expect(segs).toEqual([
      { text: '已收到您的訂單 ' },
      { text: '訂單編號', key: 'order_id' },
      { text: '，' },
      { text: variableLabel('displayName'), key: 'displayName' },
      { text: ' 謝謝您' },
    ])
    expect(segs.map(s => s.text).join('')).not.toMatch(/\{\{|order_id/)
  })

  it('講給店家聽用括號寫（［訂單編號］），他照抄回來換得回變數', () => {
    const stored = '已收到您的訂單 {{order_id}}，謝謝您'
    const said = toBracketText(stored, 'script')
    expect(said).toBe('已收到您的訂單 ［訂單編號］，謝謝您')
    expect(toStoredText(`${said}，請先填表單：https://example.com/f`, 'script', ['order_id']))
      .toBe('已收到您的訂單 {{order_id}}，謝謝您，請先填表單：https://example.com/f')
  })

  it('沒有變數就是整段一段；send 模式不認中文欄位（跟送出端同一條規則）', () => {
    expect(variableSegments('先填表單', 'script')).toEqual([{ text: '先填表單' }])
    expect(variableSegments('{{訂單編號}}', 'send')).toEqual([{ text: '{{訂單編號}}' }])
    expect(variableSegments(undefined as unknown as string)).toEqual([])
  })
})
