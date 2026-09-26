const HORIZONTAL_PADDING = 0.018;
const VERTICAL_PADDING = 0.014;
const MINIMUM_USEFUL_WIDTH = 0.58;
const PAGE_SIDE_MARGIN = 0.012;

function finiteNumber(value) {
  const number = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(number) ? number : null;
}

function pageDetails(page) {
  if (typeof page === "number") {
    return { number: page, width: null, height: null };
  }
  return {
    number: finiteNumber(page?.number ?? page?.page ?? page?.index) ?? 1,
    width: finiteNumber(page?.width),
    height: finiteNumber(page?.height),
  };
}

function rawBox(item) {
  const value = item?.image_bbox ?? item?.imageBbox ?? item?.bbox ?? item?.box;
  if (Array.isArray(value) && value.length >= 4) {
    return { x: value[0], y: value[1], w: value[2], h: value[3] };
  }
  if (!value || typeof value !== "object") return null;
  if (value.x2 !== undefined || value.y2 !== undefined) {
    const x = finiteNumber(value.x ?? value.left);
    const y = finiteNumber(value.y ?? value.top);
    const x2 = finiteNumber(value.x2 ?? value.right);
    const y2 = finiteNumber(value.y2 ?? value.bottom);
    return {
      ...value,
      x,
      y,
      w: x === null || x2 === null ? null : x2 - x,
      h: y === null || y2 === null ? null : y2 - y,
    };
  }
  return {
    ...value,
    x: value.x ?? value.left,
    y: value.y ?? value.top,
    w: value.w ?? value.width,
    h: value.h ?? value.height,
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normaliseBox(item, page) {
  const source = rawBox(item);
  if (!source) return { box: null, issue: "missing bounding box" };

  let x = finiteNumber(source.x);
  let y = finiteNumber(source.y);
  let w = finiteNumber(source.w);
  let h = finiteNumber(source.h);
  if ([x, y, w, h].some((value) => value === null) || w <= 0 || h <= 0) {
    return { box: null, issue: "invalid bounding box" };
  }

  const unit = String(
    source.unit ?? item?.bboxUnit ?? item?.bbox_unit ?? item?.coordinateUnit ?? "",
  ).toLowerCase();
  const largest = Math.max(Math.abs(x), Math.abs(y), Math.abs(w), Math.abs(h));

  if (unit.includes("1000")) {
    x /= 1000;
    y /= 1000;
    w /= 1000;
    h /= 1000;
  } else if (unit.includes("percent") || unit === "%" || (largest > 1.2 && largest <= 100)) {
    x /= 100;
    y /= 100;
    w /= 100;
    h /= 100;
  } else if (largest > 1.2) {
    if (!page.width || !page.height) {
      return { box: null, issue: "pixel bounding box without page dimensions" };
    }
    x /= page.width;
    w /= page.width;
    y /= page.height;
    h /= page.height;
  }

  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    return { box: null, issue: "unusable bounding box" };
  }

  x -= HORIZONTAL_PADDING;
  y -= VERTICAL_PADDING;
  w += HORIZONTAL_PADDING * 2;
  h += VERTICAL_PADDING * 2;

  if (w < MINIMUM_USEFUL_WIDTH) {
    x = PAGE_SIDE_MARGIN;
    w = 1 - PAGE_SIDE_MARGIN * 2;
  }

  x = clamp(x, 0, 1);
  y = clamp(y, 0, 1);
  w = clamp(w, 0, 1 - x);
  h = clamp(h, 0, 1 - y);
  if (w <= 0.02 || h <= 0.01) {
    return { box: null, issue: "bounding box collapsed after clamping" };
  }

  return {
    box: {
      x: Number(x.toFixed(6)),
      y: Number(y.toFixed(6)),
      w: Number(w.toFixed(6)),
      h: Number(h.toFixed(6)),
    },
    issue: null,
  };
}

export function pagePrompt(exam, page, total, topics = {}, lastLabel = "") {
  const current = pageDetails(page).number;
  const topicList = Array.isArray(topics)
    ? topics
    : Object.values(topics ?? {});
  return [
    "You are indexing one page of an official Hebrew University exam.",
    `Exam: ${exam?.filename ?? exam?.file ?? "unknown"}. Page ${current} of ${total}.`,
    lastLabel
      ? `The last question label emitted on an earlier page was ${lastLabel}. Do not repeat it unless a new printed label begins on this page.`
      : "No earlier question label has been emitted.",
    "Return one JSON item for every independently printed question or subpart that begins on this page, in reading order.",
    "Do not output instructions, solutions, answer keys, handwriting, reserve answer areas, or an unlabeled continuation from an earlier page.",
    "Preserve the Hebrew wording. Put mathematics in LaTeX. Never repair or invent illegible symbols; set uncertain=true instead.",
    "For every item, draw bbox={x,y,w,h,unit} around the ORIGINAL PRINTED QUESTION on this page.",
    "Coordinates should be 0–1 page fractions with origin at the top-left and unit=\"fraction\". If another coordinate system is unavoidable, set unit to percent, pixels, or normalized_1000 accurately.",
    "The rectangle must include the printed number, the entire body, all answer choices, diagrams, and any shared stem needed to understand the item.",
    "Use generous margins. A loose crop is invisible to students; a clipped exponent, subscript, inequality, or diagram is a defect.",
    "Never use one rectangle for two different question labels. If a shared stem applies to several subparts, include the stem in every relevant rectangle.",
    "Fill courseName, instructors, examDate and questionsToAnswer only when they are visible on this page; otherwise use an empty string.",
    "For each question include questionNumber, subpart, points, nature, difficulty, topics, title, context, statement, uncertain and bbox.",
    topicList.length
      ? `Prefer these existing topic labels when accurate: ${topicList.join(", ")}.`
      : "Use short Hebrew topic labels.",
    "Return exactly the requested JSON object and no prose.",
  ].join("\n");
}

export function normaliseItem(raw, { page } = {}) {
  const details = pageDetails(page ?? raw?.imagePage ?? raw?.image_page ?? raw?.page ?? 1);
  const { box, issue } = normaliseBox(raw, details);
  const imagePage = Math.max(
    1,
    Math.trunc(
      finiteNumber(raw?.imagePage ?? raw?.image_page ?? raw?.page ?? details.number) ?? 1,
    ),
  );

  return {
    ...raw,
    imagePage,
    imageBbox: box,
    bboxIssue: issue,
    uncertain: Boolean(raw?.uncertain || issue),
  };
}

function itemBox(item) {
  const box = item?.imageBbox ?? item?.image_bbox ?? item?.bbox;
  if (!box || typeof box !== "object") return null;
  const x = finiteNumber(box.x);
  const y = finiteNumber(box.y);
  const w = finiteNumber(box.w);
  const h = finiteNumber(box.h);
  return [x, y, w, h].every((value) => value !== null && Number.isFinite(value))
    ? { x, y, w, h }
    : null;
}

export function overlappingBoxes(items, minimumOverlap = 0.78) {
  const overlaps = [];
  for (let first = 0; first < items.length; first += 1) {
    const a = itemBox(items[first]);
    if (!a) continue;
    for (let second = first + 1; second < items.length; second += 1) {
      const firstPage = finiteNumber(items[first]?.imagePage ?? items[first]?.image_page);
      const secondPage = finiteNumber(items[second]?.imagePage ?? items[second]?.image_page);
      if (firstPage !== null && secondPage !== null && firstPage !== secondPage) continue;
      const b = itemBox(items[second]);
      if (!b) continue;
      const left = Math.max(a.x, b.x);
      const top = Math.max(a.y, b.y);
      const right = Math.min(a.x + a.w, b.x + b.w);
      const bottom = Math.min(a.y + a.h, b.y + b.h);
      const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
      if (!intersection) continue;
      const smallerArea = Math.min(a.w * a.h, b.w * b.h);
      const overlap = smallerArea ? intersection / smallerArea : 0;
      if (overlap >= minimumOverlap) {
        overlaps.push({
          first,
          second,
          firstLabel: items[first]?.questionNumber ?? items[first]?.question_number ?? "",
          secondLabel: items[second]?.questionNumber ?? items[second]?.question_number ?? "",
          overlap: Number(overlap.toFixed(4)),
        });
      }
    }
  }
  return overlaps;
}
