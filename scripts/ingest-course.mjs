#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  normaliseItem,
  overlappingBoxes,
  pagePrompt,
} from "../lib/extraction-prompt.mjs";

const HUJI_SEARCH_URL = "https://www4.huji.ac.il/htbin/exams/exams.cgi";
const DEFAULT_FROM_YEAR = 2016;
const DEFAULT_MODEL = "gpt-6-sol";
const DEFAULT_LOCAL_MODEL = "qwen3-vl:8b";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

const NATURE_LABELS = {
  compute: "חישוב",
  prove: "הוכחה",
  mixed: "חישוב והוכחה",
  definition: "הגדרה",
  "true-false": "נכון או לא נכון",
  "multiple-choice": "שאלה אמריקאית",
};

function usage() {
  console.log([
    "",
    "GBank private course ingestion",
    "",
    "Interactive:",
    "  npm run ingest:course",
    "",
    "Examples:",
    "  npm run ingest:course -- 80420",
    "  npm run ingest:course -- 80420 --latest",
    "  npm run ingest:course -- 80420 --from 2016 --to 2026",
    "  npm run ingest:course -- 80420 --download-only",
    "  npm run ingest:course -- 80420 --draft-only",
    "  npm run ingest:local",
    "",
    "Options:",
    "  --all                         Download all listed exams in the year range",
    "  --latest                      Download only the newest listed exam",
    "  --from YEAR                   First year (default: 2016)",
    "  --to YEAR                     Last year (default: current year)",
    "  --course-name NAME            Override the course name",
    "  --output-dir PATH             Work folder (default: imports/COURSE_NUMBER)",
    "  --model MODEL                 OpenAI extraction model",
    "  --local                       Extract with a local Ollama model (no AI API key)",
    "  --local-model MODEL           Ollama vision model (default: qwen3-vl:8b)",
    "  --ollama-url URL              Local Ollama server URL",
    "  --drive-dir PATH              Save the course under PATH/COURSE_NUMBER",
    "  --force-extract               Re-extract even when cached questions exist",
    "  --download-only               Download PDFs and stop",
    "  --draft-only                  Build the JSON draft but do not import it",
    "  --yes                         Accept extraction/import confirmations",
    "  --archive-after-upload PATH   Move PDFs after a successful import",
    "  --delete-after-upload         Delete PDFs after a successful import",
    "  --help                        Show this help",
    "",
    "Local mode needs Ollama, but no OpenAI key. It renders the PDFs locally and",
    "uses a vision model running on this computer. Database upload still requires",
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    "",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {};
  const booleanOptions = new Set([
    "all",
    "latest",
    "force-extract",
    "download-only",
    "draft-only",
    "yes",
    "delete-after-upload",
    "local",
    "help",
  ]);
  const valueOptions = new Set([
    "from",
    "to",
    "course-name",
    "output-dir",
    "model",
    "local-model",
    "ollama-url",
    "drive-dir",
    "archive-after-upload",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      if (args.courseNumber) throw new Error("Only one course number can be supplied.");
      args.courseNumber = value;
      continue;
    }

    const name = value.slice(2);
    if (booleanOptions.has(name)) {
      args[name] = true;
      continue;
    }
    if (valueOptions.has(name)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("Missing value for " + value);
      args[name] = next;
      index += 1;
      continue;
    }
    throw new Error("Unknown option: " + value);
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function isRealSecret(value) {
  return Boolean(value && !value.includes("YOUR_") && !value.includes("replace-me"));
}

function validateCourseNumber(value) {
  const number = String(value || "").trim();
  if (!/^\d{4,8}$/.test(number)) {
    throw new Error("Course number must contain 4 to 8 digits.");
  }
  return number;
}

function parseYear(value, label) {
  const year = Number.parseInt(String(value), 10);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new Error(label + " must be a four-digit year.");
  }
  return year;
}

async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

async function confirm(question, assumeYes) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const answer = (await ask(question + " [y/N] ")).toLowerCase();
  return answer === "y" || answer === "yes";
}

function decodeHtml(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return String(value)
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, number) =>
      String.fromCodePoint(Number.parseInt(number, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function plainText(html) {
  return decodeHtml(
    String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function semesterLabel(value) {
  return { 1: "א", 2: "ב", 3: "קיץ" }[value] ?? String(value);
}

function moedLabel(value) {
  return { 1: "א", 2: "ב", 3: "ג" }[value] ?? String(value);
}

function examSortKey(exam) {
  return [
    Number(exam.year),
    Number(exam.semester),
    Number(exam.moed),
    Number(exam.version),
  ];
}

function compareExamInfo(left, right) {
  const a = examSortKey(left);
  const b = examSortKey(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return left.filename.localeCompare(right.filename);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Request timed out: " + url);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseArchiveRows(html, courseNumber) {
  const filenamePattern = new RegExp(
    "^" + courseNumber + "_(\\d{4})_(\\d+)_(\\d+)_(\\d+)\\.pdf$",
    "i",
  );
  const exams = [];
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];

  for (const row of rows) {
    const link = row.match(/href\s*=\s*["']([^"']+\.pdf(?:\?[^"']*)?)["']/i);
    if (!link) continue;

    let url;
    try {
      url = new URL(decodeHtml(link[1]), HUJI_SEARCH_URL);
    } catch {
      continue;
    }

    const filename = path.posix.basename(url.pathname);
    const parts = filename.match(filenamePattern);
    if (!parts) continue;
    if (url.protocol !== "https:" || url.hostname !== "www4.huji.ac.il") continue;
    if (!url.pathname.startsWith("/exams/")) continue;

    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
      plainText(match[1]),
    );
    exams.push({
      courseName: cells[0] || "",
      courseNumber,
      year: Number(parts[1]),
      semester: Number(parts[2]),
      moed: Number(parts[3]),
      version: Number(parts[4]),
      filename,
      url: url.href,
    });
  }

  const unique = new Map();
  for (const exam of exams) unique.set(exam.filename, exam);
  return [...unique.values()].sort(compareExamInfo);
}

async function discoverExams(courseNumber, fromYear, toYear) {
  const body = new URLSearchParams({
    action: "mode2",
    coursenum: courseNumber,
    year1: String(fromYear),
    year2: String(toYear),
    moed: "0",
    semester: "0",
  });
  const response = await fetchWithTimeout(HUJI_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "GBank owner import tool",
    },
    body,
  });
  if (!response.ok) {
    throw new Error("HUJI archive returned HTTP " + response.status);
  }

  const bytes = await response.arrayBuffer();
  let html;
  try {
    html = new TextDecoder("windows-1255").decode(bytes);
  } catch {
    html = new TextDecoder("utf-8").decode(bytes);
  }
  return parseArchiveRows(html, courseNumber);
}

async function isPdf(filename) {
  if (!existsSync(filename)) return false;
  const file = await readFile(filename);
  return file.length >= 5 && file.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function downloadExam(exam, directory) {
  const destination = path.join(directory, exam.filename);
  if (await isPdf(destination)) {
    console.log("  kept existing " + exam.filename);
    return destination;
  }

  const partial = destination + ".part";
  const response = await fetchWithTimeout(
    exam.url,
    { headers: { "User-Agent": "GBank owner import tool" } },
    180000,
  );
  if (!response.ok) {
    throw new Error("Could not download " + exam.filename + " (HTTP " + response.status + ")");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("HUJI did not return a PDF for " + exam.filename);
  }
  await writeFile(partial, bytes);
  await rename(partial, destination);
  console.log("  downloaded " + exam.filename);
  return destination;
}

async function writeJsonAtomic(filename, value) {
  const temporary = filename + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, filename);
}

function extractionSchema() {
  const stringField = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "courseName",
      "instructors",
      "examDate",
      "questionsToAnswer",
      "questions",
    ],
    properties: {
      courseName: stringField,
      instructors: stringField,
      examDate: stringField,
      questionsToAnswer: stringField,
      questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "questionNumber",
            "subpart",
            "points",
            "nature",
            "difficulty",
            "topics",
            "title",
            "context",
            "statement",
            "uncertain",
            "bbox",
          ],
          properties: {
            questionNumber: stringField,
            subpart: stringField,
            points: stringField,
            nature: {
              type: "string",
              enum: [
                "compute",
                "prove",
                "mixed",
                "definition",
                "true-false",
                "multiple-choice",
              ],
            },
            difficulty: {
              type: "string",
              enum: ["easy", "mid", "hard"],
            },
            topics: {
              type: "array",
              items: stringField,
            },
            title: stringField,
            context: stringField,
            statement: stringField,
            uncertain: { type: "boolean" },
            bbox: {
              type: "object",
              additionalProperties: false,
              required: ["x", "y", "w", "h"],
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
            },
          },
        },
      },
    },
  };
}

function responseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  throw new Error("OpenAI response did not contain structured text.");
}

function emptyExtraction() {
  return {
    courseName: "",
    instructors: "",
    examDate: "",
    questionsToAnswer: "",
    questions: [],
  };
}

function addPageExtraction(combined, raw, page, total) {
  if (!Array.isArray(raw?.questions)) {
    throw new Error(`Extraction for page ${page.number}/${total} has no questions array.`);
  }
  for (const field of ["courseName", "instructors", "examDate", "questionsToAnswer"]) {
    if (!combined[field] && raw[field]) combined[field] = String(raw[field]).trim();
  }

  const normalized = raw.questions.map((item) => normaliseItem(item, { page }));
  for (const overlap of overlappingBoxes(normalized)) {
    const issue = `bbox overlaps question ${overlap.secondLabel || overlap.second + 1}`;
    normalized[overlap.first].uncertain = true;
    normalized[overlap.first].bboxIssue ||= issue;
    normalized[overlap.first].imageBbox = null;
    normalized[overlap.second].uncertain = true;
    normalized[overlap.second].bboxIssue ||=
      `bbox overlaps question ${overlap.firstLabel || overlap.first + 1}`;
    normalized[overlap.second].imageBbox = null;
  }
  combined.questions.push(...normalized);
  return normalized
    .map((question) => `${question.questionNumber ?? ""}${question.subpart ?? ""}`.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

async function extractPdf(pdfPath, exam, _courseNumber, apiKey, model, topics = {}) {
  const pages = await renderPdfPages(pdfPath);
  const result = emptyExtraction();
  let lastLabel = "";
  for (const page of pages) {
    console.log(`      page ${page.number}/${pages.length}`);
    const body = {
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: pagePrompt(exam, page, pages.length, topics, lastLabel),
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Index this page and return the required JSON." },
            {
              type: "input_image",
              image_url: "data:image/png;base64," + page.base64,
              detail: "high",
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "gbank_page_extraction",
          strict: true,
          schema: extractionSchema(),
        },
      },
      max_output_tokens: 10000,
      store: false,
    };

    const response = await fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      600000,
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.error?.message || "HTTP " + response.status;
      throw new Error(
        `OpenAI extraction failed for ${exam.filename}, page ${page.number}: ${detail}`,
      );
    }
    const pageResult = JSON.parse(responseText(payload));
    lastLabel = addPageExtraction(result, pageResult, page, pages.length) || lastLabel;
  }
  return result;
}

