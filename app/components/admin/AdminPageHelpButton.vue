<template>
  <!-- 空狀態那種「有位子講話」的地方：直接給一句看得懂的邀請，不要一顆小問號 -->
  <el-button
    v-if="props.label && available.length"
    class="page-help-link"
    text
    size="small"
    @click="startFirst()"
  >
    {{ props.label }}
  </el-button>

  <!-- 問號版：包一層才放得下「第一次進這一頁」的一次性提示，也給總覽導覽一個錨點 -->
  <span v-else-if="available.length" class="page-help" data-tour="page-help">
    <!-- 一支教學：一顆問號直接開跑 -->
    <el-tooltip v-if="available.length === 1" content="這頁怎麼用" placement="top">
      <el-button
        class="page-help-btn"
        :class="{ 'is-hinting': hinting }"
        text
        size="small"
        :icon="QuestionFilled"
        aria-label="這頁怎麼用"
        @click="startFirst()"
      />
    </el-tooltip>

    <!-- 多支教學：先讓人挑（機器人模組有六支，直接開第一支等於幫使用者亂選） -->
    <el-dropdown v-else trigger="click" placement="bottom-start" @visible-change="dismissHint()">
      <el-tooltip content="這頁怎麼用" placement="top">
        <el-button
          class="page-help-btn"
          :class="{ 'is-hinting': hinting }"
          text
          size="small"
          :icon="QuestionFilled"
          aria-label="這頁怎麼用"
        />
      </el-tooltip>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="t in available"
            :key="t.id"
            @click="start(t)"
          >
            {{ t.label }}<span class="page-help-btn__steps">{{ stepCount(t) }} 步</span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <!-- 一次性提示：第一次進這一頁時讓這顆灰問號出個聲，點過或看過就永遠不再出現 -->
    <span v-if="hinting" class="page-help-hint" role="status">這頁怎麼用？</span>
  </span>
</template>

<script setup lang="ts">
import { QuestionFilled } from '@element-plus/icons-vue'
import type { TutorialTopic } from '~/utils/tutorial-topics'

/**
 * 頁首「這頁怎麼用」（2026-08-26 `D-33` P1-5）。
 *
 * 為什麼是這一項投報率最高：22 支逐步導覽、80 個畫面錨點早就寫好了，但入口只有
 * 「右下角小幫手 → 教學分頁 → 挑主題」三層點擊，而且**完全不看你在哪一頁**
 * （`TutorialAgent` 整份檔案沒讀過當前路由）。現成資產沒被用起來，只差這顆按鈕。
 *
 * ⛔ 不自動跑（老闆 2026-08-26 拍板）：自動導覽會打斷正在做事的人，第二次進來就變騷擾。
 *    使用者點了才跑。
 * ⛔ 沒有可跑的教學就整顆不畫：`topics` 已依角色與功能旗標過濾（觀察者、關掉的功能不顯示
 *    其教學），所以按了保證跑得起來——不要出現按了沒反應的按鈕。
 *
 * 2026-08-28 加上「第一次進這一頁」的一次性提示（老闆拍板）：這顆刻意做小做灰的問號
 * 完全被動，全站沒有任何機制指出它的存在——同一個後台裡會動的只有異常紅點，
 * 等於「壞了」會出聲、「怎麼用」永遠沉默。
 * ⛔ 只亮一次、不循環閃爍：08-28 同日才拍板側欄只有紅點慢呼吸，再多一個常年會動的東西，
 *    兩個都會被當成裝飾。看過就寫進 localStorage，永久不再出現。
 */
const props = defineProps<{
  /** 這一頁的教學主題 id（對應 utils/tutorial-topics）。多支就讓使用者挑 */
  topics: string[]
  /**
   * 有給就改成一顆帶字的文字按鈕（空清單那種有位子講話的地方用）。
   * 這時只會跑第一支——空狀態不該再叫人先挑一份教學。
   */
  label?: string
}>()

