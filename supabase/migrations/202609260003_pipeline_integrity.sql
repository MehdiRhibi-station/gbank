-- IMPORTANT: run this collision query before applying the migration. Resolve
-- every returned group by retaining/correcting one row and retiring the rest.
--
-- select
--   exam_id,
--   question_number,
--   coalesce(subpart, '') as subpart,
--   count(*) as row_count,
--   array_agg(id order by created_at, id) as ids
-- from public.questions
-- group by exam_id, question_number, coalesce(subpart, '')
-- having count(*) > 1
-- order by exam_id, question_number, subpart;

do $$
begin
  if exists (
    select 1
    from public.questions
    group by exam_id, question_number, coalesce(subpart, '')
    having count(*) > 1
  ) then
    raise exception
      'Question identity collisions exist. Run the collision query at the top of 202609260003_pipeline_integrity.sql and resolve them first.';
  end if;
end;
$$;

create unique index if not exists questions_printed_identity_key
  on public.questions (exam_id, question_number, coalesce(subpart, ''));

-- PostgREST conflict targets cannot name an expression index. subpart is
-- already NOT NULL, so this equivalent constraint is the importer conflict
-- target while the partial expression index remains the live-row invariant.
alter table public.questions
  drop constraint if exists questions_identity_upsert_key;
alter table public.questions
  add constraint questions_identity_upsert_key
  unique (exam_id, question_number, subpart);

do $$
begin
  create type public.extraction_status as enum ('machine', 'verified', 'corrected');
exception
  when duplicate_object then null;
end;
$$;

alter table public.questions
  add column if not exists extraction_status public.extraction_status
    not null default 'machine',
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references auth.users(id) on delete set null,
  add column if not exists extractor text;

alter table public.courses
  add column if not exists allow_unverified boolean not null default false;

create or replace function public.clear_question_verification_on_text_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.statement is distinct from new.statement
     or old.context is distinct from new.context then
    new.extraction_status = 'machine';
    new.verified_at = null;
    new.verified_by = null;
    new.is_published = false;
  end if;
  return new;
end;
$$;

drop trigger if exists a_clear_question_verification on public.questions;
create trigger a_clear_question_verification
before update of statement, context on public.questions
for each row execute function public.clear_question_verification_on_text_change();

create or replace function public.enforce_question_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  course_allows_unverified boolean;
begin
  if not new.is_published then
    return new;
  end if;

  select course.allow_unverified
  into course_allows_unverified
  from public.exams as exam
  join public.courses as course on course.number = exam.course_number
  where exam.id = new.exam_id;

  if new.extraction_status = 'machine'
     and not coalesce(course_allows_unverified, false) then
    raise exception 'Machine-extracted questions must be verified before publication'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists z_enforce_question_publication on public.questions;
create trigger z_enforce_question_publication
before insert or update of is_published, extraction_status, exam_id
on public.questions
for each row execute function public.enforce_question_publication();

create or replace function public.mark_verified(
  p_question_id text,
  p_corrected boolean default false,
  p_verified_by uuid default auth.uid()
)
returns public.questions
language plpgsql
security definer
set search_path = ''
as $$
declare
  verified_question public.questions;
begin
  update public.questions
  set extraction_status = case
        when p_corrected then 'corrected'::public.extraction_status
        else 'verified'::public.extraction_status
      end,
      verified_at = now(),
      verified_by = p_verified_by
  where id = p_question_id
    and retired_at is null
  returning * into verified_question;

  if verified_question.id is null then
    raise exception 'Question not found or retired: %', p_question_id
      using errcode = 'P0002';
  end if;
  return verified_question;
end;
$$;

revoke all on function public.mark_verified(text, boolean, uuid) from public;
grant execute on function public.mark_verified(text, boolean, uuid) to service_role;

drop view if exists public.course_coverage;
create view public.course_coverage
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
  ) as published
from public.exams as exam
left join public.questions as question on question.exam_id = exam.id
group by exam.course_number, exam.id, exam.year, exam.semester, exam.moed;

grant select on public.course_coverage to authenticated, service_role;