function parseJsonResponse(value, label) {
  const raw = String(value ?? "").trim();
  const unwrapped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unwrapped);
  } catch {
    throw new Error(label + " returned invalid JSON.");
  }
}

function getLocalOllamaUrl(value) {
  let url;
  try {
    url = new URL(value || DEFAULT_OLLAMA_URL);
  } catch {
    throw new Error("OLLAMA_URL must be a valid local URL.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
    throw new Error(
      "Local extraction only accepts Ollama on localhost (for example " +
        DEFAULT_OLLAMA_URL +
        ").",
    );
  }
  return url;
}

function ollamaEndpoint(baseUrl, pathname) {
  return new URL(pathname, baseUrl).href;
}

async function ollamaModels(baseUrl) {
  let response;
  try {
    response = await fetchWithTimeout(ollamaEndpoint(baseUrl, "/api/tags"), {}, 10000);
  } catch {
    throw new Error(
      "Ollama is not running. Install and open Ollama, then run this command again: " +
        "https://ollama.com/download/windows",
    );
  }
  if (!response.ok) throw new Error("Ollama returned HTTP " + response.status + ".");
  const payload = await response.json();
  return payload.models ?? [];
}

function hasOllamaModel(models, requested) {
  const candidates = new Set(
    models.flatMap((model) => [model.name, model.model]).filter(Boolean),
  );
  return candidates.has(requested) || candidates.has(requested + ":latest");
}

async function pullOllamaModel(model) {
  console.log("Downloading local model " + model + ". This is a one-time large download...");
  await new Promise((resolve, reject) => {
    const child = spawn("ollama", ["pull", model], { stdio: "inherit" });
    child.on("error", () => {
      reject(
        new Error(
          "Could not start Ollama. Install it from https://ollama.com/download/windows",
        ),
      );
    });
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error("Ollama model download exited with " + (signal || "code " + code)));
    });
  });
}

