#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pdf } from "pdf-to-img";
import sharp from "sharp";

const STORAGE_BUCKET = "exam-files";
const EXTRA_PADDING = 0.008;

function usage() {
  console.log(`
Create and upload original-scan question crops

Usage:
  npm run crop:questions -- 80181 --pdf-dir "C:/path/to/80181"

Options:
  --pdf-dir PATH   Folder containing source PDFs (storage is the fallback)
  --scale NUMBER   PDF render scale (default: 3)
  --dry-run        Show eligible questions without rendering or uploading
  --help           Show this help
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
    if (name === "dry-run" || name === "help") {
      args[name] = true;
      continue;
    }
    if (name !== "pdf-dir" && name !== "scale") throw new Error("Unknown option: " + value);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error("Missing value for " + value);
    args[name] = next;
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

function safeSegment(value) {
  return String(value).replace(/[^\p{L}\p{N}._:-]+/gu, "-");
}

function paddedBox(box) {
  const x = Math.max(0, Number(box.x) - EXTRA_PADDING);
  const y = Math.max(0, Number(box.y) - EXTRA_PADDING);
  const right = Math.min(1, Number(box.x) + Number(box.w) + EXTRA_PADDING);
  const bottom = Math.min(1, Number(box.y) + Number(box.h) + EXTRA_PADDING);
  return { x, y, w: right - x, h: bottom - y };
}

async function renderPages(input, scale) {
  const document = await pdf(input, { scale });
  const pages = [];
  try {
    for await (const page of document) pages.push(Buffer.from(page));
  } finally {
    await document.destroy();
  }
  return pages;
}

async function sourcePdf(exam, pdfDirectory, supabase) {
  const localPath = pdfDirectory ? path.join(pdfDirectory, exam.source_filename) : null;
  if (localPath && existsSync(localPath)) return localPath;
  if (!exam.storage_path) {
    throw new Error(`No local PDF or storage_path for ${exam.source_filename}`);
  }
  const result = await supabase.storage.from(STORAGE_BUCKET).download(exam.storage_path);
  if (result.error) {
    throw new Error(`Could not download ${exam.source_filename}: ${result.error.message}`);
  }
  const bytes = Buffer.from(await result.data.arrayBuffer());
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`Stored object is not a PDF: ${exam.storage_path}`);
  }
  return `data:application/pdf;base64,${bytes.toString("base64")}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const course = String(args.course ?? "").trim();
  if (!/^\d{4,8}$/.test(course)) {
    usage();
    throw new Error("A 4–8 digit course number is required.");
  }
  const scale = Number.parseFloat(args.scale ?? "3");
  if (!Number.isFinite(scale) || scale < 1 || scale > 6) {
    throw new Error("--scale must be between 1 and 6.");
  }

  const projectRoot = process.cwd();
  await loadEnvFile(path.join(projectRoot, ".env.local"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  }
  const pdfDirectory = args["pdf-dir"]
    ? path.resolve(projectRoot, args["pdf-dir"])
    : null;
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const examResult = await supabase
    .from("exams")
    .select("id,source_filename,storage_path")
    .eq("course_number", course);
  if (examResult.error) throw new Error("Could not load exams: " + examResult.error.message);
  const exams = new Map((examResult.data ?? []).map((exam) => [exam.id, exam]));
  if (!exams.size) throw new Error("No database exams found for course " + course);

  const questionResult = await supabase
    .from("questions")
    .select("id,exam_id,image_page,image_bbox,image_path")
    .in("exam_id", [...exams.keys()])
    .is("retired_at", null)
    .is("image_path", null)
    .not("image_bbox", "is", null)
    .order("exam_id")
    .order("ordinal");
  if (questionResult.error) {
    throw new Error("Could not load crop candidates: " + questionResult.error.message);
  }
  const questions = questionResult.data ?? [];
  console.log(`Eligible questions: ${questions.length}`);
  if (!questions.length) return;
  if (args["dry-run"]) {
    for (const question of questions) {
      console.log(`  ${question.id}: ${question.exam_id}, page ${question.image_page}`);
    }
    console.log("Dry run completed. No images were rendered, uploaded, or linked.");
    return;
  }

  const grouped = new Map();
  for (const question of questions) {
    const list = grouped.get(question.exam_id) ?? [];
    list.push(question);
    grouped.set(question.exam_id, list);
  }

  let uploaded = 0;
  for (const [examId, examQuestions] of grouped) {
    const exam = exams.get(examId);
    console.log(`Rendering ${exam.source_filename} once for ${examQuestions.length} crop(s)...`);
    const input = await sourcePdf(exam, pdfDirectory, supabase);
    const pages = await renderPages(input, scale);

    for (const question of examQuestions) {
      const pageNumber = Number(question.image_page);
      const pageBuffer = pages[pageNumber - 1];
      if (!pageBuffer) {
        console.warn(`  skipped ${question.id}: page ${pageNumber} does not exist`);
        continue;
      }
      const metadata = await sharp(pageBuffer).metadata();
      const pageWidth = metadata.width;
      const pageHeight = metadata.height;
      if (!pageWidth || !pageHeight) {
        console.warn(`  skipped ${question.id}: rendered page has no dimensions`);
        continue;
      }

      const box = paddedBox(question.image_bbox);
      const left = Math.max(0, Math.floor(box.x * pageWidth));
      const top = Math.max(0, Math.floor(box.y * pageHeight));
      const width = Math.max(1, Math.min(pageWidth - left, Math.ceil(box.w * pageWidth)));
      const height = Math.max(1, Math.min(pageHeight - top, Math.ceil(box.h * pageHeight)));
      const crop = await sharp(pageBuffer)
        .extract({ left, top, width, height })
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });
      const storagePath = [
        "crops",
        safeSegment(course),
        safeSegment(examId),
        safeSegment(question.id) + ".png",
      ].join("/");

      const upload = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, crop.data, {
          contentType: "image/png",
          cacheControl: "31536000",
          upsert: true,
        });
      if (upload.error) {
        console.warn(`  upload failed for ${question.id}: ${upload.error.message}`);
        continue;
      }

      const update = await supabase
        .from("questions")
        .update({
          image_path: storagePath,
          image_width: crop.info.width,
          image_height: crop.info.height,
        })
        .eq("id", question.id)
        .is("image_path", null);
      if (update.error) {
        console.warn(`  uploaded but not linked ${question.id}: ${update.error.message}`);
        continue;
      }
      uploaded += 1;
      console.log(`  uploaded ${storagePath}`);
    }
  }

  console.log(`Created and linked ${uploaded}/${questions.length} crop(s).`);
}

main().catch((error) => {
  console.error("\nCropping stopped: " + error.message);
  process.exitCode = 1;
});
