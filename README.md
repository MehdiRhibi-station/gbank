# גיבנק

בנק שאלות למבחני האוניברסיטה העברית: חיפוש לפי נושא ואופי השאלה, רמזים מהקהילה,
שמירת התקדמות וצפייה בסריקות המקור. הפרויקט מגיע עם 117 שאלות מ-18 מבחנים בשני
קורסים: אינפי 1 ותורת ההסתברות 1.

## מה השתנה בגרסה הזאת

- ממשק Next.js מלא בעברית וב־RTL, בצבעי כחול כהה, כתום, שמנת ולבנדר.
- Supabase עבור משתמשים, מסד נתונים, רמזים, לייקים, התקדמות וקובצי PDF.
- מצב מקומי מובנה: האתר עובד מיד עם 117 השאלות גם לפני חיבור Supabase.
- כלי ייבוא רב־קורסי שמעלה נתונים וקובצי PDF, ויכול להעביר או למחוק את קובצי המקור
  רק לאחר שהייבוא כולו הצליח.
- Row Level Security במסד הנתונים, וקובצי PDF ב־bucket פרטי עם קישורים זמניים.
- בדיקת build אוטומטית ב־GitHub Actions.

## הרצה מקומית

דרישות: Node.js 22 ומעלה.

```bash
npm install
npm run dev
```