async function ensureLocalModel(baseUrl, model, assumeYes) {
  let models = await ollamaModels(baseUrl);
  if (!hasOllamaModel(models, model)) {
    const approved = await confirm(
      "Download the local vision model " + model + " now? The default model is about 6 GB",
      assumeYes,
    );
    if (!approved) {
      throw new Error("Local model is missing. Run: ollama pull " + model);
    }
    await pullOllamaModel(model);
    models = await ollamaModels(baseUrl);
  }
  if (!hasOllamaModel(models, model)) {
    throw new Error("Ollama model is still unavailable: " + model);
  }

  const response = await fetchWithTimeout(
    ollamaEndpoint(baseUrl, "/api/show"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    },
    30000,
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("Could not inspect local model " + model + ": " + (payload.error || response.status));
  }
  if (Array.isArray(payload.capabilities) && !payload.capabilities.includes("vision")) {
    throw new Error(model + " is not a vision model. Use qwen3-vl:8b or another local vision model.");
  }
}

async function renderPdfPages(pdfPath) {
  let pdf;
  let sharp;
  try {
    ({ pdf } = await import("pdf-to-img"));
    ({ default: sharp } = await import("sharp"));
  } catch {
    throw new Error("PDF renderer is missing. Run npm install, then try again.");
  }

  const document = await pdf(pdfPath, { scale: 2 });
  const pages = [];
  try {
    for await (const page of document) {
      const buffer = Buffer.from(page);
      const metadata = await sharp(buffer).metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error("Rendered page has no dimensions in " + path.basename(pdfPath));
      }
      pages.push({
        number: pages.length + 1,
        width: metadata.width,
        height: metadata.height,
        base64: buffer.toString("base64"),
      });
    }
  } finally {
    await document.destroy();
  }
  if (!pages.length) throw new Error("No pages could be rendered from " + path.basename(pdfPath));
  return pages;
}

async function extractPdfLocally(
  pdfPath,
  exam,
  _courseNumber,
  baseUrl,
  model,
  topics = {},
) {
  const pages = await renderPdfPages(pdfPath);
  const schema = extractionSchema();
  const result = emptyExtraction();
  let lastLabel = "";
  for (const page of pages) {
    console.log(`      page ${page.number}/${pages.length}`);
    const response = await fetchWithTimeout(
      ollamaEndpoint(baseUrl, "/api/chat"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: "30m",
          format: schema,
          options: {
            temperature: 0,
            num_ctx: Number.parseInt(process.env.OLLAMA_CONTEXT_LENGTH || "32768", 10),
          },
          messages: [
            {
              role: "system",
              content:
                pagePrompt(exam, page, pages.length, topics, lastLabel) +
                "\nReturn JSON that exactly matches this schema: " +
                JSON.stringify(schema),
            },
            {
              role: "user",
              content: "Index this one exam page.",
              images: [page.base64],
            },
          ],
        }),
      },
      60 * 60 * 1000,
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `Local extraction failed for ${exam.filename}, page ${page.number}: ` +
          (payload.error || "HTTP " + response.status),
      );
    }
    const pageResult = parseJsonResponse(
      payload?.message?.content,
      `Local extraction for ${exam.filename}, page ${page.number}`,
    );
    lastLabel = addPageExtraction(result, pageResult, page, pages.length) || lastLabel;
  }
  return result;
}

function examInfoFromStored(exam) {
  const filename = String(exam.file || "");
  const match = filename.match(/_(\d{4})_(\d+)_(\d+)_(\d+)\.pdf$/i);
  return {
    year: match ? Number(match[1]) : Number(exam.y || 0),
    semester: match ? Number(match[2]) : 0,
    moed: match ? Number(match[3]) : 0,
    version: match ? Number(match[4]) : 0,
    filename,
  };
}