const { topics: visibleTopics, stepCount, startTopic, tourOpen } = useTutorial()

/** 這個帳號現在真的跑得起來的那幾支，順序照傳進來的順序（不是註冊表順序） */
const available = computed<TutorialTopic[]>(() =>
  props.topics
    .map(id => visibleTopics.value.find(t => t.id === id))
    .filter((t): t is TutorialTopic => Boolean(t)),
)

function start(topic: TutorialTopic) {
  dismissHint()
  void startTopic(topic)
}

/** 第一支（⛔用函式不用 available[0]!——Vue 模板不吃 TS 的非空斷言，會變成解析錯誤） */
function startFirst() {
  const first = available.value[0]
  if (first)
    start(first)
}

// ── 第一次進這一頁的一次性提示 ──
const HINT_MS = 4200
const hinting = ref(false)
/** 顯示計時器：離開這一頁要收掉，否則「已經看過」會在元件拆掉之後才被寫進去 */
let hintTimer: number | undefined

/** 記憶的鍵用「這一頁教哪幾支」，不用路由——同一頁在不同官方帳號底下路徑不同，但教學是同一批 */
function hintKey() {
  return `page-help-seen:${props.topics.join('|')}`
}

function dismissHint() {
  hinting.value = false
}

onMounted(() => {
  // 帶字版本身就在說話了，不需要再提示
  if (props.label)
    return
  /** 回傳「這件事處理完了」——沒有可跑的教學時回 false，等角色／旗標載完再試一次 */
  const fire = () => {
    if (!available.value.length)
      return false
    // ⛔導覽開著時先不放（2026-08-28 code review 抓到）：導覽的黑幕蓋在這顆氣泡上面，
    // 放了等於在幕後亮四秒鐘給沒人看。而開通完成正是「交棒到對話頁 ＋ 同時開導覽」，
    // 剛好就是這個情境——這個氣泡一輩子只出現一次，不能這樣被吃掉。
    // 回 false＝這件事還沒處理完，下面的 watch 會在導覽關掉後再試一次。
    if (tourOpen.value)
      return false
    try {
      if (localStorage.getItem(hintKey()))
        return true
    }
    catch {
      // 無痕視窗／擋 storage：寧可不提示，也不要變成每次進來都跳一次
      return true
    }
    hinting.value = true
    // ⛔「已經看過」要等**真的顯示完**才記（同一輪 review 抓到）：先記再顯示的話，
    // 任何讓它顯示不出來的情況都會把這一次性的機會永久花掉，而且沒有人會發現。
    hintTimer = window.setTimeout(() => {
      hintTimer = undefined
      dismissHint()
      try {
        localStorage.setItem(hintKey(), '1')
      }
      catch { /* 記不起來就下次再提醒一次，比永久消失好 */ }
    }, HINT_MS)
    return true
  }
  if (fire())
    return
  // 兩件事都要等：角色／功能旗標是非同步載入的（載完才知道這一頁有沒有教學可跑），
  // 而導覽開著時 fire() 會刻意讓路——所以也要盯著它關掉的那一刻補放。
  const stop = watch([available, tourOpen], () => {
    if (fire())
      stop()
  })
})

/**
 * ⛔ 離開這一頁就把計時器收掉（2026-08-28 code review 修）。
 *
 * 不收的話：氣泡才出現 0.3 秒、使用者就換頁，元件已經拆了，計時器照樣在四秒後
 * 把「已經看過」寫進 localStorage——這個一輩子只有一次的提示就這樣被花掉，
 * 而且沒有任何人會發現。這正是上面那段「要等真的顯示完才記」想防的同一件事，
 * 只是漏了「顯示到一半就走人」這條路。
 */
onBeforeUnmount(() => {
  if (hintTimer !== undefined) {
    clearTimeout(hintTimer)
    hintTimer = undefined
  }
})
</script>

<!-- 樣式在 app/assets/scss/components/_block-status.scss 末段（同批 D-33 元件） -->
