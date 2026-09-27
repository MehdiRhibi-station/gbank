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

export function cropStoragePath({ course, examId, questionId, page, bytes }) {
  const pageNumber = validPageNumber(page);
  if (!pageNumber) throw new Error(`Invalid page number: ${page}`);
  const digest = contentDigest(bytes);
  return [
    "crops",
    safeStorageSegment(course),
    safeStorageSegment(examId),
    `page-${String(pageNumber).padStart(4, "0")}`,
    `${safeStorageSegment(questionId)}-${digest}.png`,
  ].join("/");
}

export function reviewImageName({ examId, page, bytes }) {
  const pageNumber = validPageNumber(page);
  if (!pageNumber) throw new Error(`Invalid page number: ${page}`);
  return `${safeStorageSegment(examId)}-page-${String(pageNumber).padStart(4, "0")}-${contentDigest(bytes)}.png`;
}

export function reviewCropImageName({ questionId, page, bytes }) {
  const pageNumber = validPageNumber(page);
  if (!pageNumber) throw new Error(`Invalid page number: ${page}`);
  return `${safeStorageSegment(questionId)}-page-${String(pageNumber).padStart(4, "0")}-${contentDigest(bytes)}.png`;
}

function finiteFraction(value) {
  const number = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validFractionBox(value) {
  if (!value || typeof value !== "object") return null;
  const x = finiteFraction(value.x);
  const y = finiteFraction(value.y);
  const w = finiteFraction(value.w);
  const h = finiteFraction(value.h);
  if ([x, y, w, h].some((number) => number === null)) return null;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001) {
    return null;
  }
  return { x, y, w, h };
}

export function cropBoxToPixels(
  value,
  pageWidth,
  pageHeight,
  { paddingX = 0.008, paddingY = 0.01 } = {},
) {
  const box = validFractionBox(value);
  const width = Number(pageWidth);
  const height = Number(pageHeight);
  if (!box || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return null;
  }

  const leftFraction = Math.max(0, box.x - paddingX);
  const topFraction = Math.max(0, box.y - paddingY);
  const rightFraction = Math.min(1, box.x + box.w + paddingX);
  const bottomFraction = Math.min(1, box.y + box.h + paddingY);
  const left = Math.floor(leftFraction * width);
  const top = Math.floor(topFraction * height);
  const right = Math.ceil(rightFraction * width);
  const bottom = Math.ceil(bottomFraction * height);
  const cropWidth = Math.min(width - left, Math.max(1, right - left));
  const cropHeight = Math.min(height - top, Math.max(1, bottom - top));
  if (cropWidth < 24 || cropHeight < 24) return null;
  return { left, top, width: cropWidth, height: cropHeight };
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

export function boundedQuestionCropBoxes(questions) {
  const result = new Map();
  for (const group of groupByExamAndPage(questions)) {
    const rows = group.questions
      .map((question) => ({ question, box: validFractionBox(question.image_bbox) }))
      .filter((row) => row.box)
      .sort((left, right) => {
        const vertical = left.box.y - right.box.y;
        if (Math.abs(vertical) > 0.006) return vertical;
        return Number(left.question.ordinal ?? 0) - Number(right.question.ordinal ?? 0);
      });
    if (!rows.length) continue;

    if (rows.length === 1) {
      const [{ question, box }] = rows;
      const top = Math.max(0, box.y - 0.1);
      const bottom = Math.min(1, box.y + box.h + 0.14);
      result.set(question.id, {
        x: 0.01,
        y: Number(top.toFixed(6)),
        w: 0.98,
        h: Number((bottom - top).toFixed(6)),
      });
      continue;
    }

    const boundaries = [];
    for (let index = 0; index < rows.length - 1; index += 1) {
      const next = rows[index + 1].box;
      const previousBoundary = boundaries.at(-1) ?? Math.max(0, rows[0].box.y - 0.1);
      const minimumBoundary = previousBoundary + 0.02;
      const maximumBoundary = next.y - 0.005;
      let boundary = next.y - 0.018;
      if (maximumBoundary > minimumBoundary) {
        boundary = Math.min(maximumBoundary, Math.max(minimumBoundary, boundary));
      } else {
        boundary = Math.max(previousBoundary + 0.005, (previousBoundary + next.y) / 2);
      }
      boundary = Math.min(0.99, boundary);
      boundaries.push(boundary);
    }

    const firstTop = Math.max(0, rows[0].box.y - 0.1);
    const lastBox = rows.at(-1).box;
    const lastBottom = Math.min(1, lastBox.y + lastBox.h + 0.14);
    rows.forEach(({ question }, index) => {
      const top = index === 0 ? firstTop : boundaries[index - 1];
      const bottom = index === rows.length - 1
        ? Math.max(top + 0.025, lastBottom)
        : boundaries[index];
      result.set(question.id, {
        x: 0.01,
        y: Number(top.toFixed(6)),
        w: 0.98,
        h: Number((Math.min(1, bottom) - top).toFixed(6)),
      });
    });
  }
  return result;
}

export function verticalInkBounds(
  pixels,
  width,
  height,
  { channels = 1, darkThreshold = 218, minimumInkRatio = 0.0015 } = {},
) {
  const data = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels ?? []);
  const pixelWidth = Number(width);
  const pixelHeight = Number(height);
  const channelCount = Number(channels);
  if (
    !Number.isInteger(pixelWidth) || pixelWidth < 1 ||
    !Number.isInteger(pixelHeight) || pixelHeight < 1 ||
    !Number.isInteger(channelCount) || channelCount < 1 ||
    data.length < pixelWidth * pixelHeight * channelCount
  ) {
    return null;
  }

  const sideMargin = Math.floor(pixelWidth * 0.01);
  const minimumInk = Math.max(4, Math.ceil(pixelWidth * minimumInkRatio));
  const inkRows = new Uint8Array(pixelHeight);
  for (let y = 0; y < pixelHeight; y += 1) {
    let ink = 0;
    for (let x = sideMargin; x < pixelWidth - sideMargin; x += 1) {
      const offset = (y * pixelWidth + x) * channelCount;
      let darkness = 0;
      const measuredChannels = Math.min(3, channelCount);
      for (let channel = 0; channel < measuredChannels; channel += 1) {
        darkness += data[offset + channel];
      }
      if (darkness / measuredChannels < darkThreshold) ink += 1;
      if (ink >= minimumInk) {
        inkRows[y] = 1;
        break;
      }
    }
  }

  const hasNearbyInk = (row) => {
    const start = Math.max(0, row - 1);
    const end = Math.min(pixelHeight - 1, row + 1);
    let count = 0;
    for (let index = start; index <= end; index += 1) count += inkRows[index];
    return count >= 2;
  };
  let top = 0;
  while (top < pixelHeight && !hasNearbyInk(top)) top += 1;
  if (top >= pixelHeight) return null;
  let bottom = pixelHeight - 1;
  while (bottom >= top && !hasNearbyInk(bottom)) bottom -= 1;
  return { top, bottom: bottom + 1 };
}

export function paddedVerticalInkCrop(pixels, width, height, options = {}) {
  const bounds = verticalInkBounds(pixels, width, height, options);
  if (!bounds) return null;
  const padding = Math.max(18, Math.round(Number(height) * 0.025));
  const top = Math.max(0, bounds.top - padding);
  const bottom = Math.min(Number(height), bounds.bottom + padding);
  return {
    left: 0,
    top,
    width: Number(width),
    height: Math.max(1, bottom - top),
  };
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
