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
    append-to-body
  >
    <!-- html 僅限 field-help 登記表裡我們自己寫的劇本文案 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p class="afh-dialog__text" v-html="def.html" />
    <!-- 「填錯會怎樣」：刻意擺在動畫**之前**——動畫很高，擺在後面要捲才看得到，
         而這一塊的內容正好是「畫面不會告訴你，所以你只能先知道」（見 field-help.ts 的判準）。
         html 僅限 field-help 登記表裡我們自己寫的劇本文案 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p v-if="def.warn" class="afh-dialog__warn" v-html="def.warn" />
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
</script>

<!-- 樣式在 app/assets/scss/components/_field-help.scss -->
