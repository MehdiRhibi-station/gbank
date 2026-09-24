create extension if not exists pgcrypto;

create table if not exists public.courses (
  number text primary key,
  name text not null,
  aliases text[] not null default '{}',
  department text,
  topics jsonb not null default '{}'::jsonb,
  natures jsonb not null default '{}'::jsonb,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.exams (
  id text primary key,
  course_number text not null references public.courses(number) on delete cascade,
  ordinal integer not null,
  year integer not null check (year between 1900 and 2200),
  semester text not null,
  moed text not null,
  exam_date text,
  instructors text,
  source_filename text not null,
  storage_path text,
  questions_to_answer text,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_number, source_filename)
);

create table if not exists public.questions (
  id text primary key,
  exam_id text not null references public.exams(id) on delete cascade,
  ordinal integer not null,
  question_number text not null,
  subpart text not null default '',
  points text,
  nature text not null,
  difficulty text not null check (difficulty in ('easy', 'mid', 'hard')),
  topics text[] not null default '{}',
  title text not null,
  context text,
  statement text not null,
  uncertain boolean not null default false,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists questions_exam_id_idx on public.questions(exam_id);
create index if not exists questions_topics_idx on public.questions using gin(topics);
create index if not exists exams_course_number_idx on public.exams(course_number);

create table if not exists public.question_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id text not null references public.questions(id) on delete cascade,
  liked boolean not null default false,
  solved boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id)
);

create table if not exists public.question_stats (
  question_id text primary key references public.questions(id) on delete cascade,
  likes integer not null default 0 check (likes >= 0),
  views integer not null default 0 check (views >= 0),
  solves integer not null default 0 check (solves >= 0)
);

