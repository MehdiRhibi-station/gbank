import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdateArgs, coursePlan, runStages } from '../lib/course-workflow.mjs';
import { restoreDecisions } from '../lib/review-state.mjs';
import { retryDownload } from '../lib/retry.mjs';
import { allRows } from '../lib/pipeline-db.mjs';

test('one command builds an additive, draft-first plan with no automatic publication', () => {
  const plan = coursePlan('/project with spaces', '80181', { from: 2016, to: 2026, delay: 6000 });
  assert.deepEqual(plan.map(p => p.name), ['extract', 'group', 'repair', 'import', 'crop']);
  assert.ok(plan[0].args.includes('--draft-only'));
  assert.ok(!plan.some(p => p.args.includes('--publish') || p.args.includes('--retire-missing')));
  assert.equal(plan[3].args[1], plan[2].output);
  assert.throws(() => parseUpdateArgs(['80181', '--file']), /Missing value/);
  assert.throws(() => parseUpdateArgs(['80181', '--oops']), /Unknown option/);
});

test('failed step resumes without rerunning completed paid extraction', async () => {
  const steps = [{name:'extract',output:'draft'}, {name:'import',input:'draft'}, {name:'crop'}];
  const files = new Map();
  const state = {};
  const calls = [];
  let fail = true;
  const options = { log() {}, save: async () => {}, hash: async f => files.get(f) ?? null,
    run: async step => { calls.push(step.name); if (step.name === 'import' && fail) throw new Error('network');
      if (step.output) files.set(step.output, 'hash'); } };
  await assert.rejects(runStages(steps, state, options), /Saved work is kept/);
  assert.equal(state.steps.import.status, 'failed');
  fail = false;
  await runStages(steps, state, options);
  assert.deepEqual(calls, ['extract','import','import','crop']);
  await runStages(steps, state, options);
  assert.equal(calls.length, 4);
  files.delete('draft');
  await runStages(steps, state, options);
  assert.deepEqual(calls.slice(4), ['extract','import','crop']);
});

test('successful child without required artifact is not marked complete', async () => {
  const state = {};
  await assert.rejects(runStages([{name:'repair',output:'missing'}], state,
    {run:async()=>{}, save:async()=>{}, hash:async()=>null, log() {}}), /did not produce/);
  assert.equal(state.steps.repair.status, 'failed');
});

test('review decisions survive reorder but never approve changed or unlinked crops', () => {
  const saved = { a:{storagePath:'a1',decision:'approved'}, b:{storagePath:'b1',decision:'rejected'} };
  assert.deepEqual(restoreDecisions([
    {id:'b',storagePath:'b1',linked:true}, {id:'a',storagePath:'a2',linked:true},
    {id:'a',storagePath:'a1',linked:false}, {id:'a',storagePath:'a1',linked:true},
  ], saved), ['rejected','pending','pending','approved']);
});

test('transient downloads retry with bounded backoff, permanent failures do not', async () => {
  let attempts = 0;
  const waits = [];
  const options = {wait:async ms=>waits.push(ms),log() {}};
  assert.equal(await retryDownload(async()=>{ if (++attempts < 3) throw new TypeError('fetch failed'); return 'pdf'; },options),'pdf');
  assert.deepEqual(waits,[2000,4000]);
  attempts = 0;
  await assert.rejects(retryDownload(async()=>{attempts++; throw Object.assign(new Error('404'),{status:404});},options),/404/);
  assert.equal(attempts,1);
  attempts = 0;
  await assert.rejects(retryDownload(async()=>{attempts++; throw new TypeError('offline');},options),/offline/);
  assert.equal(attempts,4);
});

test('database reads include courses exceeding the default response cap', async () => {
  const source = Array.from({length:1201}, (_, id) => ({id}));
  const result = await allRows(() => ({range:async (from,to) => ({data:source.slice(from,to+1)})}));
  assert.equal(result.length,1201);
  await assert.rejects(allRows(() => ({range:async()=>({error:{message:'offline'}})})),/offline/);
});
