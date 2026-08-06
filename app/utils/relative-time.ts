/**
 * 「多久以前」。後台好幾處都要這一句，先前是各自複製一份——
 * 複製品遲早會有人只改其中一份，同一個時間在兩頁顯示不一樣。
 *
 * 超過一天就改印日期：「31 小時前」要在腦中換算成哪一天，不如直接給日期。
 */
export function relativeTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  return new Date(ms).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
}