פתחו [http://localhost:3000](http://localhost:3000). בלי קובץ `.env.local`, האתר פועל
במצב מקומי: חיפוש, סינון, כל השאלות ושמירת התקדמות בדפדפן עובדים. התחברות, רמזים
משותפים וסנכרון בין מכשירים דורשים Supabase.

בדיקת הפרויקט לפני העלאה:

```bash
npm run check
```

## חיבור Supabase

1. צרו פרויקט חדש ב־Supabase.
2. פתחו את SQL Editor והריצו את הקובץ
   `supabase/migrations/202609210001_initial_gbank.sql`.
3. העתיקו `.env.local.example` אל `.env.local` ומלאו את שלושת הערכים.
4. ב־Supabase Auth הגדירו את כתובת האתר המקומית ואת כתובת Vercel כ־Redirect URLs.
5. ייבאו את הקורס הראשון באמצעות הפקודה בסעיף הבא.

ה־`SUPABASE_SERVICE_ROLE_KEY` מיועד רק לכלי הייבוא המקומי. אסור להוסיף אותו ל־GitHub,
ל־Vercel או למשתנה שמתחיל ב־`NEXT_PUBLIC_`.

## הוספת קורס אוטומטית לפי מספר קורס

הפקודה הפרטית החדשה מחפשת במאגר הבחינות הרשמי של האוניברסיטה, מורידה רק את קובצי
ה־PDF שהמאגר החזיר, מחלצת מהם שאלות לטיוטה, ולאחר אישור מעלה את הקורס ל־Supabase.
היא רצה רק במחשב של בעל האתר; אין באתר כפתור או API שמאפשר למבקרים להפעיל אותה.

לפני ההרצה, העתיקו את `.env.local.example` לקובץ `.env.local` והוסיפו:

- `OPENAI_API_KEY` לחילוץ השאלות מה־PDF.
- `NEXT_PUBLIC_SUPABASE_URL` ו־`SUPABASE_SERVICE_ROLE_KEY` להעלאה למסד הנתונים.

ב־Windows, מתוך תיקיית `gbank-main`:

```bat
cd /d "C:\Users\mahde\Downloads\gbank-main"
npm install
copy .env.local.example .env.local
notepad .env.local
npm run ingest:course
```

הסקריפט יבקש מספר קורס וישאל אם להוריד את כל הבחינות משנת 2016 או רק את הבחינה
החדשה ביותר. אפשר גם להריץ ישירות:

```bat
rem כל הבחינות משנת 2016 ועד השנה הנוכחית
npm run ingest:course -- 80420 --all

rem רק הבחינה החדשה ביותר
npm run ingest:course -- 80420 --latest
```

הקבצים נשמרים ב־`imports\80420`, כולל `course-80420.json` שאפשר לבדוק ולערוך לפני
האישור הסופי. ההרצה ניתנת לחידוש: קובצי PDF תקינים, חילוצים קיימים ושאלות שכבר
נבדקו אינם נוצרים מחדש. כדי להוריד בלבד בלי חילוץ ובלי שינוי במסד:

```bat
npm run ingest:course -- 80420 --all --download-only
```

כדי ליצור טיוטה ולעצור תמיד לפני Supabase:

```bat
npm run ingest:course -- 80420 --all --draft-only
notepad imports\80420\course-80420.json
```

לאחר הבדיקה, הריצו שוב את הפקודה הרגילה ואשרו את הייבוא. `--yes` מיועד להרצה
אוטומטית רק לאחר שסומכים על התהליך. `--force-extract` מחלץ מחדש את הבחינות
שנבחרו. הסקריפט אינו מוחק קבצים כברירת מחדל.

## הדרך החכמה להוסיף קורסים רבים

שמרו לכל קורס תיקייה זמנית ב־Google Drive המקומי:

```text
GBank Imports/
└── 80131/
    ├── course-80131.json
    ├── 80131_2025_1_1_1.pdf
    └── 80131_2025_1_2_1.pdf
```

ראשית בצעו בדיקה שלא משנה דבר:

```bash
npm run import:course -- --data "C:/Google Drive/GBank Imports/80131/course-80131.json" --pdf-dir "C:/Google Drive/GBank Imports/80131" --dry-run
```

לאחר שבדקתם את הרשימה, ייבאו והשאירו את המקור ב־Drive:

```bash
npm run import:course -- --data "C:/Google Drive/GBank Imports/80131/course-80131.json" --pdf-dir "C:/Google Drive/GBank Imports/80131"
```

האפשרות הבטוחה ביותר לניקוי היא להעביר את הקבצים לארכיון לאחר הצלחה:

```bash
npm run import:course -- --data "C:/Google Drive/GBank Imports/80131/course-80131.json" --pdf-dir "C:/Google Drive/GBank Imports/80131" --archive-after-upload "C:/Google Drive/GBank Archive/80131"
```

אם אתם בטוחים שאינכם צריכים עותק נוסף, אפשר למחוק רק את קובצי ה־PDF שהועלו בהצלחה:

```bash
npm run import:course -- --data "C:/Google Drive/GBank Imports/80131/course-80131.json" --pdf-dir "C:/Google Drive/GBank Imports/80131" --delete-after-upload
```

הסקריפט לא מוחק דבר כברירת מחדל. אם העלאה או כתיבה למסד הנתונים נכשלת, שלב הניקוי
לא מתבצע. אפשר להריץ את אותה פקודה שוב; הייבוא משתמש ב־upsert ולא יוצר כפילויות.

## מבנה JSON לקורס

הקובץ `data/course-80131.json` הוא דוגמה מלאה. המבנה הראשי הוא:

```json
{
  "course": {
    "number": "80131",
    "name": "חשבון אינפיניטסימלי 1",
    "aliases": ["אינפי 1", "חדו״א 1"],
    "department": "החוג למתמטיקה, האוניברסיטה העברית"
  },
  "exams": {},
  "topics": {},
  "natures": {},
  "questions": []
}
```

כל שאלה מפנה למפתח מבחן בעזרת `ex`. כלי הייבוא מוסיף אוטומטית את מספר הקורס
למזהים במסד הנתונים, ולכן אפשר להשתמש במזהים קצרים דומים בקורסים שונים.

## העלאה ל־GitHub בלי `gh`

צרו repository פרטי בשם `gbank` באתר GitHub, בלי README אוטומטי, ואז מתוך תיקיית הפרויקט:

```bash
git init
git add .
git commit -m "Build GBank full-stack question bank"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/gbank.git
git push -u origin main
```

אין צורך להתקין את GitHub CLI. פקודת `git` הרגילה מספיקה.

## העלאה ל־Vercel

1. ב־Vercel בחרו **Add New → Project** וחברו את repository `gbank`.
2. הוסיפו רק `NEXT_PUBLIC_SUPABASE_URL` ו־`NEXT_PUBLIC_SUPABASE_ANON_KEY` ב־Environment Variables.
3. בצעו Deploy.
4. הוסיפו את כתובת Vercel ל־Redirect URLs של Supabase Auth.

כל push חדש ל־`main` יוצר deploy חדש. מפתח ה־service role נשאר רק במחשב שמבצע את הייבוא.

## מבנה הפרויקט

```text
app/                    Next.js pages and visual design
components/             Search, filters, cards, hints and authentication UI
data/                   Built-in fallback data for courses 80131 and 80420
lib/                    Data adapters, browser database client and local state
scripts/import-course.mjs
scripts/ingest-course.mjs
supabase/migrations/    Database schema, policies and RPC functions
legacy/                 The original one-file prototype and extraction tools
```

## זכויות יוצרים

השאלות נכתבו בידי סגלי הקורסים והזכויות עליהן שמורות לאוניברסיטה העברית. לפני
פרסום רחב של סריקות מלאות, ודאו שקיבלתם הרשאה מתאימה. גיבנק מציג רמזים ולא פתרונות מלאים.
