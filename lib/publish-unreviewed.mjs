import { allRows } from './pipeline-db.mjs';

// Read candidates only from the requested course. No decision files or AI calls.
export async function publishUnreviewed(client, course, { dryRun = false, log = console.log } = {}) {
  const check = await client.from('questions').select('owner_publish_override').limit(1);
  if (check.error) throw new Error('Apply supabase/migrations/202610060007_owner_unreviewed.sql first.');
  const exams = await allRows(() => client.from('exams').select('id').eq('course_number', course).order('id'));
  const questions = [];
  for (let i = 0; i < exams.length; i += 100) questions.push(...await allRows(() =>
    client.from('questions').select('id,image_path,is_published,retired_at')
      .in('exam_id', exams.slice(i, i + 100).map(e => e.id)).order('id')));
  const current = new Map(questions.map(q => [q.id, q]));
  const updates = [];
  for (let i = 0; i < questions.length; i += 200) updates.push(...await allRows(() =>
    client.from('question_updates').select('question_id,revision,image_path,review_status,draft')
      .in('question_id', questions.slice(i, i + 200).map(q => q.id)).order('question_id')));
  const eligible = updates.filter(q => {
    const live = current.get(q.question_id);
    return live && !live.retired_at && q.review_status === 'pending' && q.image_path?.trim()
      && q.draft.image_page && q.draft.image_bbox
      && !(live.is_published && live.image_path === q.image_path);
  });
  log(`Ready to publish without review: ${eligible.length}. Skipped: ${updates.length - eligible.length} (missing crop/box, retired, reviewed, or already live).`);
  if (dryRun) { log('Dry run: nothing changed.'); return; }
  let published = 0;
  for (const q of eligible) {
    const result = await client.rpc('publish_question_update_unreviewed', {
      p_question_id: q.question_id, p_expected_image_path: q.image_path, p_revision: q.revision,
    });
    if (result.error) throw new Error(`${published} published before stopping: ${result.error.message}. Rerun the same command to continue.`);
    if (result.data === true) published++;
  }
  log(`Published ${published} question(s) without human review. Missing or rejected crops stay hidden; existing live questions were preserved.`);
}
