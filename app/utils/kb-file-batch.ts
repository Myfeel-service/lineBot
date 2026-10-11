/**
 * 一次匯入好幾份檔案（`C-296`④）的共用型別與純判斷：匯入視窗與逐份清單（KnowledgeFileBatch）都用，
 * 判斷抽在這裡好測（元件裡的版本只能靠實機守門員才驗得到）。
 */
import { KNOWLEDGE_FILE_MAX_BYTES, knowledgeFileKind, unsupportedFileHint } from '~~/shared/knowledge-file-types'
import { EMPTY_FILE_HINT } from './knowledge-upload'

/** 一次最多幾份：每份一次 AI 整理，再多就該分批（也避免瀏覽器分頁被綁住太久） */
export const MAX_FILE_BATCH = 10

/** 這一批跑完（含中途關窗收工）的結算：父層用來刷新清單、關窗時講一句 */
export interface FileBatchSummary {
  sources: number
  cards: number
  quotaShort: number
  failed: number
  conflicts: number
  /** 收得了、但還沒開始就停下的（中途關窗）——⛔ 不講的話「放了 10 份、說匯入 2 份」，另外 8 份沒人交代 */
  notStarted: number
}

/** 關窗前要講的數字（確認框照實講「哪幾份會怎樣」，不是一句籠統的話） */
export interface FileBatchSnapshot {
  /** 按過「整理並匯入」沒有：沒按過＝關窗保留清單，下次打開接著按；按過＝關窗就收工 */
  started: boolean
  done: number
  processing: number
  queued: number
  conflicts: number
}

/**
 * 每一份收不收、不收的原因（空字串＝收）。照放進來的順序判，同一個檔（同名同大小）只收第一份，
 * 超過一次的上限的排在後面那幾份請他下一批再放。
 */
export function batchRejectReasons(files: Array<{ name: string, size: number }>): string[] {
  const seen = new Set<string>()
  let accepted = 0
  return files.map((file) => {
    const sameKey = `${file.name}:${file.size}`
    let error = ''
    if (!knowledgeFileKind(file.name)) error = unsupportedFileHint(file.name)
    else if (file.size === 0) error = EMPTY_FILE_HINT
    else if (file.size > KNOWLEDGE_FILE_MAX_BYTES) error = '檔案超過 10MB 上限'
    else if (seen.has(sameKey)) error = '同一個檔放了兩次，只收一份'
    else if (accepted >= MAX_FILE_BATCH) error = `一次最多 ${MAX_FILE_BATCH} 份，這份請下一批再放`
    if (!error) accepted++
    seen.add(sameKey)
    return error
  })
}

/**
 * 清單左邊那一格：收不了的那份標副檔名（DOC、PAGES），沒有副檔名的寫「檔案」。
 * ⚠️ 以前直接拿檔名最後一段——「README」沒有副檔名，就被截成「READM」（2026-10-11 審查）
 */
export function batchKindLabel(name: string, kindLabel: string | null): string {
  if (kindLabel) return kindLabel.replace(/ (文件|表格)$/, '')
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return '檔案'
  return name.slice(dot + 1).slice(0, 5).toUpperCase()
}
