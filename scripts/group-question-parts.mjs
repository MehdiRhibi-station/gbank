#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { groupCourseDraft } from "../lib/question-groups.mjs";

function usage() {
  console.log(`
Merge extracted subparts into top-level questions

Usage:
  npm run group:questions -- --data ".\\imports\\80131\\course-80131.json"

Options:
  --data PATH    Existing extracted course JSON (required)
  --output PATH  Destination JSON (default: course-NUMBER-main-questions.json)
  --help         Show this help
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help") {
      args.help = true;
      continue;
    }
    if (value !== "--data" && value !== "--output") throw new Error(`Unknown option: ${value}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
    args[value.slice(2)] = next;
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.data) {
    usage();
    if (!args.help) throw new Error("--data is required");
    return;
  }
  const input = path.resolve(process.cwd(), args.data);
  if (!existsSync(input)) throw new Error(`File not found: ${input}`);
  const source = JSON.parse(await readFile(input, "utf8"));
  const grouped = groupCourseDraft(source);
  const course = String(grouped.course?.number ?? "course");
  const output = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.join(path.dirname(input), `course-${course}-main-questions.json`);
  await writeFile(output, JSON.stringify(grouped, null, 2) + "\n", "utf8");
  console.log(`Extracted rows: ${source.questions?.length ?? 0}`);
  console.log(`Main questions: ${grouped.questions.length}`);
  console.log(`Questions needing manual page work: ${grouped.questions.filter((q) => !q.imagePage || !q.imageBbox).length}`);
  console.log(`Output: ${output}`);
}

main().catch((error) => {
  console.error("\nQuestion grouping stopped: " + error.message);
  process.exitCode = 1;
});
