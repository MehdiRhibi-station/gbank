import assert from "node:assert/strict";
import test from "node:test";

import { safeStorageSegment } from "../lib/storage-path.mjs";

test("safeStorageSegment leaves simple ASCII identifiers readable", () => {
  assert.equal(safeStorageSegment("80181"), "80181");
  assert.equal(safeStorageSegment("exam-2025_a"), "exam-2025_a");
});

test("safeStorageSegment removes storage-hostile punctuation and Unicode", () => {
  const aleph = safeStorageSegment("80181:21b2-12-א");
  const bet = safeStorageSegment("80181:21b2-12-ב");

  assert.match(aleph, /^[A-Za-z0-9._-]+$/);
  assert.match(bet, /^[A-Za-z0-9._-]+$/);
  assert.notEqual(aleph, bet);
  assert.ok(!aleph.includes(":"));
});
