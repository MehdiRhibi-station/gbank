function text(value) {
  return String(value ?? "").trim();
}

function validImageMetadata(question) {
  const page = Number(question?.imagePage);
  const box = question?.imageBbox;
  if (!Number.isInteger(page) || page < 1 || !box || typeof box !== "object") return false;
  const values = [box.x, box.y, box.w, box.h].map(Number);
  if (!values.every(Number.isFinite)) return false;
  const [x, y, width, height] = values;
  return x >= 0 && y >= 0 && width > 0 && height > 0 &&
    x + width <= 1.000001 && y + height <= 1.000001;
}

function candidateScore(question) {
  // Duplicate source filenames can point to the exact same PDF. Prefer the
  // extraction that is immediately usable, then the more complete text.
  const image = validImageMetadata(question) ? 1_000_000 : 0;
  const certain = question?.unc ? 0 : 100_000;
  const contentLength = text(question?.ctx).length + text(question?.st).length;
  return image + certain + Math.min(contentLength, 99_999);
}

/**
 * Collapse question rows after exam hashes have been deduplicated.
 *
 * Two HUJI filenames occasionally contain byte-for-byte identical PDFs. The
 * importer maps both source exam ids to one database exam id. PostgreSQL then
 * rejects a single upsert containing the same printed question twice, so the
 * collision must be resolved before sending the batch.
 */
export function collapseDuplicateExamQuestions(questions, resolveExamId) {
  const selected = new Map();
  const collisions = [];

  for (const question of questions ?? []) {
    const examId = text(resolveExamId(question.ex));
    const questionNumber = text(question.q);
    const subpart = text(question.s);
    const identity = `${examId}\u0000${questionNumber}\u0000${subpart}`;
    const candidate = { question, examId, questionNumber, subpart };
    const previous = selected.get(identity);

    if (!previous) {
      selected.set(identity, candidate);
      continue;
    }

    const previousScore = candidateScore(previous.question);
    const candidateValue = candidateScore(candidate.question);
    if (candidateValue > previousScore) selected.set(identity, candidate);
    collisions.push({
      examId,
      questionNumber,
      subpart,
      keptId: text((candidateValue > previousScore ? candidate : previous).question.id),
      droppedId: text((candidateValue > previousScore ? previous : candidate).question.id),
    });
  }

  return { items: [...selected.values()], collisions };
}

