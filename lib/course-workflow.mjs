import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';

export function parseUpdateArgs(argv) {
  const args = {};
  const flags = new Set(['help', 'status', 'publish', 'publish-unreviewed', 'dry-run', 'refresh', 'yes', 'no-open']);
  const values = new Set(['from', 'to', 'course-name', 'file', 'delay-ms']);
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      if (args.course) throw new Error('Only one course number is allowed.');
      args.course = value;
    } else {
      const name = value.slice(2);
      if (flags.has(name)) args[name] = true;
      else if (values.has(name)) {
        if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${value}`);
        args[name] = argv[++i];
      } else throw new Error(`Unknown option: ${value}`);
    }
  }
  if (!args.help && !/^\d{4,8}$/.test(args.course ?? '')) throw new Error('Supply a course number, e.g. npm run course:update -- 80181');
  if ([args.status, args.publish, args['publish-unreviewed']].filter(Boolean).length > 1) throw new Error('Use only one of --status, --publish, --publish-unreviewed.');
  if (args.file && !args.publish) throw new Error('--file requires --publish.');
  return args;
}

export function coursePlan(root, course, config) {
  const dir = path.join(root, 'imports', course);
  const draft = path.join(dir, `course-${course}.json`);
  const grouped = path.join(dir, `course-${course}-main-questions.json`);
  const repaired = path.join(dir, `course-${course}-realigned.json`);
  const review = path.join(root, 'crop-review', `${course}-update`);
  return [
    { name: 'extract', script: 'ingest-course.mjs', output: draft,
      args: ['--gemini', '--all', course, '--from', String(config.from), '--to', String(config.to),
        '--output-dir', dir, '--draft-only', ...(config.name ? ['--course-name', config.name] : [])] },
    { name: 'group', script: 'group-question-parts.mjs', input: draft, output: grouped,
      args: ['--data', draft, '--output', grouped] },
    { name: 'repair', script: 'repair-question-boxes.mjs', input: grouped, output: repaired,
      args: [course, '--data', grouped, '--pdf-dir', dir, '--output', repaired,
        '--all-pages', '--delay-ms', String(config.delay)] },
    { name: 'import', script: 'import-course.mjs', input: repaired,
      args: ['--data', repaired, '--pdf-dir', dir] },
    { name: 'crop', script: 'crop-questions.mjs', input: repaired,
      output: path.join(review, 'review-manifest.json'),
      args: [course, '--pdf-dir', dir, '--review-dir', review] },
  ];
}

export async function fileHash(filename) {
  try { return createHash('sha256').update(await readFile(filename)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function saveState(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename + '.tmp', JSON.stringify(value, null, 2) + '\n');
  await rename(filename + '.tmp', filename);
}

export async function runStages(steps, state, { run, save, log = console.log, hash = fileHash }) {
  state.steps ??= {};
  let changed = false;
  for (const step of steps) {
    const inputHash = step.input ? await hash(step.input) : null;
    const outputHash = step.output ? await hash(step.output) : null;
    const previous = state.steps[step.name];
    if (!changed && previous?.status === 'done' && previous.inputHash === inputHash &&
      (!step.output || (outputHash && previous.outputHash === outputHash))) {
      log(`${step.name}: kept completed step`);
      continue;
    }
    changed = true;
    state.steps[step.name] = { status: 'running', inputHash };
    await save(state);
    log(`Starting ${step.name}...`);
    try {
      await run(step);
      const resultHash = step.output ? await hash(step.output) : null;
      if (step.output && !resultHash) throw new Error(`${step.name} did not produce ${step.output}`);
      state.steps[step.name] = { status: 'done', inputHash, outputHash: resultHash };
      await save(state);
    } catch (error) {
      // Don't persist raw API errors: some upstream errors include credential URLs.
      state.steps[step.name] = { status: 'failed', inputHash };
      await save(state);
      throw new Error(`${step.name} paused: ${error.message}. Saved work is kept; rerun course:update with the same course number.`);
    }
  }
}
