import { describe, expect, it } from 'vitest'
import { resolveKnowledgeFile } from './knowledge-file-types'

/**
 * 伺服器端判斷檔案種類（`C-296` 審查）：有副檔名只看副檔名，沒有才看型別、而且要一模一樣。
 * ⛔ 以前是「副檔名認不得 → 看型別裡有沒有 excel／pdf 這幾個字」：`x.html` 配上
 *    `text/html; excel` 就被當成 Excel 收進來，原檔還用 text/html 存進我們的雲端。
 */
describe('resolveKnowledgeFile', () => {
  it('⛔ 認不得的副檔名一律不收，型別寫什麼都一樣', () => {
    expect(resolveKnowledgeFile('x.html', 'text/html; excel')).toBeNull()
    expect(resolveKnowledgeFile('x.html', 'application/pdf')).toBeNull()
    expect(resolveKnowledgeFile('x.exe', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBeNull()
  })

  it('認得的副檔名：種類、存檔副檔名與型別都從我們的表來（不管瀏覽器說什麼）', () => {
    expect(resolveKnowledgeFile('退換貨.docx', 'text/html')).toEqual({
      kind: 'docx',
      ext: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
  })

  it('大寫副檔名照收；HEIC 瀏覽器常常給空的型別也照收', () => {
    expect(resolveKnowledgeFile('價目表.HEIC', '')).toEqual({ kind: 'image', ext: 'heic', mime: 'image/heic' })
    expect(resolveKnowledgeFile('說明書.PDF', '')).toMatchObject({ kind: 'pdf', ext: 'pdf' })
  })

  it('沒有副檔名：型別要一模一樣才收（去掉 ; 後面的參數、大小寫不拘），存檔時補上副檔名', () => {
    expect(resolveKnowledgeFile('說明書', 'application/pdf')).toEqual({ kind: 'pdf', ext: 'pdf', mime: 'application/pdf' })
    expect(resolveKnowledgeFile('價目表', 'Application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=binary'))
      .toMatchObject({ kind: 'xlsx', ext: 'xlsx' })
    expect(resolveKnowledgeFile('照片', 'image/jpeg')).toEqual({ kind: 'image', ext: 'jpg', mime: 'image/jpeg' })
  })

  it('⛔ 沒有副檔名、型別只是「含有」那幾個字 → 不收', () => {
    expect(resolveKnowledgeFile('報表', 'application/x-excel-but-actually-html')).toBeNull()
    expect(resolveKnowledgeFile('報表', 'text/html; excel')).toBeNull()
    expect(resolveKnowledgeFile('報表', 'application/pdf-ish')).toBeNull()
    expect(resolveKnowledgeFile('報表', '')).toBeNull()
  })
})
