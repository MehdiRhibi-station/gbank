import test from 'node:test';
import assert from 'node:assert/strict';
import { publishUnreviewed } from '../lib/publish-unreviewed.mjs';

function fixture() {
  const calls = [];
  const source = {
    exams: [{id:'exam'}],
    questions: ['ready','missing','rejected','reviewed','retired','live'].map(id => ({
      id, image_path: id + '.png', is_published: id === 'live', retired_at: id === 'retired' ? 'today' : null,
    })),
    question_updates: ['ready','missing','rejected','reviewed','retired','live'].map(id => ({
      question_id:id,revision:'rev',image_path:id === 'missing' ? null : id + '.png',
      review_status:id === 'rejected' ? 'rejected' : id === 'reviewed' ? 'approved' : 'pending',
      draft:{image_page:1,image_bbox:{x:0,y:0,w:1,h:1}},
    })),
  };
  const client = {
    from(table) {
      const query = {select(){return this;},eq(k,v){calls.push([k,v]); return this;},
        in(){return this;}, order(){return this;},limit:async()=>({data:[]}),
        range:async()=>({data:source[table]})};
      return query;
    },
    rpc:async(name,args)=>{calls.push({name,args}); return {data:true};},
  };
  return {client,calls};
}
test('dry run scopes the course and does not publish', async () => {
  const {client,calls} = fixture();
  await publishUnreviewed(client,'80181',{dryRun:true,log(){}});
  assert.deepEqual(calls,[['course_number','80181']]);
});
test('only eligible pending images are published with revision and path checks', async () => {
  const {client,calls} = fixture();
  await publishUnreviewed(client,'80181',{log(){}});
  assert.deepEqual(calls[1],{name:'publish_question_update_unreviewed',args:{
    p_question_id:'ready',p_expected_image_path:'ready.png',p_revision:'rev',
  }});
  assert.equal(calls.length,2);
});
