/**
 * 新手教學 agent 的狀態機。教學內容在 utils/tutorial-topics.ts。
 *
 * 模式：右下角常駐一顆 agent 按鈕，點開像聊天視窗，agent 拋出幾個主題按鈕；
 * 選了主題後，先導航到對應頁面，再用 Element Plus 的 el-tour 逐步高亮真實畫面元素。
 *
 * 跨頁做法：每個主題在開跑前先 router.push 到該頁，等目標元素出現再開 tour，
 * 因此整段導覽的 target 都落在「同一頁」（側欄在所有 admin 頁都在，可一併高亮），
 * 避免 tour 進行到一半換路由造成 target 找不到。
 */

// 型別與內容都在 utils/tutorial-topics.ts（Nuxt 會自動匯入，這裡明寫是為了讀的人好找）
import type { TutorialCategoryGroup, TutorialStep, TutorialTopic } from '~/utils/tutorial-topics'
import { CATEGORY_META, TUTORIAL_TOPICS } from '~/utils/tutorial-topics'
import { stepAllowedForRole, stepPreconditionMet } from '~/utils/tutorial-step-visibility'
import type { AgentAskSource } from '~~/shared/agent-entry'

/**
 * 帶著一句話打開「問／交辦」（`D-112`）。
 * - `send: true`：直接送出（「目前狀況」卡片上的「交給小幫手」——那句話是我們替他講的，內容不含他的規則）
 * - `send: false`：只打開、把字放進輸入框（或留空）、游標放進去，等他自己講（頁面上的「用一句話建立」）
 */
export interface AgentAskRequest {
  text?: string
  send: boolean
  source: AgentAskSource
  /** 同一句話連按兩次也要接得到（watch 比的是整個物件） */
  nonce: number
}

