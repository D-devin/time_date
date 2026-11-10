/** 使用明确时区生成历史日期，避免 UTC 日期与用户所在日期不一致。 */
export function toLocalDate(instant: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    calendar: 'iso8601',
    numberingSystem: 'latn',
  }).formatToParts(new Date(instant));
  const get = (name: string) => parts.find((part) => part.type === name)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
