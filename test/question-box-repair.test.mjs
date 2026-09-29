import assert from "node:assert/strict";
import test from "node:test";

import {
  boxRepairPrompt,
  canonicalQuestionNumber,
  deriveQuestionRegions,
  normalisePageDetections,
  repairCourseDraft,
} from "../lib/question-box-repair.mjs";

test("question numbers are matched from literal multilingual digits", () => {
  assert.equal(canonicalQuestionNumber("שאלה ۰۲"), "2");
  assert.equal(canonicalQuestionNumber("Question 3."), "3");
  assert.equal(canonicalQuestionNumber("  04) "), "4");
});

test("page detections accept the requested 0–1000 coordinate scale", () => {
  const result = normalisePageDetections(
    {
      questions: [
        {
          questionNumber: "שאלה 2",
          top: 245,
          bottom: 610,
          continuesToNextPage: false,
          confidence: 96,
        },
      ],
    },
    { page: 2 },
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.detections[0], {
    questionNumber: "2",
    page: 2,
    top: 0.245,
    bottom: 0.61,
    continuesToNextPage: false,
    confidence: 96,
  });
});

test("neighboring printed headings form non-overlapping whole-question regions", () => {
  const result = deriveQuestionRegions([
    { questionNumber: "1", page: 2, top: 0.2, bottom: 0.48, continuesToNextPage: false },
    { questionNumber: "2", page: 2, top: 0.5, bottom: 0.8, continuesToNextPage: false },
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.regions[0].box, { x: 0.01, y: 0.188, w: 0.98, h: 0.304 });
  assert.deepEqual(result.regions[1].box, { x: 0.01, y: 0.488, w: 0.98, h: 0.33 });
  assert.ok(
    result.regions[0].box.y + result.regions[0].box.h <= result.regions[1].box.y + 0.005,
  );
});

test("ambiguous and multi-page regions are blocked", () => {
  const duplicate = deriveQuestionRegions([
    { questionNumber: "1", page: 2, top: 0.2, bottom: 0.5, continuesToNextPage: false },
    { questionNumber: "1", page: 3, top: 0.1, bottom: 0.4, continuesToNextPage: false },
    { questionNumber: "2", page: 3, top: 0.45, bottom: 1, continuesToNextPage: true },
  ]);
  assert.equal(duplicate.regions.find((row) => row.questionNumber === "1").usable, false);
  assert.equal(duplicate.regions.find((row) => row.questionNumber === "2").usable, false);
  assert.match(duplicate.issues.join(" "), /detected on 2 pages/);
});

test("repair changes only box metadata and blocks an unmatched old box", () => {
  const source = {
    course: { number: "80131", name: "Calculus" },
    exams: { "23a2": { file: "80131_2023_1_2_1.pdf" } },
    questions: [
      {
        id: "23a2-2",
        ex: "23a2",
        q: "2",
        title: "Keep title",
        st: "Keep this exact statement",
        imagePage: 2,
        imageBbox: { x: 0, y: 0.1, w: 1, h: 0.2 },
      },
      {
        id: "23a2-3",
        ex: "23a2",
        q: "3",
        st: "Another exact statement",
        imagePage: 2,
        imageBbox: { x: 0, y: 0.3, w: 1, h: 0.2 },
      },
    ],
  };
  const regionsByExam = new Map([
    ["23a2", [
      {
        questionNumber: "2",
        page: 2,
        box: { x: 0.01, y: 0.42, w: 0.98, h: 0.25 },
        usable: true,
      },
    ]],
  ]);
  const repaired = repairCourseDraft(source, {
    selectedExamIds: ["23a2"],
    regionsByExam,
    model: "test-model",
  });
  assert.equal(repaired.output.questions[0].st, "Keep this exact statement");
  assert.equal(repaired.output.questions[0].title, "Keep title");
  assert.deepEqual(repaired.output.questions[0].imageBbox, {
    x: 0.01,
    y: 0.42,
    w: 0.98,
    h: 0.25,
  });
  assert.equal(repaired.output.questions[1].imageBbox, undefined);
  assert.equal(repaired.output.questions[1].imagePage, undefined);
  assert.equal(repaired.output.questions[1].unc, true);
  assert.equal(repaired.report.updated.length, 1);
  assert.equal(repaired.report.blocked.length, 1);
});

test("repair prompt forbids inferred numbering and text rewriting", () => {
  const prompt = boxRepairPrompt({
    filename: "80131_2023_1_2_1.pdf",
    page: 2,
    expectedNumbers: ["1", "2", "3"],
  });
  assert.match(prompt, /Do not transcribe/);
  assert.match(prompt, /Copy questionNumber literally/);
  assert.match(prompt, /Never infer it from order/);
  assert.match(prompt, /whole question/);
});
