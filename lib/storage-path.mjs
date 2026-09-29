import { createHash } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function safeStorageSegment(value) {
  const source = String(value ?? "");
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(source)) return source;

  const readable = source
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 60);
  return `${readable || "item"}-${digest(source)}`;
}
