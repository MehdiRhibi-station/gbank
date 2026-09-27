#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pdf } from "pdf-to-img";
import sharp from "sharp";
import {
  groupByExamAndPage,
  pageStoragePath,
  reviewImageName,
  validPageNumber,
} from "../lib/crop-safety.mjs";

const STORAGE_BUCKET = "exam-files";

function usage() {
  console.log(`
Create reviewable source images without trusting machine crop coordinates

Usage:
  npm run crop:questions -- 80181 --pdf-dir ".\\imports\\80181"

Options:
  --pdf-dir PATH      Folder containing source PDFs (Storage is the fallback)
  --review-dir PATH   Local review bundle (default: crop-review/COURSE)
  --scale NUMBER      PDF render scale, 1–6 (default: 3)
  --limit NUMBER      Process only the first NUMBER questions
  --force             Replace existing images and reset their review status
  --prepare-only      Render the review bundle without uploading or changing DB
  --dry-run           List eligible questions without rendering or uploading
  --help              Show this help

Safety model:
  The complete original page is used for every question on that page. This is
  intentionally looser than an AI crop: extra context is harmless; clipped
  notation is not. One page image is uploaded once and shared by its questions.
  Every linked image remains unpublished and pending until review:crops approves
  that exact storage path.
`);
}

