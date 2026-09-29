import assert from "node:assert/strict";
import test from "node:test";
import { collapseDuplicateExamQuestions } from "../lib/import-questions.mjs";

test("collapses questions whose source exams resolve to one database exam", () => {
  const questions = [
    { id: "alias-a-1", ex: "alias-a", q: 1, s: "", st: "short", unc: true },
    {
      id: "alias-b-1",
      ex: "alias-b",
      q: "1",
      s: "",
      st: "complete question text",
      unc: false,
      imagePage: 2,
      imageBbox: { x: 0.01, y: 0.2, w: 0.98, h: 0.3 },
    },
  ];
  const aliases = new Map([["alias-a", "course:exam"], ["alias-b", "course:exam"]]);

  const result = collapseDuplicateExamQuestions(questions, (id) => aliases.get(id));

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].question.id, "alias-b-1");
  assert.equal(result.items[0].questionNumber, "1");
  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0].droppedId, "alias-a-1");
});

test("keeps distinct questions, subparts, and database exams", () => {
  const questions = [
    { id: "a-1", ex: "a", q: 1, s: "", st: "question one" },
    { id: "a-1b", ex: "a", q: 1, s: "b", st: "question one b" },
    { id: "a-2", ex: "a", q: 2, s: "", st: "question two" },
    { id: "b-1", ex: "b", q: 1, s: "", st: "another exam" },
  ];

  const result = collapseDuplicateExamQuestions(questions, (id) => `db:${id}`);

  assert.equal(result.items.length, 4);
  assert.equal(result.collisions.length, 0);
});
