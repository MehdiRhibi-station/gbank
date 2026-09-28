#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pdf } from "pdf-to-img";
import sharp from "sharp";
import {
  boundedQuestionCropBoxes,
  cropBoxToPixels,
  cropStoragePath,
  groupByExamAndPage,
  paddedVerticalInkCrop,
  reviewCropImageName,
  reviewImageName,
  validFractionBox,
  validPageNumber,
} from "../lib/crop-safety.mjs";

const STORAGE_BUCKET = "exam-files";

function usage() {
  console.log(`
Create one reviewable, padded source crop for each question

Usage:
  npm run crop:questions -- 80181 --pdf-dir ".\\imports\\80181"

Options:
  --pdf-dir PATH      Folder containing source PDFs (Storage is the fallback)
  --review-dir PATH   Local review bundle (default: crop-review/COURSE)
  --exam ID_OR_FILE  Process only one exam id or PDF filename
  --scale NUMBER      PDF render scale, 1–6 (default: 3)
  --limit NUMBER      Process only the first NUMBER questions
  --force             Replace existing images and reset their review status
  --prepare-only      Render the review bundle without uploading or changing DB
  --dry-run           List eligible questions without rendering or uploading
  --help              Show this help

Safety model:
  Machine coordinates are padded and converted to a separate image for each
  question. Missing or invalid boxes are skipped and remain unpublished. The
  local review bundle shows each crop beside an optional complete-page view.
  Every linked crop remains unpublished and pending until review:crops approves
  that exact storage path.
`);
}

