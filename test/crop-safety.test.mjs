import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedQuestionCropBoxes,
  cropBoxToPixels,
  cropStoragePath,
  groupByExamAndPage,
  paddedVerticalInkCrop,
  pageStoragePath,
  parseReviewJson,
  reviewRows,
  validPageNumber,
} from "../lib/crop-safety.mjs";

test("neighbor boundaries produce non-overlapping complete-question slices", () => {
  const boxes = boundedQuestionCropBoxes([
    { id: "q1", exam_id: "exam", ordinal: 1, image_page: 2, image_bbox: { x: 0.2, y: 0.1, w: 0.6, h: 0.2 } },
    { id: "q2", exam_id: "exam", ordinal: 2, image_page: 2, image_bbox: { x: 0.2, y: 0.35, w: 0.6, h: 0.2 } },
    { id: "q3", exam_id: "exam", ordinal: 3, image_page: 2, image_bbox: { x: 0.2, y: 0.65, w: 0.6, h: 0.2 } },
  ]);

  assert.deepEqual(boxes.get("q1"), { x: 0.01, y: 0, w: 0.98, h: 0.346 });
  assert.deepEqual(boxes.get("q2"), { x: 0.01, y: 0.346, w: 0.98, h: 0.3 });
  assert.deepEqual(boxes.get("q3"), { x: 0.01, y: 0.646, w: 0.98, h: 0.344 });
  assert.ok(
    Math.abs(boxes.get("q1").y + boxes.get("q1").h - boxes.get("q2").y) < 1e-9,
  );
  assert.ok(
    Math.abs(boxes.get("q2").y + boxes.get("q2").h - boxes.get("q3").y) < 1e-9,
  );
});

test("an oversized box is cut before the next question starts", () => {
  const boxes = boundedQuestionCropBoxes([
    { id: "q1", exam_id: "exam", ordinal: 1, image_page: 1, image_bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.5 } },
    { id: "q2", exam_id: "exam", ordinal: 2, image_page: 1, image_bbox: { x: 0.1, y: 0.4, w: 0.8, h: 0.3 } },
  ]);
  assert.equal(boxes.get("q1").y + boxes.get("q1").h, 0.396);
  assert.equal(boxes.get("q2").y, 0.396);
});

test("outside whitespace is removed without cutting content or internal gaps", () => {
  const width = 100;
  const height = 100;
  const pixels = new Uint8Array(width * height).fill(255);
  for (let y = 40; y < 50; y += 1) {
    for (let x = 20; x < 80; x += 1) pixels[y * width + x] = 0;
  }
  for (let x = 20; x < 80; x += 1) pixels[5 * width + x] = 0;

  assert.deepEqual(paddedVerticalInkCrop(pixels, width, height), {
    left: 0,
    top: 22,
    width: 100,
    height: 58,
  });
});

test("content trimming keeps extra room below the final formula row", () => {
  const width = 100;
  const height = 1000;
  const pixels = new Uint8Array(width * height).fill(255);
  for (let y = 400; y < 500; y += 1) {
    for (let x = 20; x < 80; x += 1) pixels[y * width + x] = 0;
  }

  const crop = paddedVerticalInkCrop(pixels, width, height);
  assert.equal(crop.top, 375);
  assert.equal(crop.height, 170);
});

test("question crop paths are unique, ASCII-safe and content-addressed", () => {
  const result = cropStoragePath({
    course: "80131",
    examId: "80131:25a1",
    questionId: "80131:25a1-2-א",
    page: 2,
    bytes: Buffer.from("question crop"),
  });

  assert.match(result, /^crops\/[A-Za-z0-9._/-]+\.png$/);
  assert.ok(!result.includes(":"));
  assert.ok(!result.includes("א"));
});

test("fractional boxes become padded, clamped pixel crops", () => {
  assert.deepEqual(
    cropBoxToPixels(
      { x: 0.1, y: 0.2, w: 0.8, h: 0.3 },
      1000,
      2000,
      { paddingX: 0, paddingY: 0 },
    ),
    { left: 100, top: 400, width: 800, height: 600 },
  );
  assert.deepEqual(
    cropBoxToPixels({ x: 0, y: 0, w: 0.2, h: 0.1 }, 1000, 2000),
    { left: 0, top: 0, width: 209, height: 220 },
  );
  assert.equal(cropBoxToPixels({ x: -1, y: 0, w: 1, h: 1 }, 1000, 2000), null);
});

test("source page paths are ASCII-safe and content-addressed", () => {
  const first = pageStoragePath({
    course: "80181",
    examId: "80181:21b2",
    page: 9,
    bytes: Buffer.from("page one"),
  });
  const second = pageStoragePath({
    course: "80181",
    examId: "80181:21b2",
    page: 9,
    bytes: Buffer.from("changed page"),
  });

  assert.match(first, /^pages\/[A-Za-z0-9._/-]+\.png$/);
  assert.notEqual(first, second);
  assert.ok(!first.includes(":"));
});

test("review JSON accepts the UTF-8 BOM written by Windows PowerShell", () => {
  const parsed = parseReviewJson('\uFEFF{"course":"80181","questions":[]}');
  assert.equal(parsed.course, "80181");
});

test("only positive integer page numbers are accepted", () => {
  assert.equal(validPageNumber(1), 1);
  assert.equal(validPageNumber("12"), 12);
  assert.equal(validPageNumber(0), null);
  assert.equal(validPageNumber(2.5), null);
  assert.equal(validPageNumber("bad"), null);
});

test("questions sharing an exam page reuse one source image group", () => {
  const groups = groupByExamAndPage([
    { id: "a", exam_id: "exam:1", image_page: 2 },
    { id: "b", exam_id: "exam:1", image_page: 2 },
    { id: "c", exam_id: "exam:1", image_page: 3 },
    { id: "d", exam_id: "exam:2", image_page: null },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.questions.length), [2, 1]);
});

test("review decisions are course-scoped and reject duplicate rows", () => {
  const rows = reviewRows(
    {
      course: "80181",
      questions: [
        { id: "q1", storagePath: "pages/80181/exam/page.png", decision: "APPROVED" },
      ],
    },
    "80181",
  );
  assert.deepEqual(rows, [
    { id: "q1", storagePath: "pages/80181/exam/page.png", decision: "approved" },
  ]);

  assert.throws(
    () => reviewRows({ course: "80131", questions: [] }, "80181"),
    /not 80181/,
  );
  assert.throws(
    () =>
      reviewRows(
        {
          course: "80181",
          questions: [
            { id: "q1", storagePath: "a", decision: "approved" },
            { id: "q1", storagePath: "a", decision: "rejected" },
          ],
        },
        "80181",
      ),
    /Duplicate review entry/,
  );
});
