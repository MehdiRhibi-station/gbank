# ייבוא קורסים

[חזרה ל־README](../README.md)

כל כלי הייבוא רצים רק במחשב של בעל האתר. אין באתר כפתור או API שמאפשר למבקרים
להפעיל אותם. כולם דורשים את `SUPABASE_SERVICE_ROLE_KEY` בקובץ `.env.local`; אין
להוסיף אותו ל־GitHub או ל־Vercel.

| מסלול | פקודה | חילוץ השאלות | מה נשמר בדרך | מתאים כש… |
| --- | --- | --- | --- | --- |
| [Python + Ollama](#python--ollama-ישירות-לsupabase) | `python fetch_range.py 80131` | Ollama מקומי, חינם | רק קובצי PDF; כל מבחן עולה ישר למסד | רוצים את הדרך הקצרה ביותר |
| [Node + OpenAI](#node--openai-npm-run-ingestcourse) | `npm run ingest:course` | OpenAI, בתשלום, מדויק יותר | טיוטת JSON לבדיקה לפני אישור | חשוב דיוק בעברית ובנוסחאות |
| [Node + Ollama](#node--ollama-npm-run-ingestlocal) | `npm run ingest:local` | Ollama מקומי, חינם | טיוטת JSON בתיקיית Google Drive | רוצים לבדוק טיוטה בלי לשלם |
| [JSON קיים](#ייבוא-מקובץ-json-קיים) | `npm run import:course` | אין, הקובץ כבר מוכן | אפשרות להעביר או למחוק מקור אחרי הצלחה | כבר יש `course-XXXXX.json` |

## Python + Ollama ישירות ל־Supabase

המסלול הקצר ביותר אינו יוצר `data/course-XXXXX.json` ואינו מפעיל סקריפט Node.
הוא מחפש את הבחינות, מוריד PDF, מחלץ שאלות עם Ollama המקומי ומעלה כל מבחן
שהושלם ישירות למסד ול־Storage:

```bat
cd /d "C:\path\to\gbank-main"
python -m pip install -r requirements-ingest.txt
python fetch_range.py 80131
```

לפני ההרצה יש להגדיר ב־`.env.local` את `NEXT_PUBLIC_SUPABASE_URL`, את
`SUPABASE_SERVICE_ROLE_KEY`, ואת הגדרות Ollama המופיעות בהמשך. המפתח בעל הרשאות
מלאות ונשאר רק במחשב של בעל האתר. אין להוסיף אותו ל־GitHub או ל־Vercel.

הפקודה מייבאת את כל הבחינות מ־2016 ועד השנה הנוכחית. היא בטוחה להרצה חוזרת:
מבחן שכבר מכיל שאלות מדולג, מזהים קיימים נשמרים כדי לא לפגוע ברמזים ובהתקדמות,
וכשל באמצע אינו מוחק מבחנים שכבר הושלמו. אפשרויות שימושיות:

```bat
rem בדיקה בלבד, בלי הורדה ובלי שינוי במסד
python fetch_range.py 80131 --dry-run

rem רק הבחינה החדשה ביותר
python fetch_range.py 80131 --latest

rem חילוץ מחדש של מבחנים שכבר קיימים
python fetch_range.py 80131 --force-extract

rem המשך למבחן הבא גם אם מבחן אחד נכשל
python fetch_range.py 80131 --keep-going
```

קובצי ה־PDF נשמרים כברירת מחדל ב־`imports\COURSE_NUMBER` כדי שאפשר יהיה לחדש
הורדה שנקטעה. להקטנת נפח אפשר להוסיף `--delete-pdfs-after-upload`; הקובץ המקומי
יימחק רק לאחר שה־PDF והשאלות של אותו מבחן נשמרו בהצלחה. התהליך אינו שומר קובץ
JSON ביניים.

## Node + OpenAI: `npm run ingest:course`

הפקודה `npm run ingest:course` מחפשת במאגר הבחינות הרשמי של האוניברסיטה, מורידה רק
את קובצי ה־PDF שהמאגר החזיר, מחלצת מהם שאלות לטיוטה בעזרת OpenAI, ולאחר אישור מעלה
את הקורס ל־Supabase.

לפני ההרצה, העתיקו את `.env.local.example` לקובץ `.env.local` והוסיפו:

- `OPENAI_API_KEY` לחילוץ השאלות מה־PDF.
- `NEXT_PUBLIC_SUPABASE_URL` ו־`SUPABASE_SERVICE_ROLE_KEY` להעלאה למסד הנתונים.

ב־Windows, מתוך תיקיית `gbank-main`:

```bat
cd /d "C:\path\to\gbank-main"
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

## Node + Ollama: `npm run ingest:local`

אפשר לבצע את חילוץ השאלות בחינם על המחשב באמצעות Ollama ומודל ראייה מקומי. אין
צורך ב־`OPENAI_API_KEY`, וקובצי הבחינות אינם נשלחים לשירות AI חיצוני. עדיין צריך
חיבור לאינטרנט כדי להוריד מבחנים מ־HUJI ולהעלות את התוצאה ל־Supabase.

התקנה חד־פעמית ב־Windows:

1. התקינו ופתחו את [Ollama](https://ollama.com/download/windows).
2. בקובץ `.env.local` הגדירו את תיקיית Google Drive המקומית:

```env
GBANK_DRIVE_DIR=C:\path\to\GBank Imports
OLLAMA_MODEL=qwen3-vl:8b
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_CONTEXT_LENGTH=32768
```

החליפו את נתיב ה־Drive בנתיב שקיים אצלכם. לאחר מכן מריצים:

```bat
npm run ingest:local
```

מקלידים רק את מספר הקורס. הכלי מחפש את כל הבחינות מ־2016 ועד השנה הנוכחית,
מוריד אותן אל `GBANK_DRIVE_DIR\COURSE_NUMBER`, מרנדר את דפי ה־PDF מקומית, מחלץ
טיוטת שאלות ושומר כל מבחן שהושלם במטמון. אם המודל המקומי עדיין לא קיים, הכלי
מציע להוריד אותו אוטומטית; `qwen3-vl:8b` הוא קובץ של כ־6 GB.

בסיום בודקים את `course-COURSE_NUMBER.json` ומאשרים את ההעלאה ל־Supabase. לחיצה
חוזרת על אותה פקודה ממשיכה מהמקום שבו נעצרה ואינה מחלצת מחדש מבחנים שכבר נשמרו.
חילוץ מקומי עלול לקחת שעות, והדיוק בעברית ובנוסחאות נמוך יותר ממודל ענן, ולכן
חובה לעבור על הטיוטה לפני האישור. במחשב חלש אפשר להשתמש ב־`qwen3-vl:4b`, אך
הדיוק יהיה נמוך יותר.

## ייבוא מקובץ JSON קיים

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
npm run import:course -- --data "C:/path/to/GBank Imports/80131/course-80131.json" --pdf-dir "C:/path/to/GBank Imports/80131" --dry-run
```

לאחר שבדקתם את הרשימה, ייבאו והשאירו את המקור ב־Drive:

```bash
npm run import:course -- --data "C:/path/to/GBank Imports/80131/course-80131.json" --pdf-dir "C:/path/to/GBank Imports/80131"
```

האפשרות הבטוחה ביותר לניקוי היא להעביר את הקבצים לארכיון לאחר הצלחה:

```bash
npm run import:course -- --data "C:/path/to/GBank Imports/80131/course-80131.json" --pdf-dir "C:/path/to/GBank Imports/80131" --archive-after-upload "C:/path/to/GBank Archive/80131"
```

אם אתם בטוחים שאינכם צריכים עותק נוסף, אפשר למחוק רק את קובצי ה־PDF שהועלו בהצלחה:

```bash
npm run import:course -- --data "C:/path/to/GBank Imports/80131/course-80131.json" --pdf-dir "C:/path/to/GBank Imports/80131" --delete-after-upload
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
