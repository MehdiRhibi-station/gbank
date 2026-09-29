-- The source of truth shown to students is a crop from the original exam.
-- Transcription remains searchable and accessible, but does not silently
-- replace the printed question.

alter table public.questions
  add column if not exists image_path text,
  add column if not exists image_page integer,
  add column if not exists image_bbox jsonb,
  add column if not exists image_width integer,
  add column if not exists image_height integer;

alter table public.courses
  add column if not exists text_is_source boolean not null default false;

create or replace function public.is_valid_image_bbox(box jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  x double precision;
  y double precision;
  w double precision;
  h double precision;
begin
  if box is null then
    return true;
  end if;
  if jsonb_typeof(box) is distinct from 'object'
     or not (box ?& array['x', 'y', 'w', 'h'])
     or jsonb_typeof(box -> 'x') is distinct from 'number'
     or jsonb_typeof(box -> 'y') is distinct from 'number'
     or jsonb_typeof(box -> 'w') is distinct from 'number'
     or jsonb_typeof(box -> 'h') is distinct from 'number' then
    return false;
  end if;

  x := (box ->> 'x')::double precision;
  y := (box ->> 'y')::double precision;
  w := (box ->> 'w')::double precision;
  h := (box ->> 'h')::double precision;
  return x >= 0 and y >= 0 and w > 0 and h > 0
    and x <= 1 and y <= 1 and x + w <= 1 and y + h <= 1;
exception
  when others then return false;
end;
$$;

alter table public.questions
  drop constraint if exists questions_image_page_check,
  drop constraint if exists questions_image_bbox_check,
  drop constraint if exists questions_image_dimensions_check,
  drop constraint if exists questions_image_page_bbox_pair_check;

alter table public.questions
  add constraint questions_image_page_check
    check (image_page is null or image_page >= 1),
  add constraint questions_image_bbox_check
    check (public.is_valid_image_bbox(image_bbox)),
  add constraint questions_image_dimensions_check
    check (
      (image_width is null or image_width > 0)
      and (image_height is null or image_height > 0)
    ),
  add constraint questions_image_page_bbox_pair_check
    check ((image_page is null) = (image_bbox is null));

-- A crop is derived from its page and rectangle. If either input changes, the
-- old object is no longer evidence for the new coordinates and must be rebuilt.
create or replace function public.clear_stale_question_crop()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.image_page is distinct from new.image_page
     or old.image_bbox is distinct from new.image_bbox then
    new.image_path = null;
    new.image_width = null;
    new.image_height = null;
    new.is_published = false;
  end if;
  return new;
end;
$$;

drop trigger if exists b_clear_stale_question_crop on public.questions;
create trigger b_clear_stale_question_crop
before update of image_page, image_bbox on public.questions
for each row execute function public.clear_stale_question_crop();

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
    raise exception 'Image-first questions need an uploaded crop before publication'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists z_enforce_question_publication on public.questions;
create trigger z_enforce_question_publication
before insert or update of
  is_published, extraction_status, exam_id, image_path
on public.questions
for each row execute function public.enforce_question_publication();

-- Existing published rows without crops must not remain silently visible after
-- a course becomes image-first. Owners can opt a course into text-first mode.
update public.questions as question
set is_published = false
from public.exams as exam
join public.courses as course on course.number = exam.course_number
where question.exam_id = exam.id
  and not course.text_is_source
  and (question.image_path is null or btrim(question.image_path) = '')
  and question.is_published;

drop view if exists public.live_questions;
create view public.live_questions
with (security_invoker = true)
as
select question.*
from public.questions as question
where question.retired_at is null;

grant select on public.live_questions to anon, authenticated, service_role;
