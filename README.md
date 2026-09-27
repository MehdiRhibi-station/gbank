# גיבנק — GBank

בנק שאלות חכם למבחני האוניברסיטה העברית. גיבנק מרכז מבחנים לפי קורס, שנה,
סמסטר, מועד, מרצה, נושא ואופי השאלה, ומאפשר חיפוש, סינון, רמזים ושמירת התקדמות.

המערכת בנויה בגישת **image-first**: הסטודנט רואה חיתוך מהסריקה המקורית של המבחן.
התמלול שנוצר באמצעות AI נשמר לצורכי חיפוש, תיוג ונגישות — אך אינו מחליף את
המקור המודפס. כך טעות חילוץ שנראית אמינה, כמו חזקה שנעלמה או אי־שוויון שהתהפך,
לא הופכת בטעות לנוסח הרשמי של השאלה.

## יכולות מרכזיות

- ממשק Next.js מלא בעברית וב־RTL, כולל מצב כהה ועיצוב רספונסיבי.
- חיפוש חופשי וסינון לפי קורס, שנה, מועד, מרצה, נושא, קושי ואופי השאלה.
- הצגת חיתוכי מקור חתומים מ־Supabase Storage.
- תמלול סמוי ונגיש עבור חיפוש, קוראי מסך והעתקה.
- התחברות המוגבלת לכתובות HUJI, רמזים קהילתיים, הצבעות ושמירת התקדמות.
- ייבוא חוזר ובטוח: upsert במקום מחיקה, retirement לשאלות חסרות ושמירת מזהים.
- מניעת כפילויות לפי זהות השאלה המודפסת ו־hash של קובץ המקור.
- שער פרסום כפול: שאלה במסלול image-first אינה יכולה להתפרסם ללא תמונת מקור שנבדקה ואושרה.
- חילוץ בענן באמצעות Gemini או OpenAI, וחילוץ מקומי אופציונלי באמצעות Ollama.
- נתוני fallback מקומיים, כך שאפשר להפעיל את הממשק גם לפני חיבור Supabase.

## מחסנית טכנולוגית

| שכבה | טכנולוגיה |
|---|---|
| ממשק | Next.js 16, React 19, TypeScript |
| מסד נתונים ואימות | Supabase Postgres, Auth, RLS |
| אחסון | Supabase Storage |
| חילוץ מומלץ | Gemini 3.5 Flash-Lite |
| עיבוד PDF ותמונות | `pdf-to-img`, `sharp` |
| בדיקות | Node test runner, TypeScript, Next.js production build |

## הרצה מקומית

דרישות: Node.js 22.13 ומעלה.

```powershell
npm install
npm run dev
```

