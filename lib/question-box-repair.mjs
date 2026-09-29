const REPAIR_VERSION = 1;

const DIGIT_MAP = new Map([
  ["٠", "0"], ["١", "1"], ["٢", "2"], ["٣", "3"], ["٤", "4"],
  ["٥", "5"], ["٦", "6"], ["٧", "7"], ["٨", "8"], ["٩", "9"],
  ["۰", "0"], ["۱", "1"], ["۲", "2"], ["۳", "3"], ["۴", "4"],
  ["۵", "5"], ["۶", "6"], ["۷", "7"], ["۸", "8"], ["۹", "9"],
]);

function finiteNumber(value) {
  const number = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundFraction(value) {
  return Number(value.toFixed(6));
}

export function canonicalQuestionNumber(value) {
  let label = String(value ?? "")
    .normalize("NFKC")
    .replace(/[٠-٩۰-۹]/g, (digit) => DIGIT_MAP.get(digit) ?? digit)
    .trim();
  label = label
    .replace(/^\s*(?:שאלה|question)\s*/iu, "")
    .replace(/^[\s#№:.,;()\[\]{}-]+|[\s:.,;()\[\]{}-]+$/gu, "")
    .trim();
  const decimal = label.match(/\d+/u)?.[0];
  if (decimal) return String(Number.parseInt(decimal, 10));
  return label.replace(/\s+/gu, "").toLocaleLowerCase("he");
}

export function boxRepairPrompt({ filename, page, expectedNumbers = [] }) {
  const checklist = [...new Set(expectedNumbers.map(canonicalQuestionNumber).filter(Boolean))];
  return [
    "This is one page of an official Hebrew University exam scan.",
    `File: ${filename}. Page: ${page}.`,
    "Your only job is geometric detection. Do not transcribe, summarize, correct, or renumber any question.",
    "Find every TOP-LEVEL printed question heading that visibly BEGINS on this page, such as 'שאלה 1', 'שאלה 2', and so on.",
    "Ignore lettered subparts (א, ב, ג), page headers, point values, answer areas, solutions, and text continuing from a previous page.",
    "Copy questionNumber literally from the printed heading. Never infer it from order, an earlier page, or the checklist.",
    "For each heading, return top and bottom as integers on a 0–1000 vertical page scale, where 0 is the top edge and 1000 is the bottom edge.",
    "top begins slightly above the printed main question heading. bottom is after the final line, formula, diagram, answer choice, and lettered subpart belonging to that whole question.",
    "Do not include the next top-level printed question heading in bottom. Set continuesToNextPage=true if the question is visibly unfinished at the page bottom.",
    "Before returning, verify that the printed number inside each region exactly equals questionNumber.",
    checklist.length
      ? `Database labels expected somewhere in this exam: ${checklist.join(", ")}. This is only a completeness checklist, never a source for assigning a number.`
      : "There is no database checklist. Use only the printed page.",
    "Return the requested JSON object only.",
  ].join("\n");
}

function rawQuestions(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document?.questions)) return document.questions;
  return [];
}

export function normalisePageDetections(document, { page } = {}) {
  const pageNumber = Number(page);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error(`Invalid source page: ${page}`);
  }
  const detections = [];
  const issues = [];
  for (const [index, raw] of rawQuestions(document).entries()) {
    const questionNumber = canonicalQuestionNumber(
      raw?.questionNumber ?? raw?.question_number ?? raw?.number ?? raw?.label,
    );
    let top = finiteNumber(raw?.top ?? raw?.yStart ?? raw?.y_start ?? raw?.bbox?.top);
    let bottom = finiteNumber(raw?.bottom ?? raw?.yEnd ?? raw?.y_end ?? raw?.bbox?.bottom);
    if (bottom === null && raw?.bbox) {
      const y = finiteNumber(raw.bbox.y);
      const height = finiteNumber(raw.bbox.h ?? raw.bbox.height);
      if (y !== null && height !== null) {
        top ??= y;
        bottom = y + height;
      }
    }
    if (!questionNumber) {
      issues.push(`item ${index + 1}: missing printed question number`);
      continue;
    }
    if (top === null || bottom === null) {
      issues.push(`question ${questionNumber}: missing top or bottom coordinate`);
      continue;
    }
    // The repair schema asks for 0–1000 integers. Fractions are accepted as a
    // defensive fallback; every larger value is interpreted on that 0–1000
    // scale so a header near the top (for example 65) cannot be mistaken for
    // 65 percent down the page.
    const largest = Math.max(Math.abs(top), Math.abs(bottom));
    if (largest > 1.2) {
      top /= 1000;
      bottom /= 1000;
    }
    top = Math.max(0, Math.min(1, top));
    bottom = Math.max(0, Math.min(1, bottom));
    if (bottom - top < 0.015) {
      issues.push(`question ${questionNumber}: region is empty or implausibly short`);
      continue;
    }
    const confidence = finiteNumber(raw?.confidence);
    detections.push({
      questionNumber,
      page: pageNumber,
      top: roundFraction(top),
      bottom: roundFraction(bottom),
      continuesToNextPage: Boolean(
        raw?.continuesToNextPage ?? raw?.continues_to_next_page,
      ),
      confidence: confidence === null
        ? null
        : Math.max(0, Math.min(100, confidence <= 1 ? confidence * 100 : confidence)),
    });
  }
  return { detections, issues };
}

