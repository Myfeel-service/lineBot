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
import { stepAllowedForRole } from '~/utils/tutorial-step-visibility'

export function useTutorial() {
  const router = useRouter()
  const { workspaceId, canManageSettings, canOperate } = useWorkspace()
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
   * 過濾步驟：功能旗標關掉的、以及**這個角色畫面上根本沒有那個元素**的，都跳過。
   * ⛔ 角色那半不能省：觀察者沒有接手／回覆／預存那幾顆按鈕，不跳過的話他會連續
   *    看到好幾句「這一步要指的位置目前不在畫面上」，像是教學壞了。
   */
  const visibleSteps = (steps: TutorialStep[]) => steps.filter(s =>
    featureOn(s.requiresFeature)
    && stepAllowedForRole(s, {
      canOperate: canOperate.value,
      canManageSettings: canManageSettings.value,
    }),
  )

  /** 這個主題實際會跑幾步（扣掉被功能旗標關掉的）。畫面用它標步數，不要手寫 */
  const stepCount = (topic: TutorialTopic) => visibleSteps(topic.steps).length

  /** 依角色＋功能旗標過濾出可見主題：沒權限／沒開的功能就不顯示其教學 */
  const topics = computed(() =>
    TUTORIAL_TOPICS.filter((t) => {
      if (!featureOn(t.requiresFeature))
        return false
      if (t.requiresSettings)
        return canManageSettings.value
      if (t.requiresOperate)
        return canOperate.value
      return true
    }),
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

  /** 選了某個主題：導航到該頁 → 等元素出現 → 開 tour */
  async function startTopic(topic: TutorialTopic) {
    const wid = workspaceId.value
    if (!wid) return
    const steps = visibleSteps(topic.steps)
    if (!steps.length) return
    activeSteps.value = steps
    lastTopicId.value = topic.id
    tourStep.value = 0
    closePanel()

    if (topic.route) {
      const to = topic.route(wid)
      if (router.currentRoute.value.path !== to)
        await router.push(to)
    }

    // 第一步若要示範訊息卡，先觸發示範，讓欄位元素出現（否則 waitForElement 會逾時）
    const first = steps[0]
    if (first?.demoType)
      setDemo(first.demoType)
    if (first?.target)
      await waitForElement(first.target)

    tourOpen.value = true
  }

  /** 依 topic id 啟動導覽（給健康摘要的「帶我做」按鈕用）；找不到回傳 false */
  function startTopicById(id: string): boolean {
    const topic = TUTORIAL_TOPICS.find(t => t.id === id)
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

  return {
    // state
    panelOpen,
    tourOpen,
    tourStep,
    topics,
    groupedTopics,
    activeSteps,
    lastTopicId,
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
  }
}
