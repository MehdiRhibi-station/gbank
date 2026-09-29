#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pdf } from "pdf-to-img";
import sharp from "sharp";
import {
  BOX_REPAIR_VERSION,
  boxRepairPrompt,
  canonicalQuestionNumber,
  deriveQuestionRegions,
  normalisePageDetections,
  repairCourseDraft,
} from "../lib/question-box-repair.mjs";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          questionNumber: {
            type: "STRING",
            description: "The literal top-level number printed after the Hebrew word שאלה",
          },
          top: {
            type: "INTEGER",
            description: "Top edge on a 0–1000 vertical page scale",
          },
          bottom: {
            type: "INTEGER",
            description: "Bottom edge on a 0–1000 vertical page scale",
          },
          continuesToNextPage: {
            type: "BOOLEAN",
            description: "True only when this question visibly continues beyond this page",
          },
          confidence: {
            type: "INTEGER",
            description: "Confidence from 0 to 100 that the printed number and boundaries are correct",
          },
        },
        required: ["questionNumber", "top", "bottom", "continuesToNextPage", "confidence"],
      },
    },
  },
  required: ["questions"],
};

function usage() {
  console.log(`
Realign question crop boxes to the literal printed question numbers

Usage:
  npm run repair:boxes -- 80131 --data ".\\imports\\80131\\course-80131-main-questions.json" --pdf-dir ".\\imports\\80131"

Options:
  --data PATH        Existing course JSON; text is preserved (required)
  --pdf-dir PATH     Folder containing the exam PDFs (required)
  --exam ID_OR_FILE  Repair only one exam; may be repeated
  --output PATH      Repaired JSON destination (default: course-NUMBER-realigned.json)
  --model NAME       Gemini model (default: GEMINI_MODEL or gemini-3.8-flash)
  --cache-dir PATH   Resumable per-page results (default: .box-repair-cache beside input)
  --scale NUMBER     PDF render scale, 1–4 (default: 2)
  --delay-ms NUMBER  Delay between new API calls (default: 1800)
  --all-pages        Inspect every PDF page instead of pages currently assigned to questions
  --force            Ignore saved page detections and call Gemini again
  --dry-run          Show exams/pages without calling Gemini or writing output
  --help             Show this help

This tool changes only imagePage/imageBbox metadata. It never rewrites the
question statement, title, topics, exam metadata, or answer content. Ambiguous
or multi-page questions lose their automatic box so they cannot be published
with a misleading crop.
`);
}

