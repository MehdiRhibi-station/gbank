# גיבנק — exam question bank

A question bank for HUJI **חשבון אינפיניטסימלי 1 (80131)**: search exam questions
by topic and by the kind of question, read hints instead of full solutions, and
track what you've finished.

Live page: https://claude.ai/artifact/JhPciZzCMiw3UWGnyoKcqW

## Files

```
index.html              the whole site — markup, styles, data and logic in one file
data/questions.json     the question bank on its own, for rebuilding the front end
tools/gbank-extractor.html   PDF → structured questions, using Claude's vision, with a review screen
tools/fetch_exams.py    downloads the exam PDFs from the HUJI exam bank
```

`index.html` needs no build step and no server — open it in a browser.
`data/questions.json` is the same bank as plain data, so it is not trapped inside the
page. `tools/gbank-extractor.html` predates the hand transcription of the 93 questions
and is the path for bulk-loading another course. `tools/fetch_exams.py` needs
`BASE_URL` and a session cookie filled in.

## Data

93 questions from 12 exams (2023–2025, both semesters, both moadim). Each question:

```json
{
  "id": "25a1-1",          // unique
  "ex": "25a1",            // key into "exams"
  "o": 1,                  // order within the exam
  "q": "1", "s": "",       // question number, sub-part (א / ב / ג, empty if none)
  "pts": "20 נק׳",
  "nat": "prove",          // key into "natures"
  "lvl": "mid",            // easy | mid | hard — my estimate, not measured
  "top": ["sup", "seq"],   // keys into "topics"
  "title": "…",
  "ctx": "…",              // shared stem, present only when sub-parts share one
  "st": "…",               // the question as printed
  "unc": true              // present only where the scan was unclear
}
```

Hebrew is plain text; mathematics is LaTeX between `$…$` (or `$$…$$` when displayed),
rendered by MathJax. Sub-parts are separate entries because they are answered
independently — the 2025 paper says so explicitly.

One entry carries `unc`: question 3 of 2023 semester ב moed ב, where the second
branch of the case definition is smudged on the scan. The card shows a
"בדקו מול הסריקה" chip for it.

## Running it

Two things behave differently
depending on where it runs:

- **Shared state** (hints, view counts, how many people finished each question) and
  **private state** (what you liked and finished) use the `db` and `user` runtime
  capabilities, available when the page is published as a Claude artifact. Opened as
  a plain local file it still works — search, filters, all 93 questions, source
  pages — but nothing persists and hints can't be posted.
- **דף המקור** renders the exam PDFs with pdf.js in your browser. Attach them with
  צרפו מבחן למאגר; files are matched by name (`80131_2025_1_1_1.pdf`) and never
  leave your machine.

External dependencies, loaded from cdnjs: MathJax 3.2.2 and pdf.js 3.11.174. Heebo
comes from Google Fonts.

## Adding exams

1. Add an entry to `EXAMS` in `index.html` — chronological index `n`, year,
   semester, moed, date, teaching staff, filename, and how many questions had to be
   answered.
2. Add the questions to `SEED` in the shape above, and re-export `data/questions.json`.

Both live near the top of the `<script>` block. The filters, the counts on the course
card, and the suggested topics all derive from the data, so nothing else needs
touching.

`tools/gbank-extractor.html` can do step 2 automatically for a new course: it renders each
page, sends it to Claude as an image, and returns structured items for you to approve
one by one. It never guesses a formula — unreadable spots come back as `[?]` and get
flagged. Transcription quality drops on older scans, so check each item against the
page before trusting it.

## Contributing hints

Hints are the point of the site: a hint should give a direction, never a full solution.
They are written from the page itself, not in this repo.

## Copyright

The questions were written by the course staff and the rights belong to the Hebrew
University. The site shows no full solutions.
