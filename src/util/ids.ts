import { randomBytes } from "node:crypto";

export type IdPrefix = "run" | "act" | "prop" | "person" | "project" | "goal" | "task"
  | "state" | "call" | "manifest" | "change" | "retrieval" | "summary" | "extract";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}