function parseArgs(argv) {
  const args = { exams: [] };
  const flags = new Set(["all-pages", "force", "dry-run", "help"]);
  const values = new Set([
    "data", "pdf-dir", "exam", "output", "model", "cache-dir", "scale", "delay-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      if (args.course) throw new Error("Only one course number can be supplied.");
      args.course = value;
      continue;
    }
    const name = value.slice(2);
    if (flags.has(name)) {
      args[name] = true;
      continue;
    }
    if (!values.has(name)) throw new Error(`Unknown option: ${value}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
    if (name === "exam") args.exams.push(next);
    else args[name] = next;
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseJsonText(text) {
  const cleaned = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function responseText(document) {
  return (document?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part?.text ?? "")
    .join("")
    .trim();
}

async function locatePrintedQuestions({ apiKey, model, image, prompt }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: image.toString("base64") } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  let lastError;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        const text = responseText(payload);
        if (!text) throw new Error("Gemini returned no JSON text");
        return parseJsonText(text);
      }
      const message = payload?.error?.message ?? `${response.status} ${response.statusText}`;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable) throw new Error(message);
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
      const retryable = error?.name === "TimeoutError" || error instanceof TypeError ||
        /high demand|temporar|unavailable|rate|timeout|fetch failed/i.test(error?.message ?? "");
      if (!retryable) throw error;
    }
    if (attempt === 6) break;
    const delay = Math.min(60_000, 3_000 * (2 ** attempt)) + Math.floor(Math.random() * 900);
    console.log(`      Gemini busy; retrying in ${Math.ceil(delay / 1000)}s...`);
    await sleep(delay);
  }
  throw lastError ?? new Error("Gemini request failed");
}

function examMatches(sourceId, exam, requested) {
  if (!requested.length) return true;
  const candidates = new Set([
    String(sourceId).toLocaleLowerCase(),
    String(exam?.file ?? "").toLocaleLowerCase(),
    path.basename(String(exam?.file ?? ""), path.extname(String(exam?.file ?? ""))).toLocaleLowerCase(),
  ]);
  return requested.some((value) => candidates.has(String(value).toLocaleLowerCase()));
}

function expectedNumbers(data, examId) {
  return [...new Set(
    (data.questions ?? [])
      .filter((question) => String(question.ex) === String(examId))
      .map((question) => canonicalQuestionNumber(question.q))
      .filter(Boolean),
  )];
}

function assignedPages(data, examId) {
  return new Set(
    (data.questions ?? [])
      .filter((question) => String(question.ex) === String(examId))
      .map((question) => Number(question.imagePage))
      .filter((page) => Number.isInteger(page) && page >= 1),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const course = String(args.course ?? "").trim();
  if (!/^\d{4,8}$/.test(course) || !args.data || !args["pdf-dir"]) {
    usage();
    throw new Error("Course number, --data and --pdf-dir are required.");
  }

  const projectRoot = process.cwd();
  const dataPath = path.resolve(projectRoot, args.data);
  const pdfDirectory = path.resolve(projectRoot, args["pdf-dir"]);
  if (!existsSync(dataPath)) throw new Error(`Course JSON not found: ${dataPath}`);
  if (!existsSync(pdfDirectory)) throw new Error(`PDF directory not found: ${pdfDirectory}`);
  const data = JSON.parse(String(await readFile(dataPath, "utf8")).replace(/^\uFEFF/, ""));
  if (String(data?.course?.number ?? "") !== course) {
    throw new Error(`Input file is for course ${data?.course?.number ?? "unknown"}, not ${course}.`);
  }

  const scale = Number.parseFloat(args.scale ?? "2");
  const delayMs = Number.parseInt(args["delay-ms"] ?? "1800", 10);
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new Error("--scale must be 1–4.");
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error("--delay-ms must be zero or greater.");

  const exams = Object.entries(data.exams ?? {})
    .filter(([sourceId, exam]) => examMatches(sourceId, exam, args.exams));
  if (!exams.length) throw new Error("No exams matched --exam.");
  const missingPdfs = exams
    .filter(([, exam]) => !existsSync(path.join(pdfDirectory, String(exam.file ?? ""))))
    .map(([, exam]) => exam.file);
  if (missingPdfs.length) {
    throw new Error(`Missing PDF(s): ${missingPdfs.join(", ")}`);
  }

  console.log(`Course: ${data.course.name} (${course})`);
  console.log(`Selected exams: ${exams.length}`);
  for (const [sourceId, exam] of exams) {
    const pages = [...assignedPages(data, sourceId)].sort((a, b) => a - b);
    console.log(`  ${exam.file}: ${args["all-pages"] ? "all pages" : `${pages.length} assigned page(s)`}`);
  }
  if (args["dry-run"]) {
    console.log("Dry run completed. Gemini was not called and no file was written.");
    return;
  }

  await loadEnvFile(path.join(projectRoot, ".env.local"));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Add GEMINI_API_KEY to .env.local");
  const model = args.model || process.env.GEMINI_MODEL || process.env.GEMINI_EXTRACT_MODEL || "gemini-3.8-flash";
  const cacheDirectory = args["cache-dir"]
    ? path.resolve(projectRoot, args["cache-dir"])
    : path.join(path.dirname(dataPath), ".box-repair-cache");
  await mkdir(cacheDirectory, { recursive: true });

  const regionsByExam = new Map();
  const allIssues = [];
  let newCalls = 0;
  for (const [sourceId, exam] of exams) {
    const wantedPages = assignedPages(data, sourceId);
    const pdfPath = path.join(pdfDirectory, exam.file);
    const document = await pdf(pdfPath, { scale });
    const pageDetections = [];
    let pageNumber = 0;
    console.log(`Inspecting ${exam.file}...`);
    try {
      for await (const rendered of document) {
        pageNumber += 1;
        if (!args["all-pages"] && !wantedPages.has(pageNumber)) continue;
        const examCache = path.join(
          cacheDirectory,
          path.basename(exam.file, path.extname(exam.file)),
        );
        const cachePath = path.join(examCache, `page-${String(pageNumber).padStart(4, "0")}.json`);
        let raw;
        if (!args.force && existsSync(cachePath)) {
          const saved = JSON.parse(String(await readFile(cachePath, "utf8")).replace(/^\uFEFF/, ""));
          if (saved.version === BOX_REPAIR_VERSION && saved.model === model) raw = saved.response;
        }
        if (raw) {
          console.log(`  page ${pageNumber}: kept saved detection`);
        } else {
          const jpeg = await sharp(Buffer.from(rendered))
            .resize({ width: 1800, withoutEnlargement: true })
            .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
            .toBuffer();
          if (newCalls > 0 && delayMs) await sleep(delayMs);
          console.log(`  page ${pageNumber}: locating printed question numbers with ${model}...`);
          raw = await locatePrintedQuestions({
            apiKey,
            model,
            image: jpeg,
            prompt: boxRepairPrompt({
              filename: exam.file,
              page: pageNumber,
              expectedNumbers: expectedNumbers(data, sourceId),
            }),
          });
          newCalls += 1;
          await mkdir(examCache, { recursive: true });
          await writeFile(
            cachePath,
            JSON.stringify({
              version: BOX_REPAIR_VERSION,
              model,
              sourceFilename: exam.file,
              page: pageNumber,
              response: raw,
            }, null, 2) + "\n",
            "utf8",
          );
        }
        const normalized = normalisePageDetections(raw, { page: pageNumber });
        pageDetections.push(...normalized.detections);
        allIssues.push(...normalized.issues.map((issue) => `${sourceId}, page ${pageNumber}: ${issue}`));
      }
    } finally {
      await document.destroy();
    }
    const derived = deriveQuestionRegions(pageDetections);
    regionsByExam.set(sourceId, derived.regions);
    allIssues.push(...derived.issues.map((issue) => `${sourceId}: ${issue}`));
    console.log(`  found ${derived.regions.length} unique printed question region(s)`);
  }

  const selectedExamIds = exams.map(([sourceId]) => sourceId);
  const { output, report } = repairCourseDraft(data, {
    selectedExamIds,
    regionsByExam,
    model,
  });
  output.cropBoxRepair = {
    version: BOX_REPAIR_VERSION,
    generatedAt: new Date().toISOString(),
    model,
    selectedExams: selectedExamIds,
    updated: report.updated.length,
    blocked: report.blocked.length,
    issues: allIssues,
  };

  const outputPath = args.output
    ? path.resolve(projectRoot, args.output)
    : path.join(path.dirname(dataPath), `course-${course}-realigned.json`);
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Updated question rows: ${report.updated.length}`);
  console.log(`Blocked unsafe/missing rows: ${report.blocked.length}`);
  console.log(`Unexpected printed labels: ${report.unexpectedDetections.length}`);
  if (allIssues.length) {
    console.log("Issues requiring attention:");
    for (const issue of allIssues) console.log(`  - ${issue}`);
  }
  for (const item of report.blocked.slice(0, 20)) {
    console.log(`  blocked ${item.id}: ${item.reason}`);
  }
  if (report.blocked.length > 20) console.log(`  ...and ${report.blocked.length - 20} more`);
  console.log(`Repaired draft: ${outputPath}`);
  console.log("Question text was not changed.");
}

main().catch((error) => {
  console.error("\nQuestion-box repair stopped: " + error.message);
  process.exitCode = 1;
});
