#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function usage() {
  console.log(`
GBank course importer

Usage:
  npm run import:course -- --data ./data/course-80131.json --pdf-dir "C:/Google Drive/gbank/80131"

Options:
  --data PATH                  Course JSON in the GBank export format (required)
  --pdf-dir PATH               Folder containing the exam PDFs
  --dry-run                    Validate and show what would be imported
  --archive-after-upload PATH  Move uploaded PDFs to this folder after full success
  --delete-after-upload        Delete uploaded PDFs only after full success
  --help                       Show this help

The importer is safe to run again: courses, exams and questions are upserted.
Downloaded files are kept unless an explicit cleanup option is supplied.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run" || value === "--delete-after-upload" || value === "--help") {
      args[value.slice(2)] = true;
      continue;
    }
    if (value.startsWith("--")) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
      args[value.slice(2)] = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
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

function validate(data) {
  const errors = [];
  if (!data?.course?.number) errors.push("course.number is required");
  if (!data?.course?.name) errors.push("course.name is required");
  if (!data?.exams || typeof data.exams !== "object") errors.push("exams must be an object");
  if (!Array.isArray(data?.questions)) errors.push("questions must be an array");
  if (!data?.topics || typeof data.topics !== "object") errors.push("topics must be an object");
  if (!data?.natures || typeof data.natures !== "object") errors.push("natures must be an object");
  if (errors.length) throw new Error(`Invalid course JSON:\n- ${errors.join("\n- ")}`);

  const examIds = new Set(Object.keys(data.exams));
  const questionIds = new Set();
  const printedIdentities = new Set();
  for (const question of data.questions) {
    if (!question.id) errors.push("Every question needs an id");
    if (questionIds.has(question.id)) errors.push(`Duplicate question id: ${question.id}`);
    questionIds.add(question.id);
    if (!examIds.has(question.ex)) errors.push(`Question ${question.id} refers to missing exam ${question.ex}`);
    if (!question.st) errors.push(`Question ${question.id} has no statement`);
    const printedIdentity = `${question.ex}\u0000${question.q}\u0000${question.s ?? ""}`;
    if (printedIdentities.has(printedIdentity)) {
      errors.push(
        `Duplicate printed question in ${question.ex}: ${question.q}${question.s ?? ""}`,
      );
    }
    printedIdentities.add(printedIdentity);
  }
  if (errors.length) throw new Error(`Invalid course JSON:\n- ${errors.join("\n- ")}`);
}

function prefixedId(courseNumber, value) {
  const prefix = `${courseNumber}:`;
  return String(value).startsWith(prefix) ? String(value) : `${prefix}${value}`;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function upsertOrThrow(query, label) {
  const result = await query;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.data) {
    usage();
    throw new Error("--data is required");
  }
  if (args["delete-after-upload"] && args["archive-after-upload"]) {
    throw new Error("Choose either --delete-after-upload or --archive-after-upload, not both");
  }

  const projectRoot = process.cwd();
  const dataPath = path.resolve(projectRoot, args.data);
  const pdfDirectory = args["pdf-dir"] ? path.resolve(projectRoot, args["pdf-dir"]) : null;
  const archiveDirectory = args["archive-after-upload"]
    ? path.resolve(projectRoot, args["archive-after-upload"])
    : null;

  const data = JSON.parse(await readFile(dataPath, "utf8"));
  validate(data);

  const examEntries = Object.entries(data.exams);
  const localFiles = examEntries
    .map(([sourceId, exam]) => ({
      sourceId,
      exam,
      localPath: pdfDirectory ? path.join(pdfDirectory, exam.file) : null,
    }))
    .filter((item) => item.localPath && existsSync(item.localPath));
  const sourceHashes = new Map();
  for (const item of localFiles) {
    sourceHashes.set(item.sourceId, sha256(await readFile(item.localPath)));
  }
  for (const [sourceId, exam] of examEntries) {
    if (!sourceHashes.has(sourceId) && exam.sourceHash) {
      sourceHashes.set(sourceId, String(exam.sourceHash));
    }
  }

  console.log(`Course: ${data.course.name} (${data.course.number})`);
  console.log(`Exams: ${examEntries.length}`);
  console.log(`Questions: ${data.questions.length}`);
  console.log(`Matching PDFs: ${localFiles.length}${pdfDirectory ? `/${examEntries.length}` : " (no --pdf-dir)"}`);

  if (args["dry-run"]) {
    for (const item of localFiles) console.log(`  upload ${item.exam.file}`);
    console.log("Dry run completed. Nothing was uploaded, changed or deleted.");
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
  const courseNumber = String(data.course.number);

  await upsertOrThrow(
    supabase.from("courses").upsert(
      {
        number: courseNumber,
        name: data.course.name,
        aliases: data.course.aliases ?? [],
        department: data.course.department ?? "האוניברסיטה העברית",
        topics: data.topics,
        natures: data.natures,
        is_published: true,
      },
      { onConflict: "number" },
    ),
    "Course import failed",
  );

  const existingExamResult = await supabase
    .from("exams")
    .select("id,source_filename,source_hash")
    .eq("course_number", courseNumber);
  if (existingExamResult.error) {
    throw new Error("Could not inspect existing exams: " + existingExamResult.error.message);
  }
  const existingByFilename = new Map(
    (existingExamResult.data ?? []).map((exam) => [exam.source_filename, exam]),
  );
  const existingByHash = new Map(
    (existingExamResult.data ?? [])
      .filter((exam) => exam.source_hash)
      .map((exam) => [exam.source_hash, exam]),
  );

  // A single PDF sometimes appears under more than one derived HUJI filename.
  // Collapse those aliases before writing so the source hash is a real dedupe
  // key, then map every draft exam reference to the surviving database row.
  const examGroups = new Map();
  for (const [sourceId, exam] of examEntries) {
    const digest = sourceHashes.get(sourceId) ?? null;
    const key = digest ? `hash:${digest}` : `file:${exam.file}`;
    const group = examGroups.get(key) ?? { sourceIds: [], sourceId, exam, digest };
    group.sourceIds.push(sourceId);
    examGroups.set(key, group);
  }

  const sourceIdToExamId = new Map();
  const hashedExamRows = [];
  const unhashedExamRows = [];
  for (const group of examGroups.values()) {
    const byHash = group.digest ? existingByHash.get(group.digest) : null;
    const byFilename = existingByFilename.get(group.exam.file);
    const existing = byHash ?? byFilename ?? null;
    const targetId = existing?.id ?? prefixedId(courseNumber, group.sourceId);
    for (const sourceId of group.sourceIds) sourceIdToExamId.set(sourceId, targetId);

    if (
      group.digest &&
      !byHash &&
      byFilename &&
      byFilename.source_hash !== group.digest
    ) {
      await upsertOrThrow(
        supabase
          .from("exams")
          .update({ source_hash: group.digest })
          .eq("id", byFilename.id),
        `Could not attach source hash to ${group.exam.file}`,
      );
    }

    const row = {
      id: targetId,
      course_number: courseNumber,
      ordinal: group.exam.n,
      year: group.exam.y,
      semester: group.exam.sem,
      moed: group.exam.moed,
      exam_date: group.exam.date,
      instructors: group.exam.teach,
      source_filename: byHash?.source_filename ?? group.exam.file,
      source_hash: group.digest ?? existing?.source_hash ?? null,
      questions_to_answer: group.exam.pick,
      is_published: true,
    };
    (group.digest ? hashedExamRows : unhashedExamRows).push(row);
  }
  if (hashedExamRows.length) {
    await upsertOrThrow(
      supabase.from("exams").upsert(hashedExamRows, {
        onConflict: "course_number,source_hash",
      }),
      "Hashed exam import failed",
    );
  }
  if (unhashedExamRows.length) {
    await upsertOrThrow(
      supabase.from("exams").upsert(unhashedExamRows, {
        onConflict: "course_number,source_filename",
      }),
      "Exam import failed",
    );
  }

  const uploadedFiles = [];
  const uploadedExamIds = new Set();
  for (const item of localFiles) {
    const targetExamId = sourceIdToExamId.get(item.sourceId);
    if (uploadedExamIds.has(targetExamId)) continue;
    const storagePath = `${courseNumber}/${item.exam.file}`;
    const bytes = await readFile(item.localPath);
    const upload = await supabase.storage.from("exam-files").upload(storagePath, bytes, {
      contentType: "application/pdf",
      cacheControl: "3600",
      upsert: true,
    });
    if (upload.error) throw new Error(`Upload failed for ${item.exam.file}: ${upload.error.message}`);
    await upsertOrThrow(
      supabase
        .from("exams")
        .update({ storage_path: storagePath })
        .eq("id", targetExamId),
      `Could not link ${item.exam.file}`,
    );
    uploadedExamIds.add(targetExamId);
    uploadedFiles.push(item.localPath);
    console.log(`Uploaded ${item.exam.file}`);
  }

  const questionRows = data.questions.map((question) => ({
    id: prefixedId(courseNumber, question.id),
    exam_id: sourceIdToExamId.get(question.ex) ?? prefixedId(courseNumber, question.ex),
    ordinal: question.o,
    question_number: question.q,
    subpart: question.s ?? "",
    points: question.pts ?? "",
    nature: question.nat,
    difficulty: question.lvl,
    topics: question.top ?? [],
    title: question.title,
    context: question.ctx ?? null,
    statement: question.st,
    uncertain: Boolean(question.unc),
    extractor: question.extractor ?? data.extractor ?? null,
    retired_at: null,
  }));
  for (const batch of chunks(questionRows, 500)) {
    await upsertOrThrow(
      supabase.from("questions").upsert(batch, {
        onConflict: "exam_id,question_number,subpart",
      }),
      "Question import failed",
    );
  }

  // Verification status is intentionally never accepted from JSON. It can
  // only be changed by mark_verified(). Image metadata is updated separately
  // so an older text-only draft cannot erase a crop that is already in use.
  for (const question of data.questions) {
    if (!question.imagePage || !question.imageBbox) continue;
    const update = {
      image_page: question.imagePage,
      image_bbox: question.imageBbox,
    };
    const examId = sourceIdToExamId.get(question.ex) ?? prefixedId(courseNumber, question.ex);
    const result = await supabase
      .from("questions")
      .update(update)
      .eq("exam_id", examId)
      .eq("question_number", question.q)
      .eq("subpart", question.s ?? "")
      .select("id");
    if (result.error) {
      throw new Error(`Question image metadata failed for ${question.id}: ${result.error.message}`);
    }
    if (result.data?.length !== 1) {
      throw new Error(
        `Question image metadata matched ${result.data?.length ?? 0} rows for ${question.id}`,
      );
    }
  }

  // Retirement is deliberately last. A failed upsert leaves the old live set
  // intact; a successful import hides missing questions without deleting their
  // hints, votes or progress.
  const keptIds = questionRows.map((question) => question.id);
  const retireResult = await supabase.rpc("retire_missing_questions", {
    p_course_number: courseNumber,
    p_kept_ids: keptIds,
  });
  if (retireResult.error) {
    throw new Error("Could not retire missing questions: " + retireResult.error.message);
  }
  console.log(`Retired ${retireResult.data ?? 0} missing question(s).`);

  if (archiveDirectory && uploadedFiles.length) {
    await mkdir(archiveDirectory, { recursive: true });
    for (const source of uploadedFiles) {
      await rename(source, path.join(archiveDirectory, path.basename(source)));
    }
    console.log(`Moved ${uploadedFiles.length} uploaded PDFs to ${archiveDirectory}`);
  } else if (args["delete-after-upload"] && uploadedFiles.length) {
    for (const source of uploadedFiles) await unlink(source);
    console.log(`Deleted ${uploadedFiles.length} uploaded PDFs after successful import.`);
  }

  console.log("Import completed successfully.");
}

main().catch((error) => {
  console.error(`\nImport stopped: ${error.message}`);
  process.exitCode = 1;
});
