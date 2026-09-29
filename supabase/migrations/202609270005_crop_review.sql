-- A stored image is not automatically a trustworthy image. Crops generated
-- from machine coordinates must be reviewed before an image-first question can
-- be published. Replacing the source page, box, or stored image invalidates the
-- previous review and unpublishes the row.

do $$
begin
  create type public.crop_review_status as enum ('pending', 'approved', 'rejected');
exception
  when duplicate_object then null;
end;
$$;

alter table public.questions
  add column if not exists crop_review_status public.crop_review_status
    not null default 'pending',
  add column if not exists crop_reviewed_at timestamptz,
  add column if not exists crop_reviewed_by uuid
    references auth.users(id) on delete set null;

create or replace function public.clear_crop_review_on_image_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.image_path is distinct from new.image_path
     or old.image_page is distinct from new.image_page
     or old.image_bbox is distinct from new.image_bbox then
    new.crop_review_status = 'pending';
    new.crop_reviewed_at = null;
    new.crop_reviewed_by = null;
    new.is_published = false;
  end if;
  return new;
end;
$$;

drop trigger if exists c_clear_crop_review on public.questions;
create trigger c_clear_crop_review
before update of image_path, image_page, image_bbox on public.questions
for each row execute function public.clear_crop_review_on_image_change();

create or replace function public.mark_crop_reviewed(
  p_question_id text,
  p_expected_image_path text,
  p_approved boolean,
  p_reviewed_by uuid default auth.uid()
)
returns public.questions
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewed_question public.questions;
begin
  if p_approved and not exists (
    select 1
    from public.questions
    where id = p_question_id
      and retired_at is null
      and image_path is not null
      and btrim(image_path) <> ''
      and image_path = p_expected_image_path
  ) then
    raise exception 'Question has no current image to approve: %', p_question_id
      using errcode = '23514';
  end if;

  update public.questions
  set crop_review_status = case
        when p_approved then 'approved'::public.crop_review_status
        else 'rejected'::public.crop_review_status
      end,
      crop_reviewed_at = now(),
      crop_reviewed_by = p_reviewed_by,
      is_published = false
  where id = p_question_id
    and retired_at is null
    and image_path = p_expected_image_path
  returning * into reviewed_question;

  if reviewed_question.id is null then
    raise exception 'Question not found, retired, or its image changed: %', p_question_id
      using errcode = 'P0002';
  end if;
  return reviewed_question;
end;
$$;

revoke all on function public.mark_crop_reviewed(text, text, boolean, uuid) from public;
grant execute on function public.mark_crop_reviewed(text, text, boolean, uuid) to service_role;

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
  elsif new.crop_review_status <> 'approved' then
    raise exception 'Image-first questions need an approved source image before publication'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists z_enforce_question_publication on public.questions;
create trigger z_enforce_question_publication
before insert or update of
  is_published, extraction_status, exam_id, image_path, crop_review_status
on public.questions
for each row execute function public.enforce_question_publication();

-- Existing crops predate the review fact, so none of them are grandfathered
-- in. This intentionally hides image-first questions until their exact source
-- images have been inspected.
update public.questions as question
set crop_review_status = 'pending',
    crop_reviewed_at = null,
    crop_reviewed_by = null,
    is_published = false
from public.exams as exam
join public.courses as course on course.number = exam.course_number
where question.exam_id = exam.id
  and not course.text_is_source
  and question.retired_at is null;

create or replace view public.course_coverage
with (security_invoker = true)
as
select
  exam.course_number,
  exam.id as exam_id,
  exam.year,
  exam.semester,
  exam.moed,
  count(question.id) filter (where question.retired_at is null) as total,
  count(question.id) filter (
    where question.retired_at is null
      and question.extraction_status in ('verified', 'corrected')
  ) as checked,
  count(question.id) filter (
    where question.retired_at is null and question.uncertain
  ) as flagged,
  count(question.id) filter (
    where question.retired_at is null and question.is_published
  ) as published,
  count(question.id) filter (
    where question.retired_at is null
      and question.image_path is not null
      and btrim(question.image_path) <> ''
  ) as imaged,
  count(question.id) filter (
    where question.retired_at is null
      and question.crop_review_status = 'approved'
  ) as image_approved
from public.exams as exam
left join public.questions as question on question.exam_id = exam.id
group by exam.course_number, exam.id, exam.year, exam.semester, exam.moed;

grant select on public.course_coverage to authenticated, service_role;

-- Views created with select * keep the column list from creation time.
drop view if exists public.live_questions;
create view public.live_questions
with (security_invoker = true)
as
select question.*
from public.questions as question
where question.retired_at is null;

grant select on public.live_questions to anon, authenticated, service_role;