export function deriveQuestionRegions(detections) {
  const byPage = new Map();
  for (const detection of detections ?? []) {
    const current = byPage.get(detection.page) ?? [];
    current.push(detection);
    byPage.set(detection.page, current);
  }

  const regions = [];
  const issues = [];
  for (const [page, pageRows] of byPage) {
    const rows = [...pageRows].sort((left, right) => left.top - right.top);
    const repeatedOnPage = new Set();
    const seenOnPage = new Set();
    for (const row of rows) {
      if (seenOnPage.has(row.questionNumber)) repeatedOnPage.add(row.questionNumber);
      seenOnPage.add(row.questionNumber);
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (repeatedOnPage.has(row.questionNumber)) {
        issues.push(`page ${page}: question ${row.questionNumber} was detected more than once`);
        continue;
      }
      const next = rows[index + 1];
      const top = Math.max(0, row.top - 0.012);
      const bottom = next
        ? Math.min(1, next.top - 0.008)
        : Math.min(1, row.bottom + 0.018);
      if (bottom - top < 0.025) {
        issues.push(`page ${page}: question ${row.questionNumber} has conflicting boundaries`);
        continue;
      }
      regions.push({
        questionNumber: row.questionNumber,
        page,
        box: {
          x: 0.01,
          y: roundFraction(top),
          w: 0.98,
          h: roundFraction(bottom - top),
        },
        usable: !row.continuesToNextPage,
        reason: row.continuesToNextPage
          ? "question continues onto the next page; a one-page crop would be incomplete"
          : null,
        confidence: row.confidence,
      });
    }
  }

  const countByNumber = new Map();
  for (const region of regions) {
    countByNumber.set(
      region.questionNumber,
      (countByNumber.get(region.questionNumber) ?? 0) + 1,
    );
  }
  for (const [number, count] of countByNumber) {
    if (count <= 1) continue;
    issues.push(`question ${number} was detected on ${count} pages; no ambiguous region will be used`);
    for (const region of regions) {
      if (region.questionNumber === number) {
        region.usable = false;
        region.reason = "same printed question number detected more than once";
      }
    }
  }
  return { regions, issues };
}

export function repairCourseDraft(
  source,
  { selectedExamIds, regionsByExam, model = "gemini" } = {},
) {
  const selected = new Set(selectedExamIds ?? []);
  const output = structuredClone(source);
  const report = {
    updated: [],
    blocked: [],
    unchanged: [],
    unexpectedDetections: [],
  };

  const expectedByExam = new Map();
  for (const question of output.questions ?? []) {
    if (!selected.has(String(question.ex))) continue;
    const key = canonicalQuestionNumber(question.q);
    const current = expectedByExam.get(String(question.ex)) ?? new Set();
    if (key) current.add(key);
    expectedByExam.set(String(question.ex), current);
  }

  const usableByExam = new Map();
  const blockedByExam = new Map();
  for (const examId of selected) {
    const usable = new Map();
    const blocked = new Map();
    for (const region of regionsByExam?.get(examId) ?? []) {
      if (region.usable) usable.set(region.questionNumber, region);
      else blocked.set(region.questionNumber, region.reason ?? "unsafe region");
      if (!expectedByExam.get(examId)?.has(region.questionNumber)) {
        report.unexpectedDetections.push(`${examId}: question ${region.questionNumber}`);
      }
    }
    usableByExam.set(examId, usable);
    blockedByExam.set(examId, blocked);
  }

  for (const question of output.questions ?? []) {
    const examId = String(question.ex);
    if (!selected.has(examId)) {
      report.unchanged.push(question.id);
      continue;
    }
    const number = canonicalQuestionNumber(question.q);
    const region = usableByExam.get(examId)?.get(number);
    if (region) {
      question.imagePage = region.page;
      question.imageBbox = region.box;
      question.bboxExtractor = `printed-heading-repair-v${REPAIR_VERSION}:${model}`;
      report.updated.push(question.id);
      continue;
    }

    delete question.imagePage;
    delete question.imageBbox;
    question.unc = true;
    const reason = blockedByExam.get(examId)?.get(number) ?? "printed heading not detected uniquely";
    question.bboxIssue = reason;
    report.blocked.push({ id: question.id, examId, questionNumber: number, reason });
  }

  return { output, report };
}

export const BOX_REPAIR_VERSION = REPAIR_VERSION;
