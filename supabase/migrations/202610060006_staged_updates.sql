-- Private candidate revisions. Never hide live content while an update is built.
-- Apply once after 202609270005. This migration does not unpublish any rows.
begin;

create table if not exists public.question_updates (
  question_id text primary key references public.questions(id) on update cascade on delete cascade,
  revision uuid not null default gen_random_uuid(),
  draft jsonb not null,
  image_path text,
  image_width integer check (image_width > 0),
  image_height integer check (image_height > 0),
  review_status public.crop_review_status not null default 'pending',
  updated_at timestamptz not null default now()
);
alter table public.question_updates enable row level security;
revoke all on public.question_updates from public, anon, authenticated;
grant all on public.question_updates to service_role;

create or replace function public.stage_question_update(p_draft jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  candidate public.questions;
  target public.questions;
begin
  candidate := jsonb_populate_record(null::public.questions, p_draft);
  if candidate.image_page is not null and candidate.image_page < 1
     or (candidate.image_page is null) <> (candidate.image_bbox is null)
     or not public.is_valid_image_bbox(candidate.image_bbox) then
    raise exception 'Invalid candidate page or box';
  end if;
  -- Insert new questions hidden; existing identity and all user data stay intact.
  insert into public.questions(id, exam_id, ordinal, question_number, subpart,
    points, nature, difficulty, topics, title, context, statement, uncertain, extractor, is_published)
  values(candidate.id, candidate.exam_id, candidate.ordinal, candidate.question_number,
    coalesce(candidate.subpart, ''), candidate.points, candidate.nature, candidate.difficulty,
    candidate.topics, candidate.title, candidate.context, candidate.statement,
    candidate.uncertain, candidate.extractor, false)
  on conflict (exam_id, question_number, subpart) do nothing;
  select * into strict target from public.questions
  where exam_id = candidate.exam_id and question_number = candidate.question_number
    and subpart = coalesce(candidate.subpart, '') for update;

  -- Canonical ID is stable even when the extractor changes its generated IDs.
  p_draft := p_draft || jsonb_build_object('id', target.id);
  insert into public.question_updates(question_id, draft) values(target.id, p_draft)
  on conflict(question_id) do update set
    draft = excluded.draft, revision = gen_random_uuid(), image_path = null,
    image_width = null, image_height = null, review_status = 'pending', updated_at = now()
  where question_updates.draft is distinct from excluded.draft;
  return target.id;
end;
$$;

create or replace function public.stage_question_crop(
  p_question_id text, p_revision uuid, p_path text, p_width integer, p_height integer
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_path is null or btrim(p_path) = '' or p_width is null or p_height is null
     or p_width <= 0 or p_height <= 0 then
    raise exception 'Invalid crop path or dimensions';
  end if;
  update public.question_updates set image_path = p_path, image_width = p_width,
    image_height = p_height,
    review_status = case when image_path = p_path then review_status
      else 'pending'::public.crop_review_status end,
    updated_at = now()
  where question_id = p_question_id and revision = p_revision;
  if not found then raise exception 'Candidate changed during rendering; rerun cropping'; end if;
end;
$$;

create or replace function public.review_question_update(
  p_question_id text, p_expected_image_path text, p_approved boolean, p_publish boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target public.questions;
  pending public.question_updates;
  candidate public.questions;
begin
  select * into strict target from public.questions where id = p_question_id for update;
  select * into strict pending from public.question_updates where question_id = p_question_id for update;
  if pending.image_path is null or pending.image_path is distinct from p_expected_image_path then
    raise exception 'Stale review: candidate image changed';
  end if;
  update public.question_updates set review_status = case when p_approved then
    'approved'::public.crop_review_status else 'rejected'::public.crop_review_status end,
    updated_at = now() where question_id = p_question_id;
  if not p_approved or not p_publish then return false; end if;
  candidate := jsonb_populate_record(null::public.questions, pending.draft);
  if candidate.image_page is null or candidate.image_bbox is null then
    raise exception 'Candidate lacks source coordinates';
  end if;
  -- Multiple statements in ONE transaction: triggers invalidate old evidence,
  -- then we attach and approve the new image before committing publication.
  update public.questions set ordinal = candidate.ordinal, points = candidate.points,
    nature = candidate.nature, difficulty = candidate.difficulty, topics = candidate.topics,
    title = candidate.title, context = candidate.context, statement = candidate.statement,
    uncertain = candidate.uncertain, extractor = candidate.extractor,
    image_page = candidate.image_page, image_bbox = candidate.image_bbox,
    retired_at = null, is_published = false where id = target.id;
  update public.questions set image_path = pending.image_path,
    image_width = pending.image_width, image_height = pending.image_height where id = target.id;
  update public.questions set crop_review_status = 'approved', crop_reviewed_at = now(),
    crop_reviewed_by = auth.uid() where id = target.id;
  update public.questions set is_published = true where id = target.id;
  return true;
end;
$$;

revoke all on function public.stage_question_update(jsonb) from public, anon, authenticated;
revoke all on function public.stage_question_crop(text, uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.review_question_update(text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.stage_question_update(jsonb) to service_role;
grant execute on function public.stage_question_crop(text, uuid, text, integer, integer) to service_role;
grant execute on function public.review_question_update(text, text, boolean, boolean) to service_role;
commit;
