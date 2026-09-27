#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { reviewRows } from "../lib/crop-safety.mjs";

function usage() {
  console.log(`
Apply human review decisions for source images

Usage:
  npm run review:crops -- 80181 --file ".\\Downloads\\crop-decisions-80181.json" --dry-run
  npm run review:crops -- 80181 --file ".\\Downloads\\crop-decisions-80181.json" --publish

Options:
  --file PATH   JSON downloaded from crop-review/COURSE/index.html (required)
  --publish     Publish approved questions after recording their review
  --dry-run     Validate decisions and current image paths without changing DB
  --help        Show this help

The script refuses stale decisions: every storagePath in the review file must
still be the exact image_path attached to that question.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      if (args.course) throw new Error("Only one course number can be supplied.");
      args.course = value;
      continue;
    }
    const name = value.slice(2);
    if (name === "dry-run" || name === "publish" || name === "help") {
      args[name] = true;
      continue;
    }
    if (name !== "file") throw new Error("Unknown option: " + value);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error("Missing value for " + value);
    args.file = next;
    index += 1;
  }
  return args;
}

async function loadEnvFile(filename) {
  if (!existsSync(filename)) return;
  const text = await readFile(filename, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const divider = line.indexOf("=");
    if (divider < 1) continue;
    const key = line.slice(0, divider).trim();
    let value = line.slice(divider + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const course = String(args.course ?? "").trim();
  if (!/^\d{4,8}$/.test(course) || !args.file) {
    usage();
    throw new Error("A course number and --file are required.");
  }

  const projectRoot = process.cwd();
  const reviewPath = path.resolve(projectRoot, args.file);
  const document = JSON.parse(await readFile(reviewPath, "utf8"));
  const rows = reviewRows(document, course);
  const decided = rows.filter((row) => row.decision !== "pending");
  const approved = decided.filter((row) => row.decision === "approved");
  const rejected = decided.filter((row) => row.decision === "rejected");
  console.log(`Review file: ${reviewPath}`);
  console.log(`Approved: ${approved.length}`);
  console.log(`Rejected: ${rejected.length}`);
  console.log(`Still pending: ${rows.length - decided.length}`);
  if (!decided.length) {
    console.log("No decisions to apply.");
    return;
  }

  await loadEnvFile(path.join(projectRoot, ".env.local"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  }
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const examResult = await supabase
    .from("exams")
    .select("id")
    .eq("course_number", course);
  if (examResult.error) throw new Error("Could not load course exams: " + examResult.error.message);
  const examIds = (examResult.data ?? []).map((exam) => exam.id);
  if (!examIds.length) throw new Error("No database exams found for course " + course);

  const currentRows = [];
  for (const batch of chunks(decided.map((row) => row.id), 200)) {
    const result = await supabase
      .from("questions")
      .select("id,image_path,retired_at")
      .in("exam_id", examIds)
      .in("id", batch);
    if (result.error) throw new Error("Could not validate review rows: " + result.error.message);
    currentRows.push(...(result.data ?? []));
  }
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  for (const decision of decided) {
    const current = currentById.get(decision.id);
    if (!current) throw new Error(`Question is missing or belongs to another course: ${decision.id}`);
    if (current.retired_at) throw new Error(`Question is retired: ${decision.id}`);
    if (current.image_path !== decision.storagePath) {
      throw new Error(
        `Stale review for ${decision.id}. The database image changed; review the new image instead.`,
      );
    }
  }

  if (args["dry-run"]) {
    console.log("Dry run completed. Every decision matches the current image; the database was not changed.");
    return;
  }

  let applied = 0;
  let published = 0;
  for (const decision of decided) {
    const review = await supabase.rpc("mark_crop_reviewed", {
      p_question_id: decision.id,
      p_expected_image_path: decision.storagePath,
      p_approved: decision.decision === "approved",
    });
    if (review.error) throw new Error(`Could not review ${decision.id}: ${review.error.message}`);
    applied += 1;

    if (args.publish && decision.decision === "approved") {
      const publish = await supabase
        .from("questions")
        .update({ is_published: true })
        .eq("id", decision.id)
        .eq("image_path", decision.storagePath)
        .select("id");
      if (publish.error) throw new Error(`Could not publish ${decision.id}: ${publish.error.message}`);
      if (publish.data?.length !== 1) {
        throw new Error(`Publication matched ${publish.data?.length ?? 0} rows for ${decision.id}`);
      }
      published += 1;
    }
  }

  console.log(`Applied ${applied} review decision(s).`);
  console.log(
    args.publish
      ? `Published ${published} approved question(s); rejected and pending questions remain hidden.`
      : "Nothing was published. Run again with --publish after checking the summary.",
  );
}

main().catch((error) => {
  console.error("\nCrop review stopped: " + error.message);
  process.exitCode = 1;
});
