#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const HUJI_EXAM_BASE = "https://www4.huji.ac.il/exams/";
const REQUEST_GAP_MS = 800;
const DEFAULT_FROM_YEAR = 2016;

function usage() {
  console.log(`
Download HUJI exams by their canonical filename

Usage:
  npm run fetch:exams -- 80181 --from 2016 --to 2026

Options:
  --from YEAR          First year (default: 2016)
  --to YEAR            Last year (default: current year)
  --semesters LIST     Comma-separated semester numbers (default: 1,2)
  --moeds LIST         Comma-separated moed numbers (default: 1,2)
  --versions LIST      Comma-separated versions (default: 1,2)
  --output-dir PATH    Destination (default: imports/COURSE)
  --retry-missing      Retry filenames already recorded as missing/non-PDF
  --help               Show this help
`);
}

function parseArgs(argv) {
  const args = {};
  const booleans = new Set(["retry-missing", "help"]);
  const values = new Set(["from", "to", "semesters", "moeds", "versions", "output-dir"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      if (args.course) throw new Error("Only one course number can be supplied.");
      args.course = value;
      continue;
    }
    const name = value.slice(2);
    if (booleans.has(name)) {
      args[name] = true;
      continue;
    }
    if (!values.has(name)) throw new Error("Unknown option: " + value);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error("Missing value for " + value);
    args[name] = next;
    index += 1;
  }
  return args;
}

function integer(value, label, minimum, maximum) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function integerList(value, fallback, label, maximum) {
  const entries = String(value ?? fallback)
    .split(",")
    .map((part) => integer(part.trim(), label, 1, maximum));
  return [...new Set(entries)];
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPdf(bytes) {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJsonAtomic(filename, value) {
  const temporary = filename + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, filename);
}

async function fetchWithBackoff(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "GBank owner exam downloader" },
        signal: controller.signal,
      });
      if (response.status === 404) return response;
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`HUJI returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) await wait(1000 * 2 ** attempt);
  }
  throw lastError ?? new Error("Download failed: " + url);
}

function candidates(course, fromYear, toYear, semesters, moeds, versions) {
  const result = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    for (const semester of semesters) {
      for (const moed of moeds) {
        for (const version of versions) {
          const filename = `${course}_${year}_${semester}_${moed}_${version}.pdf`;
          result.push({
            course,
            year,
            semester,
            moed,
            version,
            filename,
            url: new URL(filename, HUJI_EXAM_BASE).href,
          });
        }
      }
    }
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
  if (!/^\d{4,8}$/.test(course)) {
    usage();
    throw new Error("A 4–8 digit HUJI course number is required.");
  }

  const currentYear = new Date().getUTCFullYear();
  const fromYear = integer(args.from ?? DEFAULT_FROM_YEAR, "--from", 1900, 2200);
  const toYear = integer(args.to ?? currentYear, "--to", 1900, 2200);
  if (fromYear > toYear) throw new Error("--from cannot be later than --to.");
  const semesters = integerList(args.semesters, "1,2", "--semesters", 9);
  const moeds = integerList(args.moeds, "1,2", "--moeds", 9);
  const versions = integerList(args.versions, "1,2", "--versions", 9);
  const outputDirectory = path.resolve(
    process.cwd(),
    args["output-dir"] ?? path.join("imports", course),
  );
  await mkdir(outputDirectory, { recursive: true });
  const manifestPath = path.join(outputDirectory, "fetch-manifest.json");
  const previous = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : {};
  const manifest = {
    version: 1,
    source: HUJI_EXAM_BASE,
    courseNumber: course,
    fromYear,
    toYear,
    semesters,
    moeds,
    versions,
    updatedAt: new Date().toISOString(),
    exams: previous.courseNumber === course && previous.exams ? previous.exams : {},
  };

  const knownHashes = new Map();
  for (const [filename, record] of Object.entries(manifest.exams)) {
    if (record.sha256 && record.status === "downloaded") {
      knownHashes.set(record.sha256, filename);
    }
  }

  const list = candidates(course, fromYear, toYear, semesters, moeds, versions);
  let downloaded = 0;
  let found = 0;
  for (let index = 0; index < list.length; index += 1) {
    const exam = list[index];
    const destination = path.join(outputDirectory, exam.filename);
    const recorded = manifest.exams[exam.filename];

    if (existsSync(destination)) {
      const bytes = await readFile(destination);
      if (isPdf(bytes)) {
        const digest = sha256(bytes);
        const duplicateOf = knownHashes.get(digest);
        manifest.exams[exam.filename] = {
          ...exam,
          status: duplicateOf && duplicateOf !== exam.filename ? "duplicate" : "downloaded",
          duplicateOf: duplicateOf && duplicateOf !== exam.filename ? duplicateOf : undefined,
          sha256: digest,
          bytes: bytes.length,
          path: destination,
        };
        if (!duplicateOf) knownHashes.set(digest, exam.filename);
        found += 1;
        console.log(`  kept ${exam.filename}`);
        await writeJsonAtomic(manifestPath, manifest);
        continue;
      }
    }

    if (
      recorded &&
      !args["retry-missing"] &&
      (recorded.status === "missing" || recorded.status === "not-pdf")
    ) {
      continue;
    }

    console.log(`  [${index + 1}/${list.length}] ${exam.filename}`);
    const response = await fetchWithBackoff(exam.url);
    let status = "missing";
    let detail = `HTTP ${response.status}`;
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (isPdf(bytes)) {
        const digest = sha256(bytes);
        const duplicateOf = knownHashes.get(digest);
        if (duplicateOf) {
          status = "duplicate";
          detail = `same PDF as ${duplicateOf}`;
          manifest.exams[exam.filename] = {
            ...exam,
            status,
            duplicateOf,
            sha256: digest,
            bytes: bytes.length,
          };
        } else {
          const partial = destination + ".part";
          await writeFile(partial, bytes);
          await rename(partial, destination);
          knownHashes.set(digest, exam.filename);
          status = "downloaded";
          detail = `${bytes.length} bytes`;
          manifest.exams[exam.filename] = {
            ...exam,
            status,
            sha256: digest,
            bytes: bytes.length,
            path: destination,
          };
          downloaded += 1;
        }
        found += 1;
      } else {
        status = "not-pdf";
        detail = "response did not start with %PDF- (possibly a login/error page)";
      }
    }
    if (!manifest.exams[exam.filename]) {
      manifest.exams[exam.filename] = { ...exam, status, detail };
    }
    manifest.updatedAt = new Date().toISOString();
    await writeJsonAtomic(manifestPath, manifest);
    console.log(`    ${status}: ${detail}`);
    if (index < list.length - 1) await wait(REQUEST_GAP_MS);
  }

  console.log(`\nFound ${found} unique/listed PDF result(s); downloaded ${downloaded} new file(s).`);
  console.log("Manifest: " + manifestPath);
}

main().catch((error) => {
  console.error("\nDownload stopped: " + error.message);
  process.exitCode = 1;
});

