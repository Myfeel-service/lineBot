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

  <!-- 一支教學：一顆問號直接開跑 -->
  <el-tooltip v-else-if="available.length === 1" content="這頁怎麼用" placement="top">
    <el-button
      class="page-help-btn"
      text
      size="small"
      :icon="QuestionFilled"
      aria-label="這頁怎麼用"
      @click="startFirst()"
    />
  </el-tooltip>

  <!-- 多支教學：先讓人挑（機器人模組有六支，直接開第一支等於幫使用者亂選） -->
  <el-dropdown v-else-if="available.length > 1" trigger="click" placement="bottom-start">
    <el-tooltip content="這頁怎麼用" placement="top">
      <el-button class="page-help-btn" text size="small" :icon="QuestionFilled" aria-label="這頁怎麼用" />
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

const { topics: visibleTopics, stepCount, startTopic } = useTutorial()

/** 這個帳號現在真的跑得起來的那幾支，順序照傳進來的順序（不是註冊表順序） */
const available = computed<TutorialTopic[]>(() =>
  props.topics
    .map(id => visibleTopics.value.find(t => t.id === id))
    .filter((t): t is TutorialTopic => Boolean(t)),
)

function start(topic: TutorialTopic) {
  void startTopic(topic)
}

/** 第一支（⛔用函式不用 available[0]!——Vue 模板不吃 TS 的非空斷言，會變成解析錯誤） */
function startFirst() {
  const first = available.value[0]
  if (first)
    start(first)
}
</script>

<!-- 樣式在 app/assets/scss/components/_block-status.scss 末段（同批 D-33 元件） -->