function parseArgs(argv) {
  const args = {};
  const flags = new Set(["dry-run", "force", "prepare-only", "help"]);
  const values = new Set(["pdf-dir", "review-dir", "scale", "limit"]);
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
    if (!values.has(name)) throw new Error("Unknown option: " + value);
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

async function renderSelectedPages(input, scale, selectedPages) {
  const wanted = new Set(selectedPages);
  const rendered = new Map();
  const document = await pdf(input, { scale });
  let pageNumber = 0;
  try {
    for await (const page of document) {
      pageNumber += 1;
      if (wanted.has(pageNumber)) rendered.set(pageNumber, Buffer.from(page));
    }
  } finally {
    await document.destroy();
  }
  return rendered;
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function reviewHtml(manifest) {
  const grouped = new Map();
  manifest.questions.forEach((question, index) => {
    const current = grouped.get(question.localImage) ?? [];
    current.push({ ...question, index });
    grouped.set(question.localImage, current);
  });
  const cards = [...grouped.entries()]
    .map(([image, questions]) => {
      const first = questions[0];
      const rows = questions
        .map(
          (question) => `<li data-row="${question.index}">
            <div><strong>${escapeHtml(question.id)}</strong><br>
              שאלה ${escapeHtml(question.number)}${escapeHtml(question.subpart)}
              ${question.linked ? "" : "<em> — טרם הועלה</em>"}
            </div>
            <div class="choices" role="group" aria-label="Review decision">
              <button data-index="${question.index}" data-decision="approved">תקין</button>
              <button data-index="${question.index}" data-decision="rejected">דחייה</button>
              <button data-index="${question.index}" data-decision="pending" class="selected">ממתין</button>
            </div>
          </li>`,
        )
        .join("");
      return `<article>
        <header><h2>${escapeHtml(first.sourceFilename)} — עמוד ${first.page}</h2></header>
        <img src="${encodeURI(image)}" alt="Original exam page ${first.page}" loading="lazy">
        <ul>${rows}</ul>
      </article>`;
    })
    .join("\n");
  const safeManifest = JSON.stringify(manifest).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GBank crop review — ${escapeHtml(manifest.course)}</title>
<style>
body{margin:0;background:#f7f4ed;color:#101936;font-family:Arial,sans-serif;line-height:1.5}
main{width:min(1100px,calc(100% - 28px));margin:32px auto}.intro,article{background:#fff;border:2px solid #101936;border-radius:14px;padding:18px;margin:0 0 24px;box-shadow:0 4px 0 #1019361a}
h1,h2{margin:0 0 10px}.warning{border-right:5px solid #ff5a1f;padding:10px 14px;background:#fff1eb}
article img{display:block;width:100%;height:auto;border:1px solid #bbb;background:white}
ul{list-style:none;padding:0;margin:16px 0 0}li{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:11px 0;border-top:1px solid #ddd;direction:ltr;text-align:left}
.choices{display:flex;gap:7px;direction:rtl}button{padding:8px 12px;border:1px solid #101936;border-radius:8px;background:white;font-weight:700;cursor:pointer}button.selected[data-decision=approved]{background:#dff5e7;color:#17613b}button.selected[data-decision=rejected]{background:#ffe2db;color:#9c2f18}button.selected[data-decision=pending]{background:#eef0ff;color:#2853df}
.download{position:sticky;bottom:12px;width:100%;margin-top:18px;padding:14px;background:#101936;color:white;font-size:17px}em{color:#a53016}
</style></head><body><main>
<section class="intro"><h1>בדיקת תמונות מקור — קורס ${escapeHtml(manifest.course)}</h1>
<p class="warning"><strong>אל תאשרו לפי התמלול.</strong> בדקו שהעמוד שייך למבחן הנכון ושמספר השאלה המבוקש מופיע בו. התמונות הן עמודים מלאים בכוונה, כדי שאף חזקה, סימן או שורה לא ייחתכו.</p>
<p>סמנו כל שאלה, הורידו את קובץ ההחלטות, ואז הריצו <code>npm run review:crops -- ${escapeHtml(manifest.course)} --file PATH --publish</code>.</p></section>
${cards}
<button class="download" id="download">הורדת קובץ החלטות</button>
</main><script>
const manifest=${safeManifest};
const decisions=manifest.questions.map(()=>"pending");
document.addEventListener("click",event=>{const button=event.target.closest("button[data-index]");if(!button)return;const index=Number(button.dataset.index);decisions[index]=button.dataset.decision;button.parentElement.querySelectorAll("button").forEach(item=>item.classList.toggle("selected",item===button));});
document.getElementById("download").addEventListener("click",()=>{const output={course:manifest.course,generatedAt:new Date().toISOString(),questions:manifest.questions.map((question,index)=>({id:question.id,storagePath:question.storagePath,decision:decisions[index]}))};const blob=new Blob([JSON.stringify(output,null,2)],{type:"application/json"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="crop-decisions-"+manifest.course+".json";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);});
</script></body></html>`;
}

async function writeReviewBundle(reviewDirectory, manifest) {
  await mkdir(reviewDirectory, { recursive: true });
  await writeFile(
    path.join(reviewDirectory, "review-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(path.join(reviewDirectory, "index.html"), reviewHtml(manifest));
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
  const limit = args.limit === undefined ? null : Number.parseInt(args.limit, 10);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer.");
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
  const reviewDirectory = args["review-dir"]
    ? path.resolve(projectRoot, args["review-dir"])
    : path.join(projectRoot, "crop-review", course);
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const migrationProbe = await supabase
    .from("questions")
    .select("crop_review_status")
    .limit(1);
  if (migrationProbe.error) {
    throw new Error(
      "Apply supabase/migrations/202609270005_crop_review.sql before regenerating images: " +
        migrationProbe.error.message,
    );
  }

  const examResult = await supabase
    .from("exams")
    .select("id,source_filename,storage_path")
    .eq("course_number", course);
  if (examResult.error) throw new Error("Could not load exams: " + examResult.error.message);
  const exams = new Map((examResult.data ?? []).map((exam) => [exam.id, exam]));
  if (!exams.size) throw new Error("No database exams found for course " + course);

  let questionQuery = supabase
    .from("questions")
    .select("id,exam_id,ordinal,question_number,subpart,image_page,image_path")
    .in("exam_id", [...exams.keys()])
    .is("retired_at", null)
    .order("exam_id")
    .order("ordinal");
  if (!args.force) questionQuery = questionQuery.is("image_path", null);
  const questionResult = await questionQuery;
  if (questionResult.error) {
    throw new Error("Could not load source-image candidates: " + questionResult.error.message);
  }
  const missingPage = (questionResult.data ?? []).filter(
    (question) => !validPageNumber(question.image_page),
  );
  let questions = (questionResult.data ?? []).filter((question) =>
    validPageNumber(question.image_page),
  );
  if (limit !== null) questions = questions.slice(0, limit);

  console.log(`Eligible questions: ${questions.length}`);
  console.log(`Questions missing a source page: ${missingPage.length}`);
  console.log("Image mode: complete source page (safe default)");
  if (!questions.length) return;
  if (args["dry-run"]) {
    for (const question of questions) {
      console.log(`  ${question.id}: ${question.exam_id}, page ${question.image_page}`);
    }
    console.log("Dry run completed. No images were rendered, uploaded, or linked.");
    return;
  }

  await mkdir(reviewDirectory, { recursive: true });
  const pageGroups = groupByExamAndPage(questions);
  const groupsByExam = new Map();
  for (const group of pageGroups) {
    const current = groupsByExam.get(group.examId) ?? [];
    current.push(group);
    groupsByExam.set(group.examId, current);
  }

  const manifest = {
    version: 1,
    course,
    generatedAt: new Date().toISOString(),
    mode: "full-page",
    questions: [],
  };
  let linked = 0;
  let renderedPageCount = 0;

  for (const [examId, examGroups] of groupsByExam) {
    const exam = exams.get(examId);
    if (!exam) continue;
    console.log(`Rendering ${exam.source_filename} for ${examGroups.length} source page(s)...`);
    let renderedPages;
    try {
      const input = await sourcePdf(exam, pdfDirectory, supabase);
      renderedPages = await renderSelectedPages(
        input,
        scale,
        examGroups.map((group) => group.page),
      );
    } catch (error) {
      console.warn(`  skipped exam: ${error.message}`);
      continue;
    }

    for (const group of examGroups) {
      const pageBuffer = renderedPages.get(group.page);
      if (!pageBuffer) {
        console.warn(`  skipped page ${group.page}: page does not exist`);
        continue;
      }
      const page = await sharp(pageBuffer)
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });
      const storagePath = pageStoragePath({
        course,
        examId,
        page: group.page,
        bytes: page.data,
      });
      const localImage = reviewImageName({
        examId,
        page: group.page,
        bytes: page.data,
      });
      await writeFile(path.join(reviewDirectory, localImage), page.data);
      renderedPageCount += 1;

      let pageUploaded = false;
      if (!args["prepare-only"]) {
        const upload = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, page.data, {
            contentType: "image/png",
            cacheControl: "31536000",
            upsert: true,
          });
        if (upload.error) {
          console.warn(`  upload failed for page ${group.page}: ${upload.error.message}`);
        } else {
          pageUploaded = true;
        }
      }

      for (const question of group.questions) {
        let questionLinked = false;
        if (pageUploaded) {
          const update = await supabase
            .from("questions")
            .update({
              image_path: storagePath,
              image_width: page.info.width,
              image_height: page.info.height,
              crop_review_status: "pending",
              crop_reviewed_at: null,
              crop_reviewed_by: null,
              is_published: false,
            })
            .eq("id", question.id)
            .select("id");
          if (update.error) {
            console.warn(`  uploaded but not linked ${question.id}: ${update.error.message}`);
          } else if (update.data?.length !== 1) {
            console.warn(`  uploaded but matched ${update.data?.length ?? 0} rows for ${question.id}`);
          } else {
            questionLinked = true;
            linked += 1;
          }
        }
        manifest.questions.push({
          id: question.id,
          examId,
          sourceFilename: exam.source_filename,
          page: group.page,
          number: question.question_number,
          subpart: question.subpart ?? "",
          storagePath,
          localImage,
          linked: questionLinked,
          decision: "pending",
        });
      }
      console.log(
        `  page ${group.page}: ${group.questions.length} question(s)` +
          (args["prepare-only"] ? " prepared" : pageUploaded ? " linked as pending" : " not linked"),
      );
    }
  }

  await writeReviewBundle(reviewDirectory, manifest);
  console.log(`Review bundle: ${path.join(reviewDirectory, "index.html")}`);
  console.log(`Rendered ${renderedPageCount} page image(s).`);
  if (args["prepare-only"]) {
    console.log("Prepare-only completed. Supabase was not changed.");
  } else {
    console.log(`Created and linked ${linked}/${questions.length} pending source image(s).`);
    console.log("Nothing was published. Review the bundle, then use review:crops.");
  }
}

main().catch((error) => {
  console.error("\nSource-image generation stopped: " + error.message);
  process.exitCode = 1;
});
