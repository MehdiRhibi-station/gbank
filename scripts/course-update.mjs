#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat, mkdir, open, unlink } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { parseReviewJson, reviewRows } from '../lib/crop-safety.mjs';
import { publishUnreviewed } from '../lib/publish-unreviewed.mjs';
import { allRows, requireStaging } from '../lib/pipeline-db.mjs';
import { parseUpdateArgs, coursePlan, saveState, runStages } from '../lib/course-workflow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args],
      { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${script} stopped (${signal || code}); see message above`)));
  });
}
async function json(filename) {
  try { return parseReviewJson(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function environment() {
  let source;
  try { source = await readFile(path.join(root, '.env.local'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return; }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
function required(name) {
  const value = process.env[name];
  if (!value || /YOUR_|replace-me/.test(value)) throw new Error(`Set ${name} in ${path.join(root, '.env.local')} (never share the key).`);
  return value;
}
async function status(client, course) {
  const exams = await allRows(() => client.from('exams').select('id').eq('course_number', course).order('id'));
  const questions = [];
  for (let i = 0; i < exams.length; i += 100) questions.push(...await allRows(() =>
    client.from('questions').select('id,is_published,retired_at,image_path,crop_review_status').in('exam_id', exams.slice(i, i + 100).map(e => e.id)).order('id')));
  const updates = [];
  for (let i = 0; i < questions.length; i += 200) updates.push(...await allRows(() =>
    client.from('question_updates').select('question_id,image_path,review_status,draft')
      .in('question_id', questions.slice(i, i + 200).map(q => q.id)).order('question_id')));
  console.log(`Course ${course}: ${exams.length} exams | ${questions.filter(q => q.is_published && !q.retired_at).length} live questions`);
  const livePaths = new Map(questions.filter(q => q.is_published && !q.retired_at).map(q => [q.id, q.image_path]));
  console.log(`Published without review: ${questions.filter(q => q.is_published && !q.retired_at && q.crop_review_status === 'pending').length}`);
  console.log(`Candidates: ${updates.length} | awaiting review: ${updates.filter(q => q.image_path && q.review_status === 'pending' && livePaths.get(q.question_id) !== q.image_path).length} | rejected: ${updates.filter(q => q.review_status === 'rejected').length} | missing boxes: ${updates.filter(q => !q.draft.image_page || !q.draft.image_bbox).length}`);
}
async function decisionFile(course, explicit) {
  if (explicit) return path.resolve(explicit);
  const downloads = path.join(os.homedir(), 'Downloads');
  const entries = await readdir(downloads).catch(() => []);
  const candidates = await Promise.all(entries.filter(name =>
    new RegExp(`^crop-decisions-${course}(?: \\(\\d+\\))?\\.json$`).test(name))
    .map(async name => ({ name: path.join(downloads, name), time: (await stat(path.join(downloads, name))).mtimeMs })));
  candidates.sort((a, b) => b.time - a.time);
  if (!candidates.length) throw new Error('No downloaded decisions found. Open the review page, approve/reject crops, click Download decisions, then rerun. Or use --file PATH.');
  return candidates[0].name;
}
async function lock(filename) {
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    const handle = await open(filename, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname() }));
    await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await json(filename);
    if (owner?.host === os.hostname() && Number.isInteger(owner.pid)) {
      try { process.kill(owner.pid, 0); }
      catch (probe) {
        if (probe.code === 'ESRCH') { await unlink(filename); return lock(filename); }
      }
    }
    throw new Error('Another update may be running for this course. Close it before retrying.');
  }
  return () => unlink(filename);
}
function openReview(filename) {
  const url = pathToFileURL(filename).href;
  const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(...command, { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => console.log(`Open this review page manually: ${filename}`));
  child.unref();
}
async function main() {
  const args = parseUpdateArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Toodle owner-only course updater
  npm run course:update -- 80181 [--from 2016 --to 2026 --course-name "Name"]
  npm run course:update -- 80181 --status
  npm run course:update -- 80181 --publish [--file PATH] [--dry-run]
  npm run course:update -- 80181 --publish-unreviewed [--dry-run]
Options: --refresh (check for new exams; keep extraction caches), --yes (consent to API use),
  --delay-ms 6000, --no-open, --dry-run (print plan only; no API calls or writes).
Interrupted runs resume automatically. Normal publication requires review decisions. --publish-unreviewed explicitly skips review.
Apply 202610060007_owner_unreviewed.sql before using --publish-unreviewed.
Run from the project folder. Apply 202610060006_staged_updates.sql first.`);
    return;
  }
  await environment();
  const dir = path.join(root, 'imports', args.course);
  const stateFile = path.join(dir, 'update-state.json');
  const saved = await json(stateFile);
  const config = {
    from: Number(args.from ?? saved?.config?.from ?? 2016),
    to: Number(args.to ?? saved?.config?.to ?? new Date().getFullYear()),
    name: args['course-name'] ?? saved?.config?.name ?? '',
    delay: Number(args['delay-ms'] ?? saved?.config?.delay ?? 6000),
    model: process.env.GEMINI_MODEL || '',
    database: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  };
  if (![config.from, config.to].every(y => Number.isInteger(y) && y >= 1900 && y <= 2200) || config.from > config.to)
    throw new Error('Invalid year range.');
  if (!Number.isFinite(config.delay) || config.delay < 0) throw new Error('Invalid --delay-ms.');
  const steps = coursePlan(root, args.course, config);
  if (args['dry-run'] && !args.publish && !args['publish-unreviewed']) {
    for (const step of steps) console.log(`${step.name}: node ${step.script} ${step.args.map(s => JSON.stringify(s)).join(' ')}`);
    console.log('Plan only. No files, database rows, or API calls changed.');
    return;
  }
  const client = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } });
  await requireStaging(client);
  await status(client, args.course);
  if (args.status) return;
  const release = await lock(path.join(dir, 'update.lock'));
  try {
    if (args['publish-unreviewed']) {
      await publishUnreviewed(client, args.course, { dryRun: Boolean(args['dry-run']) });
      await status(client, args.course);
      return;
    }
    if (args.publish) {
      const file = await decisionFile(args.course, args.file);
      const document = await json(file);
      if (!document) throw new Error(`Review file not found: ${file}`);
      const decisions = reviewRows(document, args.course);
      if (!decisions.some(q => q.decision !== 'pending')) throw new Error('No approvals/rejections saved. Make decisions in the review page and download again.');
      console.log(`Using decisions: ${file}`);
      await run('review-crops.mjs', [args.course, '--file', file, '--dry-run']);
      if (!args['dry-run']) {
        await run('review-crops.mjs', [args.course, '--file', file, '--publish']);
        await status(client, args.course);
        const publicKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (publicKey && !/YOUR_/.test(publicKey)) {
          const visitor = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), publicKey,
            { auth: { persistSession: false, autoRefreshToken: false } });
          const approved = decisions.filter(q => q.decision === 'approved');
          let visible = 0;
          for (let i = 0; i < approved.length; i += 100) {
            const rows = await allRows(() => visitor.from('questions').select('id,image_path')
              .in('id', approved.slice(i, i + 100).map(q => q.id)).eq('is_published', true).is('retired_at', null).order('id'));
            const paths = new Map(rows.map(q => [q.id, q.image_path]));
            visible += approved.slice(i, i + 100).filter(q => paths.get(q.id) === q.storagePath).length;
          }
          console.log(`Visitor database check: ${visible}/${approved.length} approved images visible.`);
          if (visible !== approved.length) throw new Error('Publication saved, but visitor access is incomplete. Check Supabase read policies; do not rerun extraction.');
        } else console.log('Visitor visibility not checked: set NEXT_PUBLIC_SUPABASE_ANON_KEY.');
      }
      return;
    }
    required('GEMINI_API_KEY');
    const bucket = await client.storage.getBucket('exam-files');
    if (bucket.error) throw new Error(`Storage preflight failed: ${bucket.error.message}. Check exam-files before starting extraction.`);
    const state = saved && JSON.stringify(saved.config) === JSON.stringify(config) && !args.refresh
      ? saved : { version: 1, course: args.course, config, steps: {} };
    if (args.yes) steps[0].args.push('--yes');
    await runStages(steps, state, {
      run: step => run(step.script, step.args), save: value => saveState(stateFile, value),
    });
    const review = path.join(root, 'crop-review', `${args.course}-update`, 'index.html');
    console.log(`Review: ${review}`);
    console.log(`Approve/reject and download decisions. Then: npm run course:update -- ${args.course} --publish`);
    console.log('Live questions were preserved. Use --refresh next time to check for newer exams.');
    if (!args['no-open']) openReview(review);
    await status(client, args.course);
  } finally { await release(); }
}
main().catch(error => { console.error(`\nCourse update stopped: ${error.message}`); process.exitCode = 1; });
