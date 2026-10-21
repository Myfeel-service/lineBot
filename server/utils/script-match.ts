/**
 * 一句話進來，要交給哪一條自動回應——**正式回客人、測試對話頁、自動回應頁的「試試看」共用這一份**（`D-138`）。
 *
 * 以前 handler 與 playground 各寫一份，自動回應頁的「測試觸發」又自己用「含任一」比，三把尺講的不一樣：
 * 選了「關鍵字」的那條，沒打到字也會被 AI 用意思挑走，測試框卻說「不會觸發」。
 *
 * 規則（`D-138`① 老闆 2026-10-21 拍板）：
 *   1. 關鍵字快速通道：「客人打特定的字」那種照比對方式比；「AI 判斷」那種有填關鍵字的，打中也直接接
 *      （畫面上會列出這些字，`C-363`⑩）——**但那條設了「不要接」的話先不接**，留給下一步看意思。
 *   2. 意圖路由（一次 AI 判斷）**只看「AI 判斷」那種**。「客人打特定的字」那種不會被用意思挑走。
 */
import type { ScriptIntentHint } from './ai-answer'
import { hitScriptKeyword, scriptTriggerEvent, type ScriptDoc, type ScriptTriggerNode } from '~~/shared/types/ai-script'

type ScriptRow = ScriptDoc & { id: string }

function rootTrigger(script: ScriptDoc): ScriptTriggerNode | null {
  const root = script.nodes.find(n => n.id === script.rootNodeId)
  return root?.type === 'trigger' ? root : null
}

function isMeaningTrigger(script: ScriptDoc): boolean {
  return (rootTrigger(script)?.matchMode ?? 'keyword') === 'semantic'
}

function excludesOf(script: ScriptDoc): string[] {
  return (rootTrigger(script)?.excludes ?? []).map(s => String(s).trim()).filter(Boolean)
}

/** 會被「客人傳文字」接走的那幾條（加好友時那條只由加好友事件啟動） */
export function messageScripts<T extends ScriptDoc>(scripts: T[]): T[] {
  return scripts.filter(s => scriptTriggerEvent(s) === 'message')
}

/**
 * 關鍵字快速通道：照傳進來的順序（已依優先度排好）找第一條打中的。
 * 回傳那條與打中的字（「客人輸入任何內容」那種是空字串）。
 */
export function pickScriptByKeyword<T extends ScriptRow>(scripts: T[], text: string): { script: T; keyword: string } | null {
  for (const script of messageScripts(scripts)) {
    const keyword = hitScriptKeyword(script, text)
    if (keyword === null) continue
    // 「AI 判斷」那種設了「不要接」：含關鍵字也先讓路由看意思（見檔頭）
    if (isMeaningTrigger(script) && excludesOf(script).length) continue
    return { script, keyword }
  }
  return null
}

/** 交給意圖路由挑的候選：只有「AI 判斷」那種（`D-138`①） */
export function routeCandidates<T extends ScriptRow>(scripts: T[]): ScriptIntentHint[] {
  return messageScripts(scripts)
    .filter(isMeaningTrigger)
    .map((s) => {
      const root = rootTrigger(s)
      const hints = [...new Set([...(root?.keywords ?? []), ...(root?.examples ?? [])].map(x => String(x).trim()).filter(Boolean))]
      const excludes = excludesOf(s)
      return { id: s.id, name: s.name, hints, ...(excludes.length ? { excludes } : {}) }
    })
}
