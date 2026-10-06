export const getYmd = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;

export const parseYmd = (value: string) => {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

export const getPlanDate = (date: Date) => {
  const reset = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 8);
  return getYmd(date < reset ? addDays(date, -1) : date);
};

export const formatPlanDate = (value: string) => {
  const parsed = parseYmd(value);
  if (!parsed) return value;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    weekday: "short",
  });
};

export const formatPlanTitleDate = (value: string) => {
  const parsed = parseYmd(value);
  if (!parsed) return value;
  return `${parsed.getMonth() + 1}/${parsed.getDate()}`;
};