export function useTutorial() {
  const router = useRouter()
  const { workspaceId, can } = useWorkspace()
  const { setDemo } = useFlowDemo()
  const flowFeatures = useFlowFeatures()

  // 功能旗標查表（topic / step 的 requiresFeature 對到這裡）
  const FEATURES: Record<string, boolean> = {
    userInput: flowFeatures.showUserInput,
    userInputAttribute: flowFeatures.showUserInputAttribute,
  }
  const featureOn = (key?: string) => !key || FEATURES[key] === true

  // 全域狀態（沿用本專案 useState 模式，跨元件共享）
  const panelOpen = useState('tutorial-panel-open', () => false)
  const tourOpen = useState('tutorial-tour-open', () => false)
  const tourStep = useState('tutorial-tour-step', () => 0)
  // 目前導覽的步驟（由 startTopic 或 startAdHocTour 設定，是唯一真相來源）
  const activeSteps = useState<TutorialStep[]>('tutorial-active-steps', () => [])
  // 最近一次啟動的主題 id（ad-hoc 巡覽為 null）；給導覽結束後的閉環判斷用
  const lastTopicId = useState<string | null>('tutorial-last-topic', () => null)
  /**
   * 待啟動的「帶著做」劇本 id（D-40 補遺）。劇本跑在小幫手面板裡、狀態長在
   * TutorialAgent 元件內，頁首問號那種面板外的入口搆不到它——所以用這格共享狀態
   * 傳話：入口呼叫 openGuide()，TutorialAgent watch 到就接手開跑並清空這格。
   */
  const requestedGuideId = useState<string | null>('tutorial-requested-guide', () => null)
  /**
   * 面板打開時要停在哪（`D-114`，2026-10-05 三個分頁合成一頁之後）：
   * - `status`：把最上面那一條「目前狀況」展開（聊天回答裡那張「打開目前狀況」卡、異常小氣泡——一鍵修都在那裡）
   * - `chat`：狀況收起來、看得到對話（「用一句話建立」「交給小幫手」）
   * - `catalogue`：全部教學（頁首「？」最下面那一行；`?tour=` 跑不起來時的退路）
   * 面板狀態長在 TutorialAgent 元件內，別的元件搆不到，跟上面那格同一種傳話方式。
   */
  const requestedPanelView = useState<'status' | 'chat' | 'catalogue' | null>('tutorial-requested-view', () => null)
  /**
   * 待送進對話的那句話（`D-112`）。跟上面兩格同一種傳話方式：面板可能還沒打開、
   * 聊天元件還沒掛上，所以留在這格，聊天元件掛上（或已經掛著）時接手並清空。
   */
  const requestedAgentAsk = useState<AgentAskRequest | null>('tutorial-requested-agent-ask', () => null)

  /**
   * 過濾步驟：功能旗標關掉的、以及**這個角色畫面上根本沒有那個元素**的，都跳過。
   * ⛔ 角色那半不能省：觀察者沒有接手／回覆／預存那幾顆按鈕，不跳過的話他會連續
   *    看到好幾句「這一步要指的位置目前不在畫面上」，像是教學壞了。
   */
  const visibleSteps = (steps: TutorialStep[]) => steps.filter(s =>
    featureOn(s.requiresFeature) && stepAllowedForRole(s, { can }),
  )

  /** 這個主題實際會跑幾步（扣掉被功能旗標關掉的）。畫面用它標步數，不要手寫 */
  const stepCount = (topic: TutorialTopic) => visibleSteps(topic.steps).length

  /**
   * 依能力＋功能旗標過濾出可見主題：沒權限／沒開的功能就不顯示其教學。
   * `G-109`：主題的 `requires` 跟步驟同一個形狀，同一支判斷。
   */
  const topics = computed(() =>
    TUTORIAL_TOPICS.filter(t => featureOn(t.requiresFeature) && stepAllowedForRole(t, { can })),
  )

  /** 依分類分組（已過濾角色、按 CATEGORY_META 順序、空組不顯示） */
  const groupedTopics = computed<TutorialCategoryGroup[]>(() =>
    CATEGORY_META
      .map(c => ({
        id: c.id,
        label: c.label,
        topics: topics.value.filter(t => t.category === c.id),
      }))
      .filter(g => g.topics.length > 0),
  )

  function openPanel() {
    panelOpen.value = true
  }
  function closePanel() {
    panelOpen.value = false
  }
  function togglePanel() {
    panelOpen.value = !panelOpen.value
  }

  /**
   * 等一個「前提」出現：平常等 1.5 秒；**畫面上還有東西在轉圈**（資料還在載）就再多等，最多 4 秒。
   *
   * ⛔ 為什麼不直接拉長到 4 秒（2026-09-29 `D-109` 實走踩到）：客服對話清單在正式資料上要載 1.5 秒以上，
   *    後面 6 步的前提是「清單裡有一筆」——開跑時還沒載完，那 6 步就被**靜默刷掉**，導覽只剩 2 步。
   *    但真的沒有東西的帳號（還沒產生過報告的好友統計）不該每次都乾等 4 秒才出現導覽——
   *    按問號的人會以為按了沒反應。所以只有「還在載」的時候才多等。
   */
  async function waitForPrecondition(sel: string): Promise<boolean> {
    if (await waitForElement(sel, 1500))
      return true
    const loading = () => [...document.querySelectorAll<HTMLElement>('.spinner')].some(el => el.offsetParent !== null)
    const start = performance.now()
    while (performance.now() - start < 2500) {
      if (document.querySelector(sel))
        return true
      if (!loading())
        return false
      await new Promise(r => setTimeout(r, 100))
    }
    return !!document.querySelector(sel)
  }

  /** 選了某個主題：導航到該頁 → 等元素出現 → 過濾前提 → 開 tour */
  async function startTopic(topic: TutorialTopic) {
    const wid = workspaceId.value
    if (!wid) return
    // 角色／功能旗標先過（純判斷，不需要 DOM）
    const roleSteps = visibleSteps(topic.steps)
    if (!roleSteps.length) return

    lastTopicId.value = topic.id
    tourStep.value = 0
    closePanel()

    if (topic.route) {
      const to = topic.route(wid)
      if (router.currentRoute.value.path !== to)
        await router.push(to)
    }

    // 第一步若要示範訊息卡，先觸發示範，讓欄位元素出現（否則 waitForElement 會逾時）
    const first = roleSteps[0]
    if (first?.demoType)
      setDemo(first.demoType)
    if (first?.target)
      await waitForElement(first.target)

    // ── 「前提在不在」一定要在**導航之後**才問（2026-09-02 修）─────────────────
    // 原本這段在 router.push **之前**執行，問的是**上一頁**的 DOM。後果：任何
    // `requiresPresent` 指向目標頁元素的步驟，只要導覽不是從那一頁自己開的，就會被
    // 靜默刷掉——沒有錯誤、沒有 log，只是那幾步再也不會出現。
    // 實際受害的是「看懂對話收件匣」右半邊那三步（從別頁開就消失），以及開通結尾接的
    // 「帶你認識後台」最後一步（從開通頁開，對話清單根本還沒存在，100% 被刷掉）。
    // ⛔ 而且不能只用一次性 querySelector：對話清單是非同步載入的，剛換頁那一瞬間
    //    一定還是空的。所以改成**短暫等它出現**（1.5 秒），等不到才算真的沒有。
    // ⛔ 幾個前提要**同時**等，不可以一個接一個等（2026-09-29 `D-109` 實走踩到）：
    //    好友統計那支四步全是「有東西才出現」，還沒產生過報告時有三個不在——一個一個等就是
    //    4.5 秒後導覽才出現，按問號的人以為按了沒反應。同時等：平常最久 1.5 秒（還在載入才多等，見 waitForPrecondition）。
    const sels = [...new Set(roleSteps.map(s => s.requiresPresent).filter((s): s is string => !!s))]
    const found = await Promise.all(sels.map(waitForPrecondition))
    const present = new Map(sels.map((sel, i) => [sel, found[i]!]))
    const steps = roleSteps.filter(s => stepPreconditionMet(s, sel => present.get(sel) ?? false))
    if (!steps.length) return
    activeSteps.value = steps

    // 過濾後的第一步換人了（原本的第一步被前提刷掉）＝要改等它的目標
    if (steps[0] !== first && steps[0]?.target)
      await waitForElement(steps[0].target)

    tourOpen.value = true
  }

  /** 依 topic id 啟動導覽（給健康摘要的「帶我做」按鈕用）；找不到回傳 false */
  function startTopicById(id: string): boolean {
    // ⛔ 查 topics（已依角色與功能旗標過濾）不是 TUTORIAL_TOPICS（2026-08-28 code review 修）：
    //    `?tour=` 是使用者可以自己在網址列打的，用未過濾的清單找得到，等於把客服或觀察者
    //    送進他沒權限的設定頁、然後每一步都指不到東西——那正是 stepAllowedForRole 要防的事，
    //    在這一層又漏了回來。查不到就回 false，呼叫端已經有退路（打開「全部教學」讓人自己挑）。
    const topic = topics.value.find(t => t.id === id)
    if (!topic)
      return false
    void startTopic(topic)
    return true
  }

  /**
   * 臨時導覽：直接給一組步驟在「當前頁面」高亮（不換頁）。
   * 給「缺項巡覽」用——依即時狀態組裝、逐一高亮側欄上還沒做完的入口。
   */
  async function startAdHocTour(steps: TutorialStep[]) {
    if (!steps.length) return
    activeSteps.value = steps
    lastTopicId.value = null
    tourStep.value = 0
    closePanel()
    const firstTarget = steps[0]?.target
    if (firstTarget)
      await waitForElement(firstTarget)
    tourOpen.value = true
  }

  function endTour() {
    tourOpen.value = false
    activeSteps.value = []
    tourStep.value = 0
  }

  /** 從面板外（頁首問號等）啟動一條「帶著做」劇本：開面板＋留話給 TutorialAgent */
  function openGuide(id: string) {
    requestedGuideId.value = id
    openPanel()
  }

  /** 打開面板並停在某個畫面（見 `requestedPanelView`） */
  function openPanelView(view: 'status' | 'chat' | 'catalogue') {
    requestedPanelView.value = view
    openPanel()
  }

  /** 全部教學（頁首「？」最下面那一行） */
  function openCatalogue() {
    openPanelView('catalogue')
  }

  /** 打開對話並帶一句話（頁面上的「用一句話建立」、目前狀況卡片的「交給小幫手」） */
  function askAgent(req: Omit<AgentAskRequest, 'nonce'>) {
    requestedAgentAsk.value = { ...req, nonce: Date.now() + Math.random() }
    openPanelView('chat')
  }

  return {
    // state
    panelOpen,
    tourOpen,
    tourStep,
    topics,
    groupedTopics,
    activeSteps,
    lastTopicId,
    requestedGuideId,
    requestedPanelView,
    requestedAgentAsk,
    // helpers
    stepCount,
    // actions
    openPanel,
    closePanel,
    togglePanel,
    startTopic,
    startTopicById,
    startAdHocTour,
    endTour,
    openGuide,
    openPanelView,
    openCatalogue,
    askAgent,
  }
}
