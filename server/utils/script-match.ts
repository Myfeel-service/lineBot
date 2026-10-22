/**
 * 一句話進來，要交給哪一條自動回應——**正式回客人、測試對話頁、自動回應頁的「試試看」共用這一份**（`D-138`）。
 *
 * 以前 handler 與 playground 各寫一份，自動回應頁的「測試觸發」又自己用「含任一」比，三把尺講的不一樣：
 * 選了「關鍵字」的那條，沒打到字也會被 AI 用意思挑走，測試框卻說「不會觸發」。
 *
 * 規則：兩種各做一件事（`D-138`① ＋ `C-370`，老闆 2026-10-21「走長遠」）
 *   1. 「客人打特定的字」那種：只看字，照比對方式比，打中就接；**不會被 AI 用意思挑走**。
 *   2. 「看意思」那種：只交給意圖路由（一次 AI 判斷）看整句話，**不看字**——
 *      以前它也藏著幾個「看到就接」的字（畫面上看不到、AI 搭草稿自動放的），把「保留訂單」當成查訂單。
 *      店家寫「客人會這樣講」，接錯了就補「這些交給 AI 回答，不要接」。
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

/**
 * 誰先比：優先度高的先；一樣高的照文件編號大的先——Firestore `orderBy('priority', 'desc')` 同分時隱含照文件編號、
 * 跟最後一個排序同方向排，這裡照抄（`C-379`）。正式（loadActiveScripts）與試試看都過這一支：
 * 試試看把編輯中的那條換進清單後重排，以前同分時排在存好的那條後面，挑到的跟客人實際會走的相反。
 */
export function sortByPriority<T extends ScriptRow>(scripts: T[]): T[] {
  return [...scripts].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** 會被「客人傳文字」接走的那幾條（加好友時那條只由加好友事件啟動） */
export function messageScripts<T extends ScriptDoc>(scripts: T[]): T[] {
  return scripts.filter(s => scriptTriggerEvent(s) === 'message')
}

/**
 * 「客人打特定的字」那種：照傳進來的順序（已依優先度排好）找第一條打中的。
 * 回傳那條與打中的字（「客人輸入任何內容」那種是空字串）。看意思那種一律不中（見 hitScriptKeyword）。
 */
export function pickScriptByKeyword<T extends ScriptRow>(scripts: T[], text: string): { script: T; keyword: string } | null {
  for (const script of messageScripts(scripts)) {
    const keyword = hitScriptKeyword(script, text)
    if (keyword !== null) return { script, keyword }
  }
  return null
}

/** 交給意圖路由挑的候選：只有「看意思」那種，提示只給「客人會這樣講」與「不要接」 */
export function routeCandidates<T extends ScriptRow>(scripts: T[]): ScriptIntentHint[] {
  return messageScripts(scripts)
    .filter(isMeaningTrigger)
    .map((s) => {
      const root = rootTrigger(s)
      const hints = [...new Set((root?.examples ?? []).map(x => String(x).trim()).filter(Boolean))]
      const excludes = (root?.excludes ?? []).map(x => String(x).trim()).filter(Boolean)
      return { id: s.id, name: s.name, hints, ...(excludes.length ? { excludes } : {}) }
    })
}
