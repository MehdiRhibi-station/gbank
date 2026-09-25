-- Restrict account creation and authenticated writes to approved Hebrew
-- University email domains.
--
-- This migration enforces the rule in two places:
--   1. A trigger on auth.users rejects new non-HUJI accounts regardless of the
--      sign-up path used.
--   2. RLS policies and the security-definer hint-vote RPC reject writes from
--      non-HUJI accounts that existed before this migration.
--
-- Supabase email confirmation must also remain enabled. Domain validation says
-- an address has an approved suffix; confirmation proves the user controls it.

create or replace function public.huji_domains()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'mail.huji.ac.il',
    'huji.ac.il',
    'math.huji.ac.il',
    'cs.huji.ac.il',
    'savion.huji.ac.il'
  ]::text[];
$$;

create or replace function public.is_huji_email(addr text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with normalized as (
    select lower(btrim(coalesce(addr, ''))) as value
  )
  select
    value ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    and split_part(value, '@', 2) = any (public.huji_domains())
  from normalized;
$$;

create or replace function public.enforce_huji_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_huji_email(new.email) then
    raise exception 'gbank: only Hebrew University addresses can sign in'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_huji_signup on auth.users;
create trigger enforce_huji_signup
  before insert on auth.users
  for each row execute function public.enforce_huji_signup();

create or replace function public.is_huji()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_huji_email(auth.jwt() ->> 'email');
$$;

revoke all on function public.huji_domains() from public;
revoke all on function public.is_huji_email(text) from public;
revoke all on function public.enforce_huji_signup() from public;
revoke all on function public.is_huji() from public;
grant execute on function public.is_huji() to authenticated, anon;

-- Protect every existing user-owned write policy. Read policies remain
-- unchanged so published questions and each user's existing data retain their
-- current visibility.

drop policy if exists "Users insert their own progress" on public.question_progress;
create policy "Users insert their own progress"
  on public.question_progress for insert to authenticated
  with check (auth.uid() = user_id and public.is_huji());

drop policy if exists "Users update their own progress" on public.question_progress;
create policy "Users update their own progress"
  on public.question_progress for update to authenticated
  using (auth.uid() = user_id and public.is_huji())
  with check (auth.uid() = user_id and public.is_huji());

drop policy if exists "Users delete their own progress" on public.question_progress;
create policy "Users delete their own progress"
  on public.question_progress for delete to authenticated
  using (auth.uid() = user_id and public.is_huji());

drop policy if exists "Users publish their own hints" on public.hints;
create policy "Users publish their own hints"
  on public.hints for insert to authenticated
  with check (
    auth.uid() = user_id
    and status in ('pending', 'published')
    and public.is_huji()
  );

drop policy if exists "Users delete their own hints" on public.hints;
create policy "Users delete their own hints"
  on public.hints for delete to authenticated
  using (auth.uid() = user_id and public.is_huji());

drop policy if exists "Users add their own hint votes" on public.hint_votes;
create policy "Users add their own hint votes"
  on public.hint_votes for insert to authenticated
  with check (auth.uid() = user_id and public.is_huji());

drop policy if exists "Users remove their own hint votes" on public.hint_votes;
create policy "Users remove their own hint votes"
  on public.hint_votes for delete to authenticated
  using (auth.uid() = user_id and public.is_huji());

-- toggle_hint_vote is SECURITY DEFINER and can bypass table RLS, so it needs
-- the same explicit domain check as the policies above.
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

  if not public.is_huji() then
    raise exception 'gbank: only Hebrew University addresses can vote on hints'
      using errcode = '42501';
  end if;

  delete from public.hint_votes
  where hint_id = p_hint_id and user_id = auth.uid();
  get diagnostics affected = row_count;
  if affected > 0 then
    return false;
  end if;

  insert into public.hint_votes (hint_id, user_id)
  select p_hint_id, auth.uid()
  where exists (
    select 1 from public.hints
    where id = p_hint_id and status = 'published'
  );
  return true;
end;
$$;

revoke all on function public.toggle_hint_vote(uuid) from public;
grant execute on function public.toggle_hint_vote(uuid) to authenticated;

-- Existing non-HUJI accounts are intentionally retained, but cannot write.
-- Audit them after applying the migration with:
--
--   select id, email, created_at
--   from auth.users
--   where not public.is_huji_email(email);
