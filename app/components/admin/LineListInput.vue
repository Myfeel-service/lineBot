<template>
  <!--
    「一行一個」的多行框（2026-10-22 `D-148` 做關鍵字時抓到）：存的是清單、畫面是多行字。
    ⛔ 不可以直接把清單 join 回框裡當 model：Element Plus 每打一個字就把框裡的字蓋回 model，
       行尾的 Enter、空白一打就被「整理」掉——客人會這樣講打「我想查訂單⏎訂單有問題」會黏成一句。
       所以打字時框裡留著原本打的字，只把整理好的清單往外送；離開這一格才整理成一行一個。
  -->
  <el-input
    :model-value="text"
    type="textarea"
    :rows="rows"
    :placeholder="placeholder"
    @update:model-value="onInput"
    @blur="tidy"
  />
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  modelValue: string[]
  rows?: number
  placeholder?: string
  /** 什麼算分隔：預設只有換行；關鍵字那格逗號也算（⛔ 空白不算，「LINE Pay」是一個字） */
  separator?: RegExp
  max?: number
}>(), {
  rows: 3,
  placeholder: '',
  separator: () => /\n+/g,
  max: 50,
})
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

function parse(s: string): string[] {
  return s.split(props.separator).map(x => x.trim()).filter(Boolean).slice(0, props.max)
}
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

const text = ref(props.modelValue.join('\n'))
// 外面換了資料（換一條、AI 搭草稿、範本）才蓋掉框裡的字；自己打字造成的變動不蓋
watch(() => props.modelValue, (v) => {
  if (!same(parse(text.value), v)) text.value = v.join('\n')
})

function onInput(v: string) {
  text.value = v
  const list = parse(v)
  if (!same(list, props.modelValue)) emit('update:modelValue', list)
}
/** 離開這一格：整理成一行一個（逗號分的也換成一行一個、空行拿掉） */
function tidy() {
  text.value = props.modelValue.join('\n')
}
</script>
