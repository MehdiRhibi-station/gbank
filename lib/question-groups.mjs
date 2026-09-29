const DIFFICULTY_RANK = { easy: 0, mid: 1, hard: 2 };

function text(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function validBox(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const w = Number(value.w);
  const h = Number(value.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001) {
    return null;
  }
  return { x, y, w, h };
}

function unionBoxes(rows) {
  const pages = unique(rows.map((row) => Number(row.imagePage) || null));
  const boxes = rows.map((row) => validBox(row.imageBbox));
  if (pages.length !== 1 || boxes.some((box) => !box)) return null;

  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  const extraTop = rows.length > 1 ? 0.025 : 0;
  const extraBottom = rows.length > 1 ? 0.018 : 0;
  const y = Math.max(0, top - extraTop);
  const end = Math.min(1, bottom + extraBottom);

  // Main questions often contain formulas, answer choices or diagrams that
  // extend beyond an individual subpart box. Keep almost the full page width
  // while cropping vertically around the complete top-level question.
  const x = rows.length > 1 ? 0.01 : left;
  const finalRight = rows.length > 1 ? 0.99 : right;
  return {
    page: pages[0],
    box: {
      x: Number(x.toFixed(6)),
      y: Number(y.toFixed(6)),
      w: Number((finalRight - x).toFixed(6)),
      h: Number((end - y).toFixed(6)),
    },
  };
}

function labelledStatement(row) {
  const statement = text(row.st);
  const part = text(row.s);
  if (!part || !statement) return statement;
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^${escaped}\\s*[.)\u05f3:'-]?\\s*`).test(statement)) return statement;
  return `${part}) ${statement}`;
}

function mergedId(rows, examId, questionNumber) {
  const parent = rows.find((row) => !text(row.s));
  if (parent?.id) return parent.id;
  const safeNumber = text(questionNumber).replace(/\s+/g, "-") || "question";
  return `${examId}-${safeNumber}`;
}

export function groupQuestionParts(questions) {
  const groups = new Map();
  for (const question of questions ?? []) {
    const key = `${text(question.ex)}\u0000${text(question.q)}`;
    const group = groups.get(key) ?? [];
    group.push(question);
    groups.set(key, group);
  }

  const result = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    const questionNumber = text(first.q);
    const region = unionBoxes(rows);
    const contexts = unique(rows.map((row) => text(row.ctx)));
    const statements = unique(rows.map(labelledStatement));
    const points = unique(rows.map((row) => text(row.pts)));
    const natures = unique(rows.map((row) => text(row.nat)));
    const extractors = unique(rows.map((row) => text(row.extractor)));
    const difficulty = rows.reduce((hardest, row) => {
      const candidate = text(row.lvl) || "mid";
      return (DIFFICULTY_RANK[candidate] ?? 1) > (DIFFICULTY_RANK[hardest] ?? 1)
        ? candidate
        : hardest;
    }, text(first.lvl) || "mid");

    const grouped = {
      ...first,
      id: mergedId(rows, first.ex, questionNumber),
      q: questionNumber,
      s: "",
      pts: points.join(" + "),
      nat: natures.length === 1 ? natures[0] : "mixed",
      lvl: difficulty,
      top: unique(rows.flatMap((row) => Array.isArray(row.top) ? row.top : [])),
      title: text(rows.find((row) => text(row.title))?.title) || `שאלה ${questionNumber}`,
      ctx: contexts.join("\n\n") || undefined,
      st: statements.join("\n\n"),
      unc: rows.some((row) => Boolean(row.unc)) || !region,
      extractor: extractors.join(" + ") || undefined,
      imagePage: region?.page,
      imageBbox: region?.box,
    };
    if (!grouped.ctx) delete grouped.ctx;
    if (!grouped.extractor) delete grouped.extractor;
    if (!grouped.imagePage) delete grouped.imagePage;
    if (!grouped.imageBbox) delete grouped.imageBbox;
    result.push(grouped);
  }

  result.forEach((question, index) => {
    question.o = index + 1;
  });
  return result;
}

export function groupCourseDraft(data) {
  return {
    ...data,
    questions: groupQuestionParts(data?.questions ?? []),
  };
}
