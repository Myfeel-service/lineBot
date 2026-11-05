/**
 * 開帳標籤卡的「還想怎麼分？問 AI」（`D-171`）：打一次模型、回幾顆標籤草稿。
 * 規矩與驗法在 `shared/tag-ideas.ts`（那邊可以單元測試）；這裡只負責組 prompt、打模型。
 * ⛔ 只回草稿，不建任何東西。
 */
import { generateJson, runWithLlmBudget } from '~~/server/utils/gemini'
import { storeProfileForPrompt, type StoreProfileDoc } from '~~/shared/types/store-profile'
import { TAG_IDEA_MAX, TAG_IDEA_NAME_MAX, vetTagIdeas, type TagIdeasVetted } from '~~/shared/tag-ideas'

export interface TagIdeasCtx {
  shopName: string
  profile: StoreProfileDoc
  /** 他打的那一句 */
  ask: string
  /** 那一排現在已經有的名字 */
  have: string[]
}

export function buildTagIdeasPrompt(ctx: TagIdeasCtx): string {
  return [
    `你要幫「${ctx.shopName || '這家店'}」想幾顆「分眾標籤」。標籤是拿來挑推播名單的：之後 AI 會讀客人在 LINE 上的對話，判斷這位客人該不該貼上這顆。`,
    '',
    '這家店：',
    storeProfileForPrompt(ctx.profile),
    '',
    '店家說他想這樣分客人：',
    `「${ctx.ask}」`,
    '',
    `那一排已經有這些（⛔ 不要重複）：${ctx.have.length ? ctx.have.join('、') : '（沒有）'}`,
    '',
    '規則：',
    '1. ⛔ 只能是「客人在 LINE 對話裡講得出來」的分法——問過什麼、想要什麼、在意什麼、說過自己是什麼情況。AI 讀對話判斷得出來，才貼得上。',
    '2. ⛔ 要訂單、來店、消費紀錄才分得出來的不要做（例如買過、回購、常客、VIP、第一次來、消費多少）。店家要的是這種的話，放進 skipped，reason 用一句白話講為什麼做不到。',
    `3. 店家講的如果本來就是好幾種（例如內用、外帶、外送），每一種一顆。最多 ${TAG_IDEA_MAX} 顆。`,
    `4. name：${TAG_IDEA_NAME_MAX} 個字以內，像店家自己會講的話（例：內用客、問過外送、想訂蛋糕）。`,
    '5. criteria：寫給 AI 看的判斷條件，一到兩句「什麼算＋什麼不算」，80 字以內。',
    '6. why：一句話講這群人之後拿來做什麼（例如發什麼推播時挑他們），25 字以內。',
    '7. ⛔ 只回店家這句話要的那幾種，不要自己多想別的分法湊數。做不到就 tags 回空陣列、只寫 skipped。',
    '8. from：這一顆對應店家那句話裡的哪幾個字，原封不動抄過來（例：店家說「內用、外帶」→ 內用客的 from 是「內用」）。',
    '9. 繁體中文，不要 markdown。',
    '',
    '回傳純 JSON：{"tags": [{"name": "…", "from": "…", "criteria": "…", "why": "…"}], "skipped": [{"name": "…", "reason": "…"}]}',
  ].join('\n')
}

export interface TagIdeasOutcome extends TagIdeasVetted {
  inputTokens: number
  outputTokens: number
  model?: string
}

export async function suggestStoreTagIdeas(workspaceId: string, ctx: TagIdeasCtx): Promise<TagIdeasOutcome> {
  const res = await runWithLlmBudget(workspaceId, () =>
    generateJson<unknown>(buildTagIdeasPrompt(ctx), {
      temperature: 0.4,
      maxOutputTokens: 700,
      thinkingBudget: 0,
    }), 'knowledge')
  return {
    // `ask` 帶進去：跟他問的那句沒關係的（模型湊數）丟掉並記原因（2026-11-05 真模型實測）
    ...vetTagIdeas(res.data, ctx.have, ctx.ask),
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    model: res.model,
  }
}