create table if not exists public.hints (
  id uuid primary key default gen_random_uuid(),
  question_id text not null references public.questions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null check (char_length(text) between 3 and 1200),
  status text not null default 'published' check (status in ('pending', 'published', 'hidden')),
  votes_count integer not null default 0 check (votes_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hints_question_id_idx on public.hints(question_id);

create table if not exists public.hint_votes (
  hint_id uuid not null references public.hints(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (hint_id, user_id)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_courses_updated_at on public.courses;
create trigger set_courses_updated_at before update on public.courses
for each row execute function public.set_updated_at();

drop trigger if exists set_exams_updated_at on public.exams;
create trigger set_exams_updated_at before update on public.exams
for each row execute function public.set_updated_at();

drop trigger if exists set_questions_updated_at on public.questions;
create trigger set_questions_updated_at before update on public.questions
for each row execute function public.set_updated_at();

drop trigger if exists set_hints_updated_at on public.hints;
create trigger set_hints_updated_at before update on public.hints
for each row execute function public.set_updated_at();

create or replace function public.ensure_question_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.question_stats (question_id)
  values (new.id)
  on conflict (question_id) do nothing;
  return new;
end;
$$;

drop trigger if exists ensure_question_stats_after_insert on public.questions;
create trigger ensure_question_stats_after_insert
after insert on public.questions
for each row execute function public.ensure_question_stats();

create or replace function public.refresh_question_progress_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_question_id text;
begin
  target_question_id := case when tg_op = 'DELETE' then old.question_id else new.question_id end;
  insert into public.question_stats (question_id, likes, views, solves)
  values (
    target_question_id,
    (select count(*)::integer from public.question_progress where question_id = target_question_id and liked),
    coalesce((select views from public.question_stats where question_id = target_question_id), 0),
    (select count(*)::integer from public.question_progress where question_id = target_question_id and solved)
  )
  on conflict (question_id) do update
  set likes = excluded.likes,
      solves = excluded.solves;
  return null;
end;
$$;

drop trigger if exists refresh_question_progress_stats_after_change on public.question_progress;
create trigger refresh_question_progress_stats_after_change
after insert or update or delete on public.question_progress
for each row execute function public.refresh_question_progress_stats();

create or replace function public.refresh_hint_vote_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_hint_id uuid;
begin
  target_hint_id := case when tg_op = 'DELETE' then old.hint_id else new.hint_id end;
  update public.hints
  set votes_count = (select count(*)::integer from public.hint_votes where hint_id = target_hint_id)
  where id = target_hint_id;
  return null;
end;
$$;

drop trigger if exists refresh_hint_vote_count_after_change on public.hint_votes;
create trigger refresh_hint_vote_count_after_change
after insert or delete on public.hint_votes
for each row execute function public.refresh_hint_vote_count();

create or replace function public.increment_question_view(p_question_id text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.question_stats (question_id, views)
  select p_question_id, 1
  where exists (select 1 from public.questions where id = p_question_id and is_published)
  on conflict (question_id) do update
  set views = public.question_stats.views + 1;
$$;

create or replace function public.toggle_hint_vote(p_hint_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  delete from public.hint_votes where hint_id = p_hint_id and user_id = auth.uid();
  get diagnostics affected = row_count;
  if affected > 0 then
    return false;
  end if;

  insert into public.hint_votes (hint_id, user_id)
  select p_hint_id, auth.uid()
  where exists (select 1 from public.hints where id = p_hint_id and status = 'published');
  return true;
end;
$$;

revoke all on function public.increment_question_view(text) from public;
grant execute on function public.increment_question_view(text) to anon, authenticated;
revoke all on function public.toggle_hint_vote(uuid) from public;
grant execute on function public.toggle_hint_vote(uuid) to authenticated;

alter table public.courses enable row level security;
alter table public.exams enable row level security;
alter table public.questions enable row level security;
alter table public.question_progress enable row level security;
alter table public.question_stats enable row level security;
alter table public.hints enable row level security;
alter table public.hint_votes enable row level security;

drop policy if exists "Published courses are readable" on public.courses;
create policy "Published courses are readable" on public.courses for select
using (is_published);

drop policy if exists "Published exams are readable" on public.exams;
create policy "Published exams are readable" on public.exams for select
using (is_published);

drop policy if exists "Published questions are readable" on public.questions;
create policy "Published questions are readable" on public.questions for select
using (is_published);

drop policy if exists "Question stats are readable" on public.question_stats;
create policy "Question stats are readable" on public.question_stats for select
using (exists (select 1 from public.questions where questions.id = question_id and questions.is_published));

drop policy if exists "Users read their own progress" on public.question_progress;
create policy "Users read their own progress" on public.question_progress for select
using (auth.uid() = user_id);

drop policy if exists "Users insert their own progress" on public.question_progress;
create policy "Users insert their own progress" on public.question_progress for insert
with check (auth.uid() = user_id);

drop policy if exists "Users update their own progress" on public.question_progress;
create policy "Users update their own progress" on public.question_progress for update
using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users delete their own progress" on public.question_progress;
create policy "Users delete their own progress" on public.question_progress for delete
using (auth.uid() = user_id);

drop policy if exists "Published hints are readable" on public.hints;
create policy "Published hints are readable" on public.hints for select
using (status = 'published');

drop policy if exists "Users publish their own hints" on public.hints;
create policy "Users publish their own hints" on public.hints for insert
with check (auth.uid() = user_id and status in ('pending', 'published'));

drop policy if exists "Users delete their own hints" on public.hints;
create policy "Users delete their own hints" on public.hints for delete
using (auth.uid() = user_id);

drop policy if exists "Users read their own hint votes" on public.hint_votes;
create policy "Users read their own hint votes" on public.hint_votes for select
using (auth.uid() = user_id);

drop policy if exists "Users add their own hint votes" on public.hint_votes;
create policy "Users add their own hint votes" on public.hint_votes for insert
with check (auth.uid() = user_id);

drop policy if exists "Users remove their own hint votes" on public.hint_votes;
create policy "Users remove their own hint votes" on public.hint_votes for delete
using (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('exam-files', 'exam-files', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Exam files are readable" on storage.objects;
create policy "Exam files are readable" on storage.objects for select
using (bucket_id = 'exam-files');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'question_stats'
     ) then
    alter publication supabase_realtime add table public.question_stats;
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hints'
     ) then
    alter publication supabase_realtime add table public.hints;
  end if;
end;
$$;
