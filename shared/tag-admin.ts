/** 後台標籤／好友／推播共用的選項與色票（單一來源，避免各頁複製） */

export const TAG_CATEGORY_OPTIONS = [
  { value: 'member_status', label: '會員狀態' },
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