function sanitizeId(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function nextTopicId(topics) {
  let number = 1;
  while (topics["topic-" + String(number).padStart(3, "0")]) number += 1;
  return "topic-" + String(number).padStart(3, "0");
}

function topicIds(labels, topics) {
  const byLabel = new Map(
    Object.entries(topics).map(([id, label]) => [String(label).trim().toLowerCase(), id]),
  );
  const result = [];
  for (const rawLabel of labels ?? []) {
    const label = String(rawLabel).trim();
    if (!label) continue;
    const normalized = label.toLowerCase();
    let id = byLabel.get(normalized);
    if (!id) {
      id = nextTopicId(topics);
      topics[id] = label;
      byLabel.set(normalized, id);
    }
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function makeExamId(exam, usedIds) {
  const base =
    "e" +
    exam.year +
    "s" +
    exam.semester +
    "m" +
    exam.moed +
    "v" +
    exam.version;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = base + "-" + suffix;
    suffix += 1;
  }
  return candidate;
}

function makeQuestionId(examId, questionNumber, subpart, usedIds) {
  const token = sanitizeId(questionNumber + (subpart ? "-" + subpart : "")) || "question";
  const base = examId + "-" + token;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = base + "-" + suffix;
    suffix += 1;
  }
  return candidate;
}

function numericQuestion(value) {
  const match = String(value).match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function normalizeDraft(
  existing,
  selectedExams,
  extractions,
  courseNumber,
  courseNameOverride,
) {
  const data = existing
    ? structuredClone(existing)
    : {
        course: {
          number: courseNumber,
          name: courseNameOverride || "קורס " + courseNumber,
          aliases: [],
          department: "האוניברסיטה העברית",
        },
        exams: {},
        topics: {},
        natures: {},
        questions: [],
      };

  data.course = data.course ?? {};
  data.course.number = courseNumber;
  data.course.aliases = Array.isArray(data.course.aliases) ? data.course.aliases : [];
  data.course.department = data.course.department || "האוניברסיטה העברית";
  data.exams = data.exams && typeof data.exams === "object" ? data.exams : {};
  data.topics = data.topics && typeof data.topics === "object" ? data.topics : {};
  data.natures = data.natures && typeof data.natures === "object" ? data.natures : {};
  data.questions = Array.isArray(data.questions) ? data.questions : [];

  const firstExtractionName = [...extractions.values()]
    .map((item) => item.courseName)
    .find(Boolean);
  const discoveredName = selectedExams.map((item) => item.courseName).find(Boolean);
  data.course.name =
    courseNameOverride ||
    data.course.name ||
    firstExtractionName ||
    discoveredName ||
    "קורס " + courseNumber;

  const examIdByFile = new Map(
    Object.entries(data.exams).map(([id, exam]) => [exam.file, id]),
  );
  const usedExamIds = new Set(Object.keys(data.exams));
  const usedQuestionIds = new Set(data.questions.map((question) => question.id));

  for (const exam of selectedExams) {
    const extraction = extractions.get(exam.filename);
    let examId = examIdByFile.get(exam.filename);
    if (!examId) {
      examId = makeExamId(exam, usedExamIds);
      usedExamIds.add(examId);
      examIdByFile.set(exam.filename, examId);
    }

    const previous = data.exams[examId] ?? {};
    data.exams[examId] = {
      n: previous.n ?? 0,
      y: exam.year,
      sem: semesterLabel(exam.semester),
      moed: moedLabel(exam.moed),
      date: extraction?.examDate || previous.date || "",
      teach: extraction?.instructors || previous.teach || "",
      file: exam.filename,
      pick: extraction?.questionsToAnswer || previous.pick || "",
    };

    if (!extraction) continue;

    const oldQuestions = data.questions.filter((question) => question.ex === examId);
    const reusableId = new Map(
      oldQuestions.map((question) => [
        String(question.q) + "\u0000" + String(question.s ?? ""),
        question.id,
      ]),
    );
    data.questions = data.questions.filter((question) => question.ex !== examId);

    for (const question of extraction.questions) {
      const number = String(question.questionNumber || "").trim();
      const subpart = String(question.subpart || "").trim();
      const oldId = reusableId.get(number + "\u0000" + subpart);
      const id =
        oldId || makeQuestionId(examId, number, subpart, usedQuestionIds);
      usedQuestionIds.add(id);
      data.natures[question.nature] =
        data.natures[question.nature] || NATURE_LABELS[question.nature] || question.nature;
      data.questions.push({
        id,
        ex: examId,
        o: 0,
        q: number,
        s: subpart,
        pts: String(question.points || ""),
        nat: question.nature,
        lvl: question.difficulty,
        top: topicIds(question.topics, data.topics),
        title: String(question.title || "").trim(),
        ctx: String(question.context || "").trim() || undefined,
        st: String(question.statement || "").trim(),
        unc: Boolean(question.uncertain),
        extractor: question.extractor || extraction.extractor || undefined,
        imagePage: question.imagePage ?? undefined,
        imageBbox: question.imageBbox ?? undefined,
      });
    }
  }

  const orderedExams = Object.entries(data.exams).sort((left, right) =>
    compareExamInfo(examInfoFromStored(left[1]), examInfoFromStored(right[1])),
  );
  orderedExams.forEach(([_id, exam], index) => {
    exam.n = index + 1;
  });
  const examOrder = new Map(orderedExams.map(([id], index) => [id, index]));
  data.questions.sort((left, right) => {
    const examDifference =
      (examOrder.get(left.ex) ?? Number.MAX_SAFE_INTEGER) -
      (examOrder.get(right.ex) ?? Number.MAX_SAFE_INTEGER);
    if (examDifference) return examDifference;
    const numberDifference = numericQuestion(left.q) - numericQuestion(right.q);
    if (numberDifference) return numberDifference;
    return String(left.s ?? "").localeCompare(String(right.s ?? ""), "he");
  });
  data.questions.forEach((question, index) => {
    question.o = index + 1;
    if (question.ctx === undefined) delete question.ctx;
    if (!question.unc) delete question.unc;
    if (!question.extractor) delete question.extractor;
    if (!question.imagePage) delete question.imagePage;
    if (!question.imageBbox) delete question.imageBbox;
  });

  return data;
}

async function loadExistingDraft(projectRoot, outputDirectory, courseNumber) {
  const candidates = [
    path.join(outputDirectory, "course-" + courseNumber + ".json"),
    path.join(projectRoot, "data", "course-" + courseNumber + ".json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return {
      filename: candidate,
      data: JSON.parse(await readFile(candidate, "utf8")),
    };
  }
  return { filename: null, data: null };
}

function reusableExtraction(existing, exam) {
  if (!existing) return null;
  const entry = Object.entries(existing.exams ?? {}).find(
    ([_id, value]) => value.file === exam.filename,
  );
  if (!entry) return null;
  const [examId, storedExam] = entry;
  const questions = (existing.questions ?? []).filter((question) => question.ex === examId);
  if (
    !questions.length ||
    questions.some((question) => !question.imagePage || !question.imageBbox)
  ) {
    return null;
  }
  return {
    courseName: existing.course?.name || exam.courseName || "",
    instructors: storedExam.teach || "",
    examDate: storedExam.date || "",
    questionsToAnswer: storedExam.pick || "",
    questions: questions.map((question) => ({
      questionNumber: String(question.q ?? ""),
      subpart: String(question.s ?? ""),
      points: String(question.pts ?? ""),
      nature: question.nat || "mixed",
      difficulty: question.lvl || "mid",
      topics: (question.top ?? []).map((id) => existing.topics?.[id] || id),
      title: question.title || "",
      context: question.ctx || "",
      statement: question.st || "",
      uncertain: Boolean(question.unc),
      extractor: question.extractor || "reviewed-draft",
      imagePage: question.imagePage,
      imageBbox: question.imageBbox,
    })),
  };
}

function extractionHasCrops(extraction) {
  return Boolean(
    extraction &&
      Array.isArray(extraction.questions) &&
      extraction.questions.length &&
      extraction.questions.every(
        (question) => question.imagePage && question.imageBbox,
      ),
  );
}

async function runImporter(projectRoot, draftPath, outputDirectory, args) {
  const importerArgs = [
    path.join(projectRoot, "scripts", "import-course.mjs"),
    "--data",
    draftPath,
    "--pdf-dir",
    outputDirectory,
  ];
  if (args["archive-after-upload"]) {
    importerArgs.push(
      "--archive-after-upload",
      path.resolve(projectRoot, args["archive-after-upload"]),
    );
  }
  if (args["delete-after-upload"]) importerArgs.push("--delete-after-upload");

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, importerArgs, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error("Database importer exited with " + (signal || "code " + code)));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.all && args.latest) {
    throw new Error("Choose either --all or --latest, not both.");
  }
  if (args["delete-after-upload"] && args["archive-after-upload"]) {
    throw new Error(
      "Choose either --delete-after-upload or --archive-after-upload, not both.",
    );
  }

  const projectRoot = process.cwd();
  await loadEnvFile(path.join(projectRoot, ".env.local"));

  let courseInput = args.courseNumber;
  if (!courseInput) {
    if (!process.stdin.isTTY) {
      usage();
      throw new Error("A course number is required.");
    }
    courseInput = await ask("HUJI course number: ");
  }
  const courseNumber = validateCourseNumber(courseInput);

  let mode = args.latest ? "latest" : "all";
  if (!args.latest && !args.all && process.stdin.isTTY && !args.courseNumber) {
    const answer = await ask(
      "Download [1] every exam since 2016 or [2] only the latest exam? [1] ",
    );
    mode = answer === "2" ? "latest" : "all";
  }

  const currentYear = new Date().getUTCFullYear();
  const fromYear = parseYear(args.from ?? DEFAULT_FROM_YEAR, "--from");
  const toYear = parseYear(args.to ?? currentYear, "--to");
  if (fromYear > toYear) throw new Error("--from cannot be later than --to.");

  if (args["output-dir"] && args["drive-dir"]) {
    throw new Error("Choose either --output-dir or --drive-dir, not both.");
  }
  let driveDirectory = args["drive-dir"] || process.env.GBANK_DRIVE_DIR || "";
  if (args.local && !args["output-dir"] && !driveDirectory && process.stdin.isTTY) {
    driveDirectory = await ask(
      "Google Drive imports folder (for example G:\\My Drive\\GBank Imports): ",
    );
  }
  const requestedOutput = args["output-dir"]
    ? args["output-dir"]
    : driveDirectory
      ? path.join(driveDirectory, courseNumber)
      : path.join("imports", courseNumber);
  const outputDirectory = path.resolve(
    projectRoot,
    requestedOutput,
  );
  const cacheDirectory = path.join(outputDirectory, "extraction-cache");
  await mkdir(outputDirectory, { recursive: true });

  console.log(
    "Searching HUJI for course " +
      courseNumber +
      " (" +
      fromYear +
      "-" +
      toYear +
      ")...",
  );
  const discovered = await discoverExams(courseNumber, fromYear, toYear);
  if (!discovered.length) {
    throw new Error("No exams were listed by HUJI for that course and year range.");
  }
  const selected =
    mode === "latest" ? [discovered[discovered.length - 1]] : discovered;
  console.log(
    "Found " +
      discovered.length +
      " exam(s); selected " +
      selected.length +
      " (" +
      mode +
      ").",
  );

  const manifestPath = path.join(outputDirectory, "manifest.json");
  await writeJsonAtomic(manifestPath, {
    source: HUJI_SEARCH_URL,
    courseNumber,
    courseName: args["course-name"] || selected[0]?.courseName || "",
    fromYear,
    toYear,
    mode,
    discoveredAt: new Date().toISOString(),
    exams: selected,
  });

  console.log("Downloading PDFs to " + outputDirectory);
  const pdfPaths = new Map();
  for (const exam of selected) {
    pdfPaths.set(exam.filename, await downloadExam(exam, outputDirectory));
  }
  console.log("Manifest: " + manifestPath);

  if (args["download-only"]) {
    console.log("Download-only mode completed. No questions or database rows were changed.");
    return;
  }

  const existingResult = await loadExistingDraft(
    projectRoot,
    outputDirectory,
    courseNumber,
  );
  const extractions = new Map();
  const needsExtraction = [];

  await mkdir(cacheDirectory, { recursive: true });
  for (const exam of selected) {
    const cachePath = path.join(cacheDirectory, exam.filename + ".json");
    if (!args["force-extract"]) {
      const reused = reusableExtraction(existingResult.data, exam);
      if (reused) {
        extractions.set(exam.filename, reused);
        console.log("  preserved reviewed questions for " + exam.filename);
        continue;
      }
    }
    if (!args["force-extract"] && existsSync(cachePath)) {
      const cache = JSON.parse(await readFile(cachePath, "utf8"));
      const cachedExtraction = cache.result ?? cache;
      if (extractionHasCrops(cachedExtraction)) {
        extractions.set(exam.filename, cachedExtraction);
        console.log("  reused image-aware extraction cache for " + exam.filename);
        continue;
      }
      console.log("  ignored text-only extraction cache for " + exam.filename);
    }
    needsExtraction.push(exam);
  }

  if (needsExtraction.length) {
    let model;
    let provider;
    let extract;

    if (args.local) {
      model = args["local-model"] || process.env.OLLAMA_MODEL || DEFAULT_LOCAL_MODEL;
      const baseUrl = getLocalOllamaUrl(
        args["ollama-url"] || process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL,
      );
      await ensureLocalModel(baseUrl, model, args.yes);
      const approved = await confirm(
        "Extract questions from " +
          needsExtraction.length +
          " PDF(s) with local Ollama? This is free but can take several hours",
        args.yes,
      );
      if (!approved) {
        console.log("Stopped before local extraction. Downloaded PDFs were kept.");
        return;
      }
      provider = "ollama-local";
      extract = (pdfPath, exam) =>
        extractPdfLocally(
          pdfPath,
          exam,
          courseNumber,
          baseUrl,
          model,
          existingResult.data?.topics ?? {},
        );
    } else {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!isRealSecret(apiKey)) {
        throw new Error(
          needsExtraction.length +
            " PDF(s) need extraction. Add OPENAI_API_KEY to .env.local, or use npm run ingest:local. Downloaded files were kept.",
        );
      }
      const approved = await confirm(
        "Extract questions from " +
          needsExtraction.length +
          " PDF(s) with the OpenAI API? This uses your API account",
        args.yes,
      );
      if (!approved) {
        console.log("Stopped before AI extraction. Downloaded PDFs were kept.");
        return;
      }
      model = args.model || process.env.OPENAI_EXTRACT_MODEL || DEFAULT_MODEL;
      provider = "openai";
      extract = (pdfPath, exam) =>
        extractPdf(
          pdfPath,
          exam,
          courseNumber,
          apiKey,
          model,
          existingResult.data?.topics ?? {},
        );
    }

    console.log(
      "Extracting questions with " + model + (args.local ? " on this computer" : "") + "...",
    );
    for (let index = 0; index < needsExtraction.length; index += 1) {
      const exam = needsExtraction[index];
      console.log(
        "  [" +
          (index + 1) +
          "/" +
          needsExtraction.length +
          "] " +
          exam.filename,
      );
      const result = await extract(pdfPaths.get(exam.filename), exam);
      result.extractor = provider + ":" + model;
      for (const question of result.questions) {
        question.extractor ||= result.extractor;
      }
      extractions.set(exam.filename, result);
      await writeJsonAtomic(
        path.join(cacheDirectory, exam.filename + ".json"),
        {
          filename: exam.filename,
          model,
          provider,
          extractedAt: new Date().toISOString(),
          result,
        },
      );
    }
  }

  const draft = normalizeDraft(
    existingResult.data,
    selected,
    extractions,
    courseNumber,
    args["course-name"],
  );
  const draftPath = path.join(outputDirectory, "course-" + courseNumber + ".json");
  await writeJsonAtomic(draftPath, draft);
  const uncertain = draft.questions.filter((question) => question.unc).length;
  console.log("");
  console.log("Review draft: " + draftPath);
  console.log("Course: " + draft.course.name + " (" + courseNumber + ")");
  console.log("Exams in draft: " + Object.keys(draft.exams).length);
  console.log("Questions in draft: " + draft.questions.length);
  console.log("Questions marked uncertain: " + uncertain);

  if (args["draft-only"]) {
    console.log("Draft-only mode completed. Supabase was not changed.");
    return;
  }

  const supabaseReady =
    isRealSecret(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    isRealSecret(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseReady) {
    console.log(
      "Draft is ready, but Supabase was not changed. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local, review the draft, and run the same command again.",
    );
    return;
  }

  const approved = await confirm(
    "Import this reviewed draft and its PDFs into the website database?",
    args.yes,
  );
  if (!approved) {
    console.log("Stopped before database import. The draft and PDFs were kept.");
    return;
  }

  await runImporter(projectRoot, draftPath, outputDirectory, args);
  console.log("The course is now in the website database.");
}

main().catch((error) => {
  console.error("\nIngestion stopped: " + error.message);
  process.exitCode = 1;
});