function parseArgs(argv) {
  const args = {};
  const flags = new Set(["dry-run", "force", "prepare-only", "help"]);
  const values = new Set(["pdf-dir", "review-dir", "exam", "scale", "limit"]);
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
  const cards = manifest.questions
    .map((question, index) => {
      const box = validFractionBox(question.bbox);
      const highlight = box
        ? `<span class="highlight" aria-hidden="true" style="left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%"></span>`
        : "";
      return `<article data-row="${index}">
        <header>
          <h2>שאלה ${escapeHtml(question.number)}${escapeHtml(question.subpart)}</h2>
          <p><strong>${escapeHtml(question.id)}</strong><br>${escapeHtml(question.sourceFilename)} — עמוד ${question.page}</p>
        </header>
        <div class="crop-tools" aria-label="כלי הגדלה">
          <button type="button" data-zoom="-25">−</button>
          <span data-zoom-label>100%</span>
          <button type="button" data-zoom="25">+</button>
          <button type="button" data-zoom-reset>איפוס</button>
          <a href="${encodeURI(question.localImage)}" target="_blank" rel="noreferrer">פתיחה בגודל מלא</a>
        </div>
        <div class="crop-viewport">
          <img class="crop-image" src="${encodeURI(question.localImage)}" alt="Question ${escapeHtml(question.number)}${escapeHtml(question.subpart)} source crop" loading="lazy">
        </div>
        <details>
          <summary>הצגת העמוד המלא להשוואה</summary>
          <div class="page-preview">
            <img data-full-src="${encodeURI(question.localPageImage)}" alt="Original exam page ${question.page}">
            ${highlight}
          </div>
        </details>
        ${question.linked ? "" : "<p><em>התמונה לא קושרה למסד הנתונים.</em></p>"}
        <div class="choices" role="group" aria-label="Review decision">
          <button data-index="${index}" data-decision="approved">תקין</button>
          <button data-index="${index}" data-decision="rejected">דחייה</button>
          <button data-index="${index}" data-decision="pending" class="selected">ממתין</button>
        </div>
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
h1,h2,p{margin-top:0}.warning{border-right:5px solid #ff5a1f;padding:10px 14px;background:#fff1eb}
article header{display:flex;justify-content:space-between;gap:18px;align-items:start}article header p{direction:ltr;text-align:left;color:#5d6171}
.crop-tools{display:flex;align-items:center;gap:8px;direction:rtl;margin:8px 0}.crop-tools a{margin-right:auto;color:#2853df;font-weight:700}.crop-tools span{min-width:48px;text-align:center;font-weight:700}
.crop-viewport{overflow-x:auto;overflow-y:visible;border:1px solid #bbb;background:white}.crop-image{display:block;width:100%;max-width:none;height:auto;background:white}.page-preview img{display:block;width:100%;height:auto;border:1px solid #bbb;background:white}
details{margin-top:14px}summary{cursor:pointer;font-weight:700}.page-preview{position:relative;margin-top:10px}.highlight{position:absolute;border:4px solid #ff5a1f;background:#ff5a1f12;box-sizing:border-box;pointer-events:none}
.choices{display:flex;gap:7px;direction:rtl;margin-top:16px;padding-top:14px;border-top:1px solid #ddd}button{padding:8px 12px;border:1px solid #101936;border-radius:8px;background:white;font-weight:700;cursor:pointer}button.selected[data-decision=approved]{background:#dff5e7;color:#17613b}button.selected[data-decision=rejected]{background:#ffe2db;color:#9c2f18}button.selected[data-decision=pending]{background:#eef0ff;color:#2853df}
.download{position:sticky;bottom:12px;width:100%;margin-top:18px;padding:14px;background:#101936;color:white;font-size:17px}em{color:#a53016}
</style></head><body><main>
<section class="intro"><h1>בדיקת תמונות מקור — קורס ${escapeHtml(manifest.course)}</h1>
<p class="warning"><strong>אל תאשרו לפי התמלול.</strong> בדקו שבתמונה מופיעה רק השאלה המתאימה, ושהמספר, הנוסחאות, האיורים וכל הסעיפים מלאים. פתחו את העמוד המלא כדי להשוות במקרה של ספק.</p>
<p>סמנו כל שאלה, הורידו את קובץ ההחלטות, ואז הריצו <code>npm run review:crops -- ${escapeHtml(manifest.course)} --file PATH --publish</code>.</p></section>
${cards}
<button class="download" id="download">הורדת קובץ החלטות</button>
</main><script>
const manifest=${safeManifest};
const decisions=manifest.questions.map(()=>"pending");
document.addEventListener("click",event=>{const zoom=event.target.closest("button[data-zoom],button[data-zoom-reset]");if(zoom){const article=zoom.closest("article");const image=article.querySelector(".crop-image");const label=article.querySelector("[data-zoom-label]");const current=Number(image.dataset.zoom||100);const next=zoom.hasAttribute("data-zoom-reset")?100:Math.max(50,Math.min(250,current+Number(zoom.dataset.zoom)));image.dataset.zoom=String(next);image.style.width=next+"%";label.textContent=next+"%";return;}const button=event.target.closest("button[data-index]");if(!button)return;const index=Number(button.dataset.index);decisions[index]=button.dataset.decision;button.parentElement.querySelectorAll("button").forEach(item=>item.classList.toggle("selected",item===button));});
document.addEventListener("toggle",event=>{const details=event.target;if(!(details instanceof HTMLDetailsElement)||!details.open)return;const image=details.querySelector("img[data-full-src]");if(image&&!image.src)image.src=image.dataset.fullSrc;},true);
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
  let selectedExamIds = null;
  if (args.exam) {
    const needle = String(args.exam).toLocaleLowerCase();
    selectedExamIds = new Set(
      [...exams.entries()]
        .filter(([id, exam]) => {
          const filename = String(exam.source_filename ?? "");
          return String(id).toLocaleLowerCase() === needle ||
            filename.toLocaleLowerCase() === needle ||
            path.basename(filename, path.extname(filename)).toLocaleLowerCase() === needle;
        })
        .map(([id]) => id),
    );
    if (!selectedExamIds.size) throw new Error(`No exam matched --exam ${args.exam}`);
  }

  let questionQuery = supabase
    .from("questions")
    .select("id,exam_id,ordinal,question_number,subpart,image_page,image_bbox,image_path")
    .in("exam_id", [...exams.keys()])
    .is("retired_at", null)
    .order("exam_id")
    .order("ordinal");
  if (!args.force) questionQuery = questionQuery.is("image_path", null);
  const questionResult = await questionQuery;
  if (questionResult.error) {
    throw new Error("Could not load source-image candidates: " + questionResult.error.message);
  }
  const candidates = (questionResult.data ?? []).filter(
    (question) => !selectedExamIds || selectedExamIds.has(question.exam_id),
  );
  const missingPage = candidates.filter(
    (question) => !validPageNumber(question.image_page),
  );
  const missingBox = candidates.filter(
    (question) => validPageNumber(question.image_page) && !validFractionBox(question.image_bbox),
  );
  const allQuestions = candidates.filter(
    (question) =>
      validPageNumber(question.image_page) && validFractionBox(question.image_bbox),
  );
  const boundedBoxes = boundedQuestionCropBoxes(allQuestions);
  let questions = allQuestions;
  if (limit !== null) questions = questions.slice(0, limit);

  console.log(`Eligible questions: ${questions.length}`);
  console.log(`Questions missing a source page: ${missingPage.length}`);
  console.log(`Questions missing a usable bounding box: ${missingBox.length}`);
  console.log("Image mode: one padded crop per question");
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
    mode: "question-crop",
    questions: [],
  };
  let linked = 0;
  let renderedPageCount = 0;
  let renderedCropCount = 0;

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
      const localPageImage = reviewImageName({
        examId,
        page: group.page,
        bytes: page.data,
      });
      await writeFile(path.join(reviewDirectory, localPageImage), page.data);
      renderedPageCount += 1;

      for (const question of group.questions) {
        const cropBox = boundedBoxes.get(question.id) ?? question.image_bbox;
        const pixelBox = cropBoxToPixels(
          cropBox,
          page.info.width,
          page.info.height,
          { paddingX: 0, paddingY: 0 },
        );
        if (!pixelBox) {
          console.warn(`  skipped ${question.id}: invalid crop after page rendering`);
          continue;
        }

        let crop;
        try {
          const broadCrop = await sharp(page.data)
            .extract(pixelBox)
            .png({ compressionLevel: 9 })
            .toBuffer({ resolveWithObject: true });
          const grayscale = await sharp(broadCrop.data)
            .grayscale()
            .raw()
            .toBuffer({ resolveWithObject: true });
          const contentBox = paddedVerticalInkCrop(
            grayscale.data,
            grayscale.info.width,
            grayscale.info.height,
            { channels: grayscale.info.channels },
          );
          crop = contentBox
            ? await sharp(broadCrop.data)
                .extract(contentBox)
                .png({ compressionLevel: 9 })
                .toBuffer({ resolveWithObject: true })
            : broadCrop;
        } catch (error) {
          console.warn(`  skipped ${question.id}: ${error.message}`);
          continue;
        }
        renderedCropCount += 1;
        const storagePath = cropStoragePath({
          course,
          examId,
          questionId: question.id,
          page: group.page,
          bytes: crop.data,
        });
        const localImage = reviewCropImageName({
          questionId: question.id,
          page: group.page,
          bytes: crop.data,
        });
        await writeFile(path.join(reviewDirectory, localImage), crop.data);

        let questionLinked = false;
        if (!args["prepare-only"]) {
          const upload = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, crop.data, {
              contentType: "image/png",
              cacheControl: "31536000",
              upsert: true,
            });
          if (upload.error) {
            console.warn(`  upload failed for ${question.id}: ${upload.error.message}`);
          } else {
            const update = await supabase
              .from("questions")
              .update({
                image_path: storagePath,
                image_width: crop.info.width,
                image_height: crop.info.height,
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
        }
        manifest.questions.push({
          id: question.id,
          examId,
          sourceFilename: exam.source_filename,
          page: group.page,
          number: question.question_number,
          subpart: question.subpart ?? "",
          bbox: cropBox,
          sourceBbox: question.image_bbox,
          storagePath,
          localImage,
          localPageImage,
          linked: questionLinked,
          decision: "pending",
        });
      }
      console.log(
        `  page ${group.page}: ${group.questions.length} question crop(s)` +
          (args["prepare-only"] ? " prepared" : " processed"),
      );
    }
  }

  await writeReviewBundle(reviewDirectory, manifest);
  console.log(`Review bundle: ${path.join(reviewDirectory, "index.html")}`);
  console.log(`Rendered ${renderedPageCount} page image(s).`);
  console.log(`Rendered ${renderedCropCount} question crop(s).`);
  if (args["prepare-only"]) {
    console.log("Prepare-only completed. Supabase was not changed.");
  } else {
    console.log(`Created and linked ${linked}/${questions.length} pending question crop(s).`);
    console.log("Nothing was published. Review the bundle, then use review:crops.");
  }
}

main().catch((error) => {
  console.error("\nSource-image generation stopped: " + error.message);
  process.exitCode = 1;
});
