<template>
  <!-- 欄位旁的求救鈕：就地彈窗教學，不把人帶離欄位（分工規則見 utils/field-help.ts） -->
  <el-button text type="primary" size="small" class="afh-btn" @click="open = true">
    <el-icon class="afh-btn__icon"><QuestionFilled /></el-icon>{{ def.button }}
  </el-button>

  <el-dialog
    v-model="open"
    :title="def.title"
    width="720px"
    class="afh-dialog"
    :top="tall ? '5vh' : undefined"
    append-to-body
  >
    <!-- `C-448`「設好之後，客人會看到」：最上面，先看到結果才知道下面那幾步值不值得做 -->
    <div v-if="def.result" class="afh-dialog__result">
      <b class="afh-dialog__result-title">{{ def.result.title }}</b>
      <el-image
        class="afh-dialog__shot"
        :src="def.result.image"
        :alt="def.result.alt"
        fit="contain"
        :preview-src-list="[def.result.image]"
        :preview-teleported="true"
      />
    </div>
    <!-- html 僅限 field-help 登記表裡我們自己寫的劇本文案 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p v-if="def.html" class="afh-dialog__text" v-html="def.html" />
    <!-- 「填錯會怎樣」：刻意擺在動畫**之前**——動畫很高，擺在後面要捲才看得到，
         而這一塊的內容正好是「畫面不會告訴你，所以你只能先知道」（見 field-help.ts 的判準）。
         html 僅限 field-help 登記表裡我們自己寫的劇本文案 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p v-if="def.warn" class="afh-dialog__warn" v-html="def.warn" />
    <!-- `C-448` 怎麼設：一步一張圖，沿用開通引導的步驟輪播（同一套翻頁、放大、自動播的規矩）。
         ⛔ 不讓它自己捲：彈窗比螢幕高時它會把外層捲到底，最上面那張「客人會看到」就被捲走了 -->
    <div v-if="def.steps" class="afh-dialog__steps">
      <b class="afh-dialog__steps-title">{{ def.steps.title }}</b>
      <AgentStepCarousel :steps="def.steps.items" :auto-scroll="false" />
    </div>
    <el-image
      v-if="def.image && !imgFailed"
      class="afh-dialog__shot"
      :src="def.image"
      :alt="def.alt || def.title"
      fit="contain"
      :preview-src-list="[def.image]"
      :preview-teleported="true"
      @error="imgFailed = true"
    />
    <!-- html 僅限 field-help 登記表裡我們自己寫的劇本文案 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p v-if="def.tip" class="afh-dialog__tip" v-html="def.tip" />
    <template #footer>
      <div class="afh-dialog__foot">
        <a
          v-if="def.href"
          class="afh-dialog__link"
          :href="def.href"
          target="_blank"
          rel="noopener"
        >{{ def.hrefLabel || '打開連結' }} ↗</a>
        <el-button type="primary" round @click="open = false">知道了</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { QuestionFilled } from '@element-plus/icons-vue'
import { FIELD_HELP } from '~/utils/field-help'
import type { FieldHelpId } from '~/utils/field-help'

const props = defineProps<{ id: FieldHelpId }>()

const def = computed(() => FIELD_HELP[props.id])
const open = ref(false)
const imgFailed = ref(false)
/** 有成果圖＋步驟的彈窗很高：往上挪，少捲一點 */
const tall = computed(() => !!(def.value.result && def.value.steps))
</script>

<!-- 樣式在 app/assets/scss/components/_field-help.scss -->
