import { createHash } from "node:crypto";
import { safeStorageSegment } from "./storage-path.mjs";

export function validPageNumber(value) {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

export function contentDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export function pageStoragePath({ course, examId, page, bytes }) {
  const pageNumber = validPageNumber(page);
  if (!pageNumber) throw new Error(`Invalid page number: ${page}`);
  const digest = contentDigest(bytes);
  return [
    "pages",
    safeStorageSegment(course),
    safeStorageSegment(examId),
    `page-${String(pageNumber).padStart(4, "0")}-${digest}.png`,
  ].join("/");
}

export function reviewImageName({ examId, page, bytes }) {
  const pageNumber = validPageNumber(page);
  if (!pageNumber) throw new Error(`Invalid page number: ${page}`);
  return `${safeStorageSegment(examId)}-page-${String(pageNumber).padStart(4, "0")}-${contentDigest(bytes)}.png`;
}

export function groupByExamAndPage(questions) {
  const grouped = new Map();
  for (const question of questions) {
    const page = validPageNumber(question.image_page);
    if (!page) continue;
    const key = `${question.exam_id}\u0000${page}`;
    const current = grouped.get(key) ?? {
      examId: question.exam_id,
      page,
      questions: [],
    };
    current.questions.push(question);
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

export function reviewRows(document, expectedCourse) {
  if (!document || typeof document !== "object") {
    throw new Error("Review file must contain a JSON object.");
  }
  if (String(document.course ?? "") !== String(expectedCourse)) {
    throw new Error(
      `Review file is for course ${document.course ?? "unknown"}, not ${expectedCourse}.`,
    );
  }
  if (!Array.isArray(document.questions)) {
    throw new Error("Review file must contain a questions array.");
  }

  const seen = new Set();
  return document.questions.map((question, index) => {
    const id = String(question?.id ?? "").trim();
    const storagePath = String(question?.storagePath ?? "").trim();
    const decision = String(question?.decision ?? "pending").toLowerCase();
    if (!id || !storagePath) {
      throw new Error(`Review entry ${index + 1} needs id and storagePath.`);
    }
    if (seen.has(id)) throw new Error(`Duplicate review entry: ${id}`);
    seen.add(id);
    if (!new Set(["pending", "approved", "rejected"]).has(decision)) {
      throw new Error(`Invalid decision for ${id}: ${decision}`);
    }
    return { id, storagePath, decision };
  });
}

export function parseReviewJson(text) {
  return JSON.parse(String(text ?? "").replace(/^\uFEFF/, ""));
}
