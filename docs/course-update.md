# Owner-only course updates

## One-time setup

1. Back up your Supabase database using your normal backup procedure.
2. In Supabase SQL Editor, run the complete contents of
   `supabase/migrations/202610060006_staged_updates.sql`. Prior migrations through
   `202609270005_crop_review.sql` must already exist. Do not rerun the old crop-review
   migration: it intentionally unpublished historical images when first installed.
3. In the project folder containing `package.json`, run `npm install`.
4. Keep the real values of `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   and `GEMINI_API_KEY` in `.env.local`. Keep your working `GEMINI_MODEL` selection.
   Set `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the post-publication visitor-access check.
   Never put the service key in frontend code or commit `.env.local`.

No frontend redeployment is needed for staged publication: approved replacements
are promoted into the existing questions table and existing image fields.
The new scripts refuse to write if the staging migration is missing.

## Normal workflow

```powershell
cd "$env:USERPROFILE\Downloads\gbank-image-first"
npm run course:update -- 80181 --from 2016 --course-name "מתמטיקה דיסקרטית"
```

The end year defaults to the current year on a new run. A resumed run keeps its
original year range. The updater checks database configuration before extraction,
then runs download/extraction, grouping, box repair, staging, and cropping.
Gemini usage requires your normal extraction confirmation; `--yes` explicitly
consents without prompting. Rendering/repair can still take time and use API quota.

Review opens at `crop-review/80181-update/index.html`. Check the full question,
all subparts and matrices, and the next question boundary. Approve good crops;
reject bad crops. Choices persist in the same browser for the exact image path.
If browser storage is disabled, download before closing. Downloads are still your
portable backup; moving the review folder or switching browsers may not preserve
browser-local choices. Unuploaded images cannot be approved.

Click **Download decisions** in the review page. Then:

```powershell
npm run course:update -- 80181 --publish --dry-run
npm run course:update -- 80181 --publish
```

The newest `crop-decisions-80181.json` or browser-numbered copy in your Downloads
folder is selected and its exact image paths validated. A stale file is rejected,
not silently replaced with another. For a custom Downloads location:

```powershell
npm run course:update -- 80181 --publish --file "C:\path\crop-decisions-80181.json"
```

Publication is atomic **per question**, not per course. If a connection fails
halfway, rerun the publish command with the same decisions; already-applied
decisions are safe to repeat. Bad/pending replacement images do not hide live ones.
New questions remain hidden until approved and published. This does not automatically
fix bad boxes or multi-page questions; those still require source-image review.

## Resume, refresh, and status

```powershell
npm run course:update -- 80181
npm run course:update -- 80181 --status
npm run course:update -- 80181 --refresh
npm run course:update -- 80181 --dry-run
```

- Plain rerun resumes the failed step; completed step outputs are hash-checked.
  Page-level extraction/repair caches remain in use. No `--force-extract` is needed.
- `--refresh` begins a new pass to discover newer exams, reusing paid extraction
  caches. Use `--to YEAR` if extending a saved range into a new calendar year.
- `--status` reads live/staged/blocked counts without changing anything.
- `--dry-run` prints the plan without paid calls or database/file changes.
- `--no-open` suppresses opening the browser; `--delay-ms 6000` controls repair pacing.
- Download failures get bounded backoff. Quota exhaustion still requires waiting
  for your provider's quota to reset or changing your plan; a delay cannot create quota.
- A per-course lock prevents two unified updaters running together. Do not run
  the old individual scripts concurrently with the unified updater.

Do not delete `imports/` or `crop-review/`: these are your local progress and review
artifacts, not generated application build folders. Keep backups outside GitHub.
An expired/replaced workspace or another computer does not have these local caches.

## Safety and compatibility

`question_updates` is a private, service-role-only staging table. Each changed
draft gets a new revision; crops and reviews bind to that revision. Student clients
cannot read candidates or call staging/review functions. Promotion updates text,
coordinates, image and approval in one database transaction and retains the question
ID, hints, votes and progress. The existing publication triggers remain active.

The individual `import:course`, `crop:questions` and `review:crops` commands now use
staging too. Old review files referring to live images are not valid approvals for
new staged replacements: import the repaired draft and generate/review new candidates.
The `--prepare-only` crop option still does not upload or link anything.

Imports are **additive by default**. The explicit `import:course --retire-missing`
option is reserved for intentional full-course replacement: absent questions are
hidden, so do not use it for a partial year range. The unified updater never uses it.
Source-PDF uploads are reused when the database hash and stored path already match.

After publishing, the CLI checks visibility through the public Supabase key when
configured. That verifies database access, not browser image rendering or Vercel's
environment selection. If the site is still empty, confirm Vercel uses the same
Supabase project and inspect its read policies rather than re-extracting exams.

## Tests

`npm test` includes an isolated PostgreSQL (PGlite) integration test using the real
application migrations and triggers. It verifies staging, preservation of published
content and user progress, stale review rejection, repeat publication, transaction
rollback, and anonymous permission denial. It does not contact production or Gemini.
