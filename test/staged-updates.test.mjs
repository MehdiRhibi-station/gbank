import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('staged updates preserve live content, reject stale reviews, and promote atomically', async () => {
  const db = new PGlite();
  try {
    // Supabase platform objects only; application schema and triggers are real migrations.
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id text,bucket_id text);`);
    for (const name of ['202609210001_initial_gbank.sql','202609260002_safe_imports.sql',
      '202609260003_pipeline_integrity.sql','202609260004_image_first.sql',
      '202609270005_crop_review.sql','202610060006_staged_updates.sql']) {
      const sql = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
      // gen_random_uuid is built into PostgreSQL; no other pgcrypto functions are used.
      await db.exec(sql.replace('create extension if not exists pgcrypto;', ''));
    }
    await db.exec(`insert into public.courses(number,name) values('80181','Discrete');
      insert into public.exams(id,course_number,ordinal,year,semester,moed,source_filename)
      values('exam','80181',1,2025,'1','1','exam.pdf');`);
    const draft = {id:'q1',exam_id:'exam',ordinal:1,question_number:'1',subpart:'',points:'10',
      nature:'prove',difficulty:'mid',topics:[],title:'Test',context:null,statement:'Original text',
      uncertain:false,extractor:'test',image_page:1,image_bbox:{x:0,y:0,w:1,h:0.4}};
    const stage = async d => (await db.query('select public.stage_question_update($1::jsonb) as id',[JSON.stringify(d)])).rows[0].id;
    const pending = async () => (await db.query('select * from public.question_updates where question_id=$1',['q1'])).rows[0];
    const live = async () => (await db.query('select * from public.questions where id=$1',['q1'])).rows[0];
    const crop = async (revision, name) => db.query('select public.stage_question_crop($1,$2,$3,100,200)',['q1',revision,name]);
    const review = async (name, approved, publish) => db.query('select public.review_question_update($1,$2,$3,$4)',['q1',name,approved,publish]);
    assert.equal(await stage(draft),'q1');
    const first = await pending();
    await stage(draft);
    assert.equal((await pending()).revision,first.revision,'unchanged imports reuse revision');
    assert.equal((await live()).is_published,false);
    await crop(first.revision,'crops/first.png');
    await review('crops/first.png',true,true);
    assert.equal((await live()).is_published,true);
    assert.equal((await live()).image_path,'crops/first.png');
    await db.exec(`insert into auth.users(id) values('11111111-1111-1111-1111-111111111111');
      insert into public.question_progress(user_id,question_id,solved)
      values('11111111-1111-1111-1111-111111111111','q1',true);`);

    const replacement = {...draft,id:'new-generated-id',statement:'Replacement text',image_page:2};
    assert.equal(await stage(replacement),'q1','identity preserves canonical ID');
    const second = await pending();
    assert.notEqual(second.revision,first.revision);
    assert.equal((await live()).statement,'Original text');
    assert.equal((await live()).is_published,true);
    await assert.rejects(crop(first.revision,'stale.png'),/changed during rendering/);
    await assert.rejects(review('crops/first.png',true,true),/Stale review/);
    await crop(second.revision,'crops/second.png');
    await review('crops/second.png',false,true);
    assert.equal((await live()).image_path,'crops/first.png','rejection keeps old image');
    assert.equal((await live()).is_published,true);
    await review('crops/second.png',true,false);
    assert.equal((await live()).statement,'Original text','approval alone does not swap');
    await review('crops/second.png',true,true);
    assert.equal((await live()).statement,'Replacement text');
    assert.equal((await live()).image_page,2);
    assert.equal((await live()).image_path,'crops/second.png');
    assert.equal((await live()).is_published,true);
    assert.equal((await live()).crop_review_status,'approved');
    await review('crops/second.png',true,true); // retry after uncertain network response
    assert.equal((await live()).is_published,true);
    assert.equal((await db.query('select count(*)::int as n from public.question_progress')).rows[0].n,1);

    // A publication failure must roll back text, coordinates, image AND review.
    await stage({...replacement,statement:'Must roll back'});
    await crop((await pending()).revision,'crops/third.png');
    await db.exec(`update public.courses set text_is_source=true where number='80181'`);
    await assert.rejects(review('crops/third.png',true,true),/must be verified/);
    assert.equal((await live()).statement,'Replacement text');
    assert.equal((await live()).image_path,'crops/second.png');
    assert.equal((await live()).is_published,true);
    assert.equal((await pending()).review_status,'pending');
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.question_updates'),/permission denied/);
    await assert.rejects(stage(draft),/permission denied/);
    await assert.rejects(review('crops/third.png',true,true),/permission denied/);
    await db.exec('reset role');
  } finally { await db.close(); }
});