פתחו [http://localhost:3000](http://localhost:3000). אם הפורט תפוס, Next.js יציג
כתובת חלופית כמו `http://localhost:3001`.

ללא `.env.local`, האתר משתמש בנתוני ה־fallback המקומיים. כדי לטעון את מסד הנתונים,
להתחבר ולסנכרן התקדמות, יש לחבר Supabase.

## משתני סביבה

העתיקו את `.env.local.example` אל `.env.local` והחליפו את ערכי הדוגמה:

```powershell
Copy-Item ".env.local.example" ".env.local"
notepad ".env.local"
```

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_YOUR_PUBLIC_KEY

# פרטי: רק כלי הייבוא והעיבוד בצד השרת
SUPABASE_SERVICE_ROLE_KEY=sb_secret_YOUR_PRIVATE_KEY

# פרטי: רק במחשב של בעל האתר
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
GEMINI_EXTRACT_MODEL=gemini-3.5-flash-lite
GEMINI_REQUEST_GAP_MS=3000
GEMINI_MAX_ATTEMPTS=8
```

לעולם אין להוסיף את `.env.local`, מפתח Gemini או Secret/Service Role key ל־GitHub.
רק ערכים שמתחילים ב־`NEXT_PUBLIC_` מיועדים לדפדפן.

## הקמת Supabase

פתחו את SQL Editor והריצו את המיגרציות לפי הסדר:

1. `supabase/migrations/202609210001_initial_gbank.sql`
2. `supabase/migrations/202609260001_huji_only_auth.sql`
3. `supabase/migrations/202609260002_safe_imports.sql`
4. הריצו את שאילתת בדיקת ההתנגשויות שבתחילת `202609260003_pipeline_integrity.sql`.
   אם שתי רשומות טוענות שהן אותה שאלה מודפסת, תקנו אותן לפני המשך המיגרציה.
5. `supabase/migrations/202609260003_pipeline_integrity.sql`
6. `supabase/migrations/202609260004_image_first.sql`
7. `supabase/migrations/202609270005_crop_review.sql` — המיגרציה מסתירה בכוונה את כל שאלות ה־image-first עד שתמונת המקור המדויקת שלהן נבדקת ומאושרת.

לאחר מכן:

1. תחת **Authentication → Providers → Email**, הפעילו **Confirm email**.
2. הוסיפו את כתובת הפיתוח וכתובת הפריסה ל־Auth Redirect URLs.
3. ודאו שה־bucket בשם `exam-files` קיים.

המיגרציות אינן מוחקות שאלות חסרות. הן מסמנות אותן כ־retired ושומרות רמזים,
הצבעות והתקדמות קיימת. שינוי בנוסח או בהקשר מבטל אוטומטית אימות קודם, ושינוי
בגבולות התמונה מבטל crop ישן עד שייווצר מחדש.

## הוספת קורס — המסלול המומלץ

הדוגמאות משתמשות בקורס `80181`; החליפו אותו במספר הקורס הרצוי.

### 1. הורדה וחילוץ לטיוטה

```powershell
npm run ingest:gemini -- 80181 --from 2016 --to 2026 --draft-only
```

הכלי:

1. מחפש את הבחינות במאגר HUJI.
2. מוריד רק קובצי PDF תקינים ומחדש הורדה שנקטעה.
3. שולח כל עמוד ל־Gemini ומבקש תמלול, תיוג וגבולות crop.
4. שומר מטמון לכל בחינה שהושלמה.
5. יוצר `imports/80181/course-80181.json` בלי לשנות את Supabase.

בדיקה מהירה של הטיוטה:

```powershell
node -e "const d=require('./imports/80181/course-80181.json');const q=d.questions;console.log({exams:Object.keys(d.exams).length,questions:q.length,withBoxes:q.filter(x=>x.imagePage&&x.imageBbox).length,uncertain:q.filter(x=>x.unc).length})"
```

מספר `withBoxes` צריך להיות זהה למספר `questions`. שאלות שסומנו `uncertain`
דורשות בדיקה נוספת לפני פרסום.

### 2. Dry run וייבוא

```powershell
npm run import:course -- --data ".\imports\80181\course-80181.json" --pdf-dir ".\imports\80181" --dry-run
```

אם הסיכום תקין:

```powershell
npm run import:course -- --data ".\imports\80181\course-80181.json" --pdf-dir ".\imports\80181"
```

הייבוא מבצע upsert לבחינות ולשאלות, מעלה את קובצי המקור, ומסמן שאלות ישנות
שנעלמו כ־retired. הוא אינו מוחק נתוני משתמשים ואינו מפרסם אוטומטית שאלות חדשות.

### 3. יצירת תמונות מקור בטוחות

הכלי אינו סומך עוד על מלבן ה־AI לצורך חיתוך. הוא מרנדר את **דף המקור המלא**,
מעלה כל דף פעם אחת ומשייך אותו לשאלות שבעמוד. המלבן נשאר רק כסימון כתום שניתן
לגלול אליו; גם אם הוא שגוי, שום נוסחה אינה נחתכת.

אפשר להכין מדגם מקומי של 10 שאלות בלי לשנות את Supabase:

```powershell
npm run crop:questions -- 80181 --pdf-dir ".\imports\80181" --force --limit 10 --prepare-only
Start-Process ".\crop-review\80181\index.html"
```

לאחר שהמדגם נראה תקין, יוצרים מחדש את כל התמונות. `--force` חשוב כאן: הוא
מחליף גם את החיתוכים הישנים והפגומים. כל תמונה חדשה נרשמת כ־`pending` והשאלה
נשארת מוסתרת.

```powershell
npm run crop:questions -- 80181 --pdf-dir ".\imports\80181" --force
Start-Process ".\crop-review\80181\index.html"
```

### 4. בדיקה ואישור

בקובץ `crop-review\80181\index.html` בדקו לכל שאלה שהעמוד שייך למבחן הנכון
ושמספר השאלה מופיע בו. סמנו **תקין**, **דחייה** או **ממתין**, ולחצו על הורדת
קובץ ההחלטות. לאחר מכן מריצים קודם dry run:

```powershell
npm run review:crops -- 80181 --file "$env:USERPROFILE\Downloads\crop-decisions-80181.json" --dry-run
npm run review:crops -- 80181 --file "$env:USERPROFILE\Downloads\crop-decisions-80181.json" --publish
```

הכלי מסרב להחלטה ישנה אם `image_path` השתנה מאז הבדיקה. רק שאלות שסומנו
`approved` מתפרסמות; שאלות שנדחו או נשארו ממתינות נשארות מוסתרות.

בדיקת כיסוי ב־Supabase:

```sql
select *
from public.course_coverage
where course_number = '80181'
order by year, semester, moed;
```

העמודות `imaged` ו־`image_approved` מראות כמה שאלות קיבלו תמונה וכמה עברו
בדיקה אנושית. אין לפרסם שאלות ישירות ב־SQL; שער הפרסום במסד דורש אישור של
התמונה המדויקת.

## מחלצים חלופיים

OpenAI:

```powershell
npm run ingest:course -- 80181 --all --draft-only
```

Ollama מקומי, ללא API חיצוני:

```powershell
npm run ingest:local -- 80181 --draft-only
```

המסלול המקומי דורש מודל ראייה, לדוגמה `qwen3-vl:8b`. הקובץ `fetch_range.py`
נשמר לתאימות עם התהליך הישן, אך אינו המסלול המומלץ לייבוא image-first חדש.

## פקודות שימושיות

| פקודה | תפקיד |
|---|---|
| `npm run dev` | שרת פיתוח מקומי |
| `npm run build` | build לפרודקשן |
| `npm run check` | TypeScript ולאחריו build מלא |
| `npm test` | בדיקות יחידה |
| `npm run fetch:exams -- COURSE` | הורדת מבחנים עם manifest ו־backoff |
| `npm run ingest:gemini -- COURSE` | הורדה וחילוץ באמצעות Gemini |
| `npm run ingest:course -- COURSE` | חילוץ באמצעות OpenAI |
| `npm run ingest:local -- COURSE` | חילוץ באמצעות Ollama |
| `npm run import:course -- ...` | dry run או ייבוא ל־Supabase |
| `npm run crop:questions -- COURSE` | יצירה והעלאה של דפי מקור מלאים במצב pending |
| `npm run review:crops -- COURSE --file PATH` | אימות החלטות בדיקה ופרסום מאושר בלבד |

## בדיקות לפני commit או deploy

```powershell
npm test
npm run check
```

`npm run check` מריץ TypeScript ללא emit ולאחריו production build מלא של Next.js.

## פריסה

ב־Vercel חברו את repository והגדירו לפחות:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

`SUPABASE_SERVICE_ROLE_KEY` נדרש ב־Vercel רק לקוד השרת שחותם קישורים ל־bucket הפרטי. הגדירו אותו כ־Secret רגיל ולעולם לא בשם שמתחיל ב־`NEXT_PUBLIC_`. אין להוסיף ל־Vercel את `GEMINI_API_KEY`; כלי החילוץ רץ רק במחשב של בעל האתר.

## עקרונות בטיחות הנתונים

- `questions.is_published` הוא `false` כברירת מחדל.
- ייבוא חוזר מעדכן ומסמן שאלות חסרות כ־retired; הוא אינו מוחק אותן.
- מזהי בחינות ושאלות מתעדכנים עם `ON UPDATE CASCADE`.
- `source_hash` מונע העלאה כפולה של אותו PDF תחת שמות שונים.
- זהות מודפסת ייחודית מונעת כפילות של אותה שאלה או תת־שאלה.
- שינוי בתמלול מנקה סטטוס אימות קודם.
- קורס image-first דורש תמונת מקור קיימת וגם `crop_review_status = 'approved'` לפני פרסום.
- החלפת תמונה, עמוד או bbox מבטלת את האישור ומסתירה את השאלה אוטומטית.
- החלטת בדיקה כוללת את נתיב התמונה המדויק, ולכן אי אפשר לאשר בטעות תמונה שהוחלפה.
- כשל בחתימת URL מחזיר את כרטיס השאלה ל־fallback טקסטואלי מסומן, במקום להעלים אותו.

## מבנה הפרויקט

```text
app/                         Next.js pages and signed-image API
components/                  Search, filters, cards, auth and hints
data/                        Local fallback course data
lib/                         Data adapters, search and extraction helpers
scripts/ingest-course.mjs    HUJI → AI → reviewed draft
scripts/import-course.mjs    Safe Supabase upsert and retirement
scripts/crop-questions.mjs   Safe full-page rendering and pending upload
scripts/review-crops.mjs      Exact-image review and controlled publication
scripts/fetch-exams.mjs      Resumable HUJI downloader
supabase/migrations/         Schema, RLS and integrity rules
test/                        Extraction and bounding-box tests
```

## זכויות יוצרים

השאלות נכתבו בידי סגלי הקורסים והזכויות עליהן שמורות לבעלי הזכויות
ולאוניברסיטה העברית. לפני פרסום רחב של סריקות, יש לוודא שהשימוש תואם להרשאות
ולמדיניות האוניברסיטה.
