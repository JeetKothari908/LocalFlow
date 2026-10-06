export type Data = {
  plans: Record<string, string>;
  activeDate?: string;
  selectedDate?: string;
};

export const defaultData: Data = {
  plans: {},
};
