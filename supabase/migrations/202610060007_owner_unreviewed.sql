-- Explicit owner publication without claiming a human review. Apply after 0006.
begin;
alter table public.questions add column if not exists owner_publish_override boolean not null default false;

create or replace function public.clear_owner_publication_override()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.image_path is distinct from new.image_path
    or old.image_page is distinct from new.image_page
    or old.image_bbox is distinct from new.image_bbox
    or old.statement is distinct from new.statement
    or old.context is distinct from new.context
    or old.exam_id is distinct from new.exam_id
    or new.crop_review_status <> 'pending' then
    new.owner_publish_override := false;
    if new.crop_review_status = 'rejected' then new.is_published := false; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists d_clear_owner_publication_override on public.questions;
create trigger d_clear_owner_publication_override before update on public.questions
for each row execute function public.clear_owner_publication_override();
create or replace function public.enforce_question_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  course_allows_unverified boolean;
  course_text_is_source boolean;
begin
  if not new.is_published then
    return new;
  end if;

  select course.allow_unverified, course.text_is_source
  into course_allows_unverified, course_text_is_source
  from public.exams as exam
  join public.courses as course on course.number = exam.course_number
  where exam.id = new.exam_id;

  if coalesce(course_text_is_source, false) then
    if new.extraction_status = 'machine'
       and not coalesce(course_allows_unverified, false) then
      raise exception 'Machine-extracted text-source questions must be verified before publication'
        using errcode = '23514';
    end if;
  elsif new.image_path is null or btrim(new.image_path) = '' then
    raise exception 'Image-first questions need an uploaded source image before publication'
      using errcode = '23514';
  elsif new.crop_review_status <> 'approved' and not (new.owner_publish_override and new.crop_review_status = 'pending' and new.image_page is not null and new.image_bbox is not null) then
    raise exception 'Image-first questions need an approved source image before publication'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists z_enforce_question_publication on public.questions;
create trigger z_enforce_question_publication
before insert or update of
  is_published, extraction_status, exam_id, image_path, crop_review_status, owner_publish_override
on public.questions
for each row execute function public.enforce_question_publication();

create or replace function public.publish_question_update_unreviewed(
  p_question_id text, p_expected_image_path text, p_revision uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target public.questions;
  pending public.question_updates;
  candidate public.questions;
begin
  select * into strict target from public.questions where id = p_question_id for update;
  select * into strict pending from public.question_updates where question_id = p_question_id for update;
  if pending.revision is distinct from p_revision or pending.image_path is null or btrim(pending.image_path) = '' or pending.image_path is distinct from p_expected_image_path then
    raise exception 'Stale review: candidate image changed';
  end if;
  if pending.review_status <> 'pending' or target.retired_at is not null then return false; end if;
  if target.is_published and target.image_path = pending.image_path then return false; end if;
  candidate := jsonb_populate_record(null::public.questions, pending.draft);
  if candidate.image_page is null or candidate.image_bbox is null then
    raise exception 'Candidate lacks source coordinates';
  end if;
  -- Multiple statements in ONE transaction: triggers invalidate old evidence,
  -- then we attach the image and explicitly publish without a review claim.
  update public.questions set ordinal = candidate.ordinal, points = candidate.points,
    nature = candidate.nature, difficulty = candidate.difficulty, topics = candidate.topics,
    title = candidate.title, context = candidate.context, statement = candidate.statement,
    uncertain = candidate.uncertain, extractor = candidate.extractor,
    image_page = candidate.image_page, image_bbox = candidate.image_bbox,
    retired_at = null, is_published = false where id = target.id;
  update public.questions set image_path = pending.image_path,
    image_width = pending.image_width, image_height = pending.image_height where id = target.id;
  update public.questions set crop_review_status = 'pending', crop_reviewed_at = null,
    crop_reviewed_by = null where id = target.id;
  update public.questions set owner_publish_override = true, is_published = true where id = target.id;
  return true;
end;
$$;

revoke all on function public.publish_question_update_unreviewed(text,text,uuid) from public, anon, authenticated;
grant execute on function public.publish_question_update_unreviewed(text,text,uuid) to service_role;
create or replace view public.live_questions with (security_invoker = true) as
select question.* from public.questions as question where question.retired_at is null;
grant select on public.live_questions to anon, authenticated, service_role;
commit;
