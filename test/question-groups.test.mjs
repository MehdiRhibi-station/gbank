import assert from "node:assert/strict";
import test from "node:test";
import { groupQuestionParts } from "../lib/question-groups.mjs";

test("lettered subparts become one main question and one union crop", () => {
  const grouped = groupQuestionParts([
    {
      id: "25a1-1-a",
      ex: "25a1",
      o: 1,
      q: "1",
      s: "א",
      pts: "10",
      nat: "prove",
      lvl: "mid",
      top: ["limits"],
      title: "גבולות",
      st: "הוכיחו את טענה א",
      imagePage: 2,
      imageBbox: { x: 0.2, y: 0.1, w: 0.6, h: 0.2 },
    },
    {
      id: "25a1-1-b",
      ex: "25a1",
      o: 2,
      q: "1",
      s: "ב",
      pts: "10",
      nat: "compute",
      lvl: "hard",
      top: ["sequences"],
      title: "גבולות",
      st: "ב) חשבו את הגבול",
      imagePage: 2,
      imageBbox: { x: 0.15, y: 0.32, w: 0.7, h: 0.25 },
    },
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].q, "1");
  assert.equal(grouped[0].s, "");
  assert.match(grouped[0].st, /א\)/);
  assert.match(grouped[0].st, /ב\)/);
  assert.equal(grouped[0].lvl, "hard");
  assert.equal(grouped[0].nat, "mixed");
  assert.deepEqual(grouped[0].top, ["limits", "sequences"]);
  assert.equal(grouped[0].imagePage, 2);
  assert.deepEqual(grouped[0].imageBbox, {
    x: 0.01,
    y: 0.075,
    w: 0.98,
    h: 0.513,
  });
});

test("parts on different pages are grouped but blocked from automatic cropping", () => {
  const grouped = groupQuestionParts([
    {
      id: "q2a",
      ex: "exam",
      q: "2",
      s: "א",
      st: "first",
      imagePage: 2,
      imageBbox: { x: 0.1, y: 0.5, w: 0.8, h: 0.4 },
    },
    {
      id: "q2b",
      ex: "exam",
      q: "2",
      s: "ב",
      st: "second",
      imagePage: 3,
      imageBbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.3 },
    },
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].imagePage, undefined);
  assert.equal(grouped[0].imageBbox, undefined);
  assert.equal(grouped[0].unc, true);
});
