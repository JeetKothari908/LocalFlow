export type Repeat =
  | { type: "daily" }
  | { type: "weekly"; days?: number[] }
  | { type: "custom"; days: number[] }
  | { type: "monthly"; day?: number };
