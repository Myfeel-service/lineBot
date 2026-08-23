/** 後台標籤／好友／推播共用的選項與色票（單一來源，避免各頁複製） */

export const TAG_CATEGORY_OPTIONS = [
  // ⛔ 顯示文字 2026-08-23 由「會員狀態」改「好友狀態」（「會員」全面退場，見 STATUS G-23）。
  // **`value` 刻意不動**：它是既有標籤存在資料庫裡的分類值，改了等於要遷移全部既有標籤，
  // 而使用者只看得到 label。日後若真要改 value，記得連 tags 集合一起搬。
  { value: 'member_status', label: '好友狀態' },
  { value: 'interest', label: '興趣偏好' },
  { value: 'behavior', label: '消費行為' },
  { value: 'activity', label: '活動參與' },
  { value: 'custom', label: '自訂' },
] as const

export type TagCategoryValue = (typeof TAG_CATEGORY_OPTIONS)[number]['value']

export const TAG_PRESET_COLORS = [
  '#6B7280', '#EF4444', '#F97316', '#EAB308',
  '#22C55E', '#14B8A6', '#3B82F6', '#8B5CF6',
  '#EC4899', '#0EA5E9', '#10B981', '#F59E0B',
] as const

export function tagCategoryLabel(value: string) {
  return TAG_CATEGORY_OPTIONS.find((c) => c.value === value)?.label ?? value
}
