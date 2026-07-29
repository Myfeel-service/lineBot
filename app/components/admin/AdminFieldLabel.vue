<template>
  <component
    :is="props.tag"
    :class="[
      'admin-field-label',
      {
        'admin-field-label--tight': props.tight,
      },
    ]"
  >
    <slot>{{ props.text }}</slot>
    <!-- hint 是欄位的白話說明；以前它不是 prop，寫了也不會顯示（fallthrough 到 <p> 被吞掉）。 -->
    <span v-if="props.hint" class="admin-field-label__hint">{{ props.hint }}</span>
  </component>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  text?: string
  tag?: 'p' | 'div' | 'span' | 'label'
  tight?: boolean
  /** 欄位下方的白話說明（小字、非粗體）。 */
  hint?: string
}>(), {
  text: '',
  tag: 'p',
  tight: false,
  hint: '',
})
</script>
