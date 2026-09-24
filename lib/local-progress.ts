import type { Progress } from "@/lib/types";

const STORAGE_KEY = "gbank-progress-v1";

export function readLocalProgress(): Record<string, Progress> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, Progress>;
  } catch {
    return {};
  }
}

export function writeLocalProgress(progress: Record<string, Progress>) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}
