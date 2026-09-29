-- Safe, repeatable imports. Imported questions begin as drafts, identifiers can
-- be corrected without orphaning user data, and missing rows are retired rather
-- than deleted.

alter table public.questions
  alter column is_published set default false;

alter table public.exams
  add column if not exists source_hash text;

create unique index if not exists exams_course_source_hash_key
  on public.exams (course_number, source_hash);

alter table public.questions
  add column if not exists retired_at timestamptz;

-- Preserve dependent data when an importer corrects an exam or question id.
alter table public.questions
  drop constraint if exists questions_exam_id_fkey;
alter table public.questions
  add constraint questions_exam_id_fkey
  foreign key (exam_id) references public.exams(id)
  on update cascade on delete cascade;

alter table public.question_progress
  drop constraint if exists question_progress_question_id_fkey;
alter table public.question_progress
  add constraint question_progress_question_id_fkey
  foreign key (question_id) references public.questions(id)
  on update cascade on delete cascade;

alter table public.question_stats
  drop constraint if exists question_stats_question_id_fkey;
alter table public.question_stats
  add constraint question_stats_question_id_fkey
  foreign key (question_id) references public.questions(id)
  on update cascade on delete cascade;

alter table public.hints
  drop constraint if exists hints_question_id_fkey;
alter table public.hints
  add constraint hints_question_id_fkey
  foreign key (question_id) references public.questions(id)
  on update cascade on delete cascade;

create or replace function public.retire_missing_questions(
  p_course_number text,
  p_kept_ids text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.questions as question
  set retired_at = now(),
      is_published = false
  from public.exams as exam
  where question.exam_id = exam.id
    and exam.course_number = p_course_number
    and question.retired_at is null
    and not (question.id = any(coalesce(p_kept_ids, array[]::text[])));

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.retire_missing_questions(text, text[]) from public;
grant execute on function public.retire_missing_questions(text, text[]) to service_role;

drop view if exists public.live_questions;
create view public.live_questions
with (security_invoker = true)
as
select question.*
from public.questions as question
where question.retired_at is null;

grant select on public.live_questions to anon, authenticated, service_role;

