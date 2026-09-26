import assert from "node:assert/strict";
import test from "node:test";

import {
  normaliseItem,
  overlappingBoxes,
  pagePrompt,
} from "../lib/extraction-prompt.mjs";

test("normaliseItem pads and clamps fractional boxes", () => {
  const item = normaliseItem(
    { questionNumber: "1", bbox: { x: 0.01, y: 0.02, w: 0.9, h: 0.2 } },
    { page: { number: 2, width: 1000, height: 1400 } },
  );
  assert.equal(item.imagePage, 2);
  assert.deepEqual(item.imageBbox, { x: 0, y: 0.006, w: 0.936, h: 0.228 });
  assert.equal(item.uncertain, false);
});

test("normaliseItem converts percentage and pixel boxes", () => {
  const percent = normaliseItem(
    { bbox: { x: 10, y: 20, w: 80, h: 30, unit: "percent" } },
    { page: 1 },
  );
  assert.deepEqual(percent.imageBbox, { x: 0.082, y: 0.186, w: 0.836, h: 0.328 });

  const pixels = normaliseItem(
    { bbox: { x: 200, y: 300, w: 800, h: 400, unit: "pixels" } },
    { page: { number: 3, width: 1200, height: 1600 } },
  );
  assert.deepEqual(pixels.imageBbox, {
    x: 0.148667,
    y: 0.1735,
    w: 0.702667,
    h: 0.278,
  });
});

test("normaliseItem widens narrow boxes and flags unusable coordinates", () => {
  const narrow = normaliseItem(
    { bbox: { x: 0.4, y: 0.2, w: 0.2, h: 0.1 } },
    { page: 1 },
  );
  assert.equal(narrow.imageBbox.x, 0.012);
  assert.equal(narrow.imageBbox.w, 0.976);

  const missing = normaliseItem({ questionNumber: "4" }, { page: 1 });
  assert.equal(missing.imageBbox, null);
  assert.equal(missing.uncertain, true);
  assert.match(missing.bboxIssue, /missing/);
});

test("overlappingBoxes catches duplicate rectangles only on the same page", () => {
  const items = [
    { questionNumber: "1", imagePage: 1, imageBbox: { x: 0, y: 0, w: 1, h: 0.4 } },
    { questionNumber: "2", imagePage: 1, imageBbox: { x: 0.02, y: 0.01, w: 0.96, h: 0.38 } },
    { questionNumber: "3", imagePage: 2, imageBbox: { x: 0, y: 0, w: 1, h: 0.4 } },
  ];
  const overlaps = overlappingBoxes(items);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].firstLabel, "1");
  assert.equal(overlaps[0].secondLabel, "2");
});

test("pagePrompt emphasizes source-safe, generous crops", () => {
  const prompt = pagePrompt(
    { filename: "80181_2025_1_1_1.pdf" },
    { number: 2 },
    6,
    { logic: "לוגיקה" },
    "1ב",
  );
  assert.match(prompt, /Page 2 of 6/);
  assert.match(prompt, /generous margins/);
  assert.match(prompt, /clipped exponent/);
  assert.match(prompt, /1ב/);
});
