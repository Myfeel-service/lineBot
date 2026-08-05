<template>
  <img
    :src="mark ? '/logomark.svg' : '/logotype.svg'"
    :alt="altText"
    class="brand-logo"
    :class="[mark ? 'brand-logo--mark' : 'brand-logo--type', { 'brand-logo--on-color': onColor }]"
    decoding="async"
  >
</template>

<script setup lang="ts">
/**
 * 品牌標誌。全站唯一的 logo 輸出點——各頁不要自己寫 <img src="/logo…">，
 * 否則換一次 logo 就要全站找一遍（先前的綠圓＋聊天圖示佔位就是這樣散在 6 個頁面）。
 *
 * 兩個檔案的分工（由設計提供，public/ 下）：
 *   - logotype.svg：圖標 ＋ MiniMe 字樣 → 「logo＋文字」的位置用它（預設）
 *   - logomark.svg：只有圖標 → 放不下字樣的位置用 <BrandLogo mark />
 *
 * 大小一律由外層用 `--brand-logo-h` 給高度（寬度由 aspect-ratio 自動算），
 * 不要在這裡開 size prop：每個位置的高度是版面決定的，寫在該頁的 SCSS 裡才看得懂。
 */
const props = withDefaults(defineProps<{
  /** 只出圖標（logomark），用在放不下品牌字樣的地方 */
  mark?: boolean
  /** 放在深色／品牌綠底上：整個標誌轉白，否則深色墨字會看不見 */
  onColor?: boolean
  /**
   * 替代文字。預設＝品牌名，讓「logo 本身就是連結／標題」的位置能被讀出來；
   * 旁邊已經有品牌文字時傳 alt="" 讓輔助科技略過，避免重複唸兩次。
   */
  alt?: string
}>(), { mark: false, onColor: false, alt: undefined })

const { brandName } = useSiteIdentity()

// 用 ?? 不用 ||：alt="" 是「刻意標成裝飾性」的有效值，不能被品牌名蓋回去
const altText = computed(() => props.alt ?? brandName)
</script>
