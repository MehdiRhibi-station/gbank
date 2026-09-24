"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon, UploadIcon } from "@/components/icons";
import { QuestionCard } from "@/components/question-card";
import { getSeedBankData, loadRemoteBankData } from "@/lib/bank-data";
import { readLocalProgress, writeLocalProgress } from "@/lib/local-progress";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase-browser";
import type {
  BackendState,
  BankData,
  Course,
  Hint,
  Progress,
  Question,
  QuestionStats,
} from "@/lib/types";

const EMPTY_STATS: QuestionStats = { likes: 0, views: 0, solves: 0 };
const EMPTY_PROGRESS: Progress = { liked: false, solved: false };

type InfoKey = "about" | "how" | null;

interface Filters {
  query: string;
  topic: string;
  nature: string;
  year: string;
  semester: string;
  moed: string;
  sort: "new" | "old" | "likes" | "views" | "solves";
  hideSolved: boolean;
}

const initialFilters: Filters = {
  query: "",
  topic: "",
  nature: "",
  year: "",
  semester: "",
  moed: "",
  sort: "new",
  hideSolved: false,
};

const infoCopy = {
  about: {
    title: "Q&A",
    paragraphs: [
      ["למה רמזים ולא פתרונות מלאים?", "רמז משאיר את העבודה אצלכם. המטרה היא שתבנו את הפתרון בעצמכם ותזכרו את הדרך במבחן."],
      ["מאיפה השאלות?", "מבחנים רשמיים של האוניברסיטה העברית. הזכויות על נוסחי השאלות נשארות בידי האוניברסיטה וסגלי הקורסים."],
      ["מי יכול להוסיף תוכן?", "קורסים ומבחנים נוספים נכנסים דרך תהליך ייבוא מסודר, כדי למנוע כפילויות ולוודא שהנתונים נבדקו."],
    ],
  },
  how: {
    title: "איך זה עובד",
    paragraphs: [
      ["1. בוחרים קורס", "חפשו לפי שם או מספר קורס ונכנסים לבנק השאלות שלו."],
      ["2. מסננים", "בחרו נושא, אופי שאלה, שנה, סמסטר ומועד — או חפשו מילים מתוך השאלה."],
      ["3. מנסים ורק אז פותחים רמז", "אפשר לסמן שסיימתם, לשמור שאלות שעזרו לכם ולהסתיר שאלות שכבר פתרתם."],
      ["4. מחזירים לקהילה", "משתמשים מחוברים יכולים לפרסם רמזים קצרים ולהצביע לרמזים מועילים."],
    ],
  },
};

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("he");
}

export function BankApp() {
  const supabase = getSupabaseBrowserClient();
  const [bank, setBank] = useState<BankData>(() => getSeedBankData());
  const [backend, setBackend] = useState<BackendState>(
    isSupabaseConfigured() ? "connecting" : "local",
  );
  const [user, setUser] = useState<User | null>(null);
  const [courseSearch, setCourseSearch] = useState("");
  const [selectedCourseNumber, setSelectedCourseNumber] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [stats, setStats] = useState<Record<string, QuestionStats>>({});
  const [hints, setHints] = useState<Record<string, Hint[]>>({});
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [localPdfs, setLocalPdfs] = useState<Record<string, string>>({});
  const localPdfUrls = useRef<Set<string>>(new Set());
  const pdfInput = useRef<HTMLInputElement>(null);
  const [infoOpen, setInfoOpen] = useState<InfoKey>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [toast, setToast] = useState("");

  const refreshPublicData = useCallback(async () => {
    if (!supabase) return;
    const [statsResult, hintsResult] = await Promise.all([
      supabase.from("question_stats").select("question_id,likes,views,solves").limit(10000),
      supabase
        .from("hints")
        .select("id,question_id,text,votes_count,created_at")
        .eq("status", "published")
        .order("votes_count", { ascending: false })
        .limit(10000),
    ]);

    if (!statsResult.error && statsResult.data) {
      setStats(
        Object.fromEntries(
          statsResult.data.map((row) => [
            row.question_id,
            { likes: row.likes ?? 0, views: row.views ?? 0, solves: row.solves ?? 0 },
          ]),
        ),
      );
    }

    if (!hintsResult.error && hintsResult.data) {
      const grouped: Record<string, Hint[]> = {};
      for (const row of hintsResult.data) {
        const hint: Hint = {
          id: row.id,
          questionId: row.question_id,
          text: row.text,
          votes: row.votes_count ?? 0,
          createdAt: row.created_at,
        };
        (grouped[hint.questionId] ??= []).push(hint);
      }
      setHints(grouped);
    }
  }, [supabase]);

  const loadUserProgress = useCallback(
    async (userId: string) => {
      if (!supabase) return;
      const result = await supabase
        .from("question_progress")
        .select("question_id,liked,solved")
        .eq("user_id", userId)
        .limit(10000);
      if (!result.error && result.data) {
        setProgress(
          Object.fromEntries(
            result.data.map((row) => [
              row.question_id,
              { liked: Boolean(row.liked), solved: Boolean(row.solved) },
            ]),
          ),
        );
      }
    },
    [supabase],
  );

  useEffect(() => {
    setProgress(readLocalProgress());
    if (!supabase) return;

    let active = true;
    void (async () => {
      const [remote, authResult] = await Promise.all([
        loadRemoteBankData(),
        supabase.auth.getUser(),
        refreshPublicData(),
      ]);
      if (!active) return;
      if (remote) {
        setBank(remote);
        setBackend("connected");
      } else {
        setBackend("unavailable");
      }
      const currentUser = authResult.data.user;
      setUser(currentUser);
      if (currentUser) await loadUserProgress(currentUser.id);
    })();

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      if (currentUser) void loadUserProgress(currentUser.id);
      else setProgress(readLocalProgress());
    });

    const realtime = supabase
      .channel("gbank-community")
      .on("postgres_changes", { event: "*", schema: "public", table: "question_stats" }, () => {
        void refreshPublicData();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "hints" }, () => {
        void refreshPublicData();
      })
      .subscribe();

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
      void supabase.removeChannel(realtime);
    };
  }, [loadUserProgress, refreshPublicData, supabase]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(
    () => () => {
      for (const url of localPdfUrls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const selectedCourse = useMemo(
    () => bank.courses.find((course) => course.number === selectedCourseNumber) ?? null,
    [bank.courses, selectedCourseNumber],
  );

  const courseQuestions = useMemo(() => {
    if (!selectedCourse) return [];
    return bank.questions.filter(
      (question) => bank.exams[question.examId]?.courseNumber === selectedCourse.number,
    );
  }, [bank.exams, bank.questions, selectedCourse]);

  const visibleQuestions = useMemo(() => {
    if (!selectedCourse) return [];
    const query = normalize(filters.query);
    const result = courseQuestions.filter((question) => {
      const exam = bank.exams[question.examId];
      if (!exam) return false;
      if (filters.topic && !question.topics.includes(filters.topic)) return false;
      if (filters.nature && question.nature !== filters.nature) return false;
      if (filters.year && String(exam.year) !== filters.year) return false;
      if (filters.semester && exam.semester !== filters.semester) return false;
      if (filters.moed && exam.moed !== filters.moed) return false;
      if (filters.hideSolved && progress[question.id]?.solved) return false;
      if (query) {
        const searchable = normalize(
          [
            question.title,
            question.statement,
            question.context ?? "",
            selectedCourse.natures[question.nature] ?? question.nature,
            ...question.topics.map((topic) => selectedCourse.topics[topic] ?? topic),
            exam.instructors,
            ...(hints[question.id] ?? []).map((hint) => hint.text),
          ].join(" "),
        );
        if (!searchable.includes(query)) return false;
      }
      return true;
    });

    const statKey = filters.sort === "likes" || filters.sort === "views" || filters.sort === "solves"
      ? filters.sort
      : null;
    result.sort((left, right) => {
      if (statKey) {
        const delta = (stats[right.id]?.[statKey] ?? 0) - (stats[left.id]?.[statKey] ?? 0);
        if (delta) return delta;
      }
      const examDelta = bank.exams[right.examId].ordinal - bank.exams[left.examId].ordinal;
      const chronological = filters.sort === "old" ? -examDelta : examDelta;
      return chronological || left.ordinal - right.ordinal;
    });
    return result;
  }, [bank.exams, courseQuestions, filters, hints, progress, selectedCourse, stats]);

  const years = useMemo(
    () =>
      [...new Set(courseQuestions.map((question) => bank.exams[question.examId]?.year).filter(Boolean))]
        .sort((left, right) => Number(right) - Number(left)) as number[],
    [bank.exams, courseQuestions],
  );

  const courseHits = useMemo(() => {
    const query = normalize(courseSearch);
    return bank.courses.filter((course) =>
      normalize([course.number, course.name, ...course.aliases].join(" ")).includes(query),
    );
  }, [bank.courses, courseSearch]);

  function courseSummary(course: Course) {
    const questions = bank.questions.filter(
      (question) => bank.exams[question.examId]?.courseNumber === course.number,
    );
    const examIds = [...new Set(questions.map((question) => question.examId))];
    const courseYears = examIds.map((id) => bank.exams[id]?.year).filter(Boolean) as number[];
    return {
      questions: questions.length,
      exams: examIds.length,
      years: courseYears.length ? `${Math.min(...courseYears)}–${Math.max(...courseYears)}` : "",
    };
  }

  function openCourse(courseNumber: string) {
    setSelectedCourseNumber(courseNumber);
    setFilters(initialFilters);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goHome() {
    setSelectedCourseNumber(null);
    setCourseSearch("");
    setFilters(initialFilters);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function updateProgress(questionId: string, field: keyof Progress) {
    const previous = progress[questionId] ?? EMPTY_PROGRESS;
    const next = { ...previous, [field]: !previous[field] };
    const nextProgress = { ...progress, [questionId]: next };
    setProgress(nextProgress);

    if (!user || !supabase) {
      writeLocalProgress(nextProgress);
      setToast("הסימון נשמר במכשיר הזה. התחברו כדי לסנכרן בין מכשירים.");
      return;
    }

    setStats((current) => {
      const questionStats = current[questionId] ?? EMPTY_STATS;
      const key = field === "liked" ? "likes" : "solves";
      return {
        ...current,
        [questionId]: {
          ...questionStats,
          [key]: Math.max(0, questionStats[key] + (next[field] ? 1 : -1)),
        },
      };
    });

    const result = await supabase.from("question_progress").upsert(
      {
        user_id: user.id,
        question_id: questionId,
        liked: next.liked,
        solved: next.solved,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,question_id" },
    );
    if (result.error) {
      setProgress(progress);
      setToast("לא הצלחנו לשמור את הסימון. נסו שוב.");
    }
  }

  async function recordView(questionId: string) {
    setStats((current) => ({
      ...current,
      [questionId]: {
        ...(current[questionId] ?? EMPTY_STATS),
        views: (current[questionId]?.views ?? 0) + 1,
      },
    }));
    if (supabase && backend === "connected") {
      await supabase.rpc("increment_question_view", { p_question_id: questionId });
    }
  }

  async function postHint(questionId: string, text: string) {
    if (!user || !supabase) {
      setAuthOpen(true);
      setToast("כדי לפרסם רמז צריך להתחבר.");
      return false;
    }
    const result = await supabase.from("hints").insert({
      question_id: questionId,
      user_id: user.id,
      text,
      status: "published",
    });
    if (result.error) {
      setToast("הרמז לא נשמר. נסו שוב.");
      return false;
    }
    await refreshPublicData();
    setToast("הרמז פורסם — תודה שעזרתם לסטודנטים הבאים.");
    return true;
  }

  async function voteHint(hintId: string) {
    if (!user || !supabase) {
      setAuthOpen(true);
      setToast("כדי להצביע לרמז צריך להתחבר.");
      return;
    }
    const result = await supabase.rpc("toggle_hint_vote", { p_hint_id: hintId });
    if (result.error) setToast("לא הצלחנו לשמור את ההצבעה.");
    else await refreshPublicData();
  }

  async function openSource(question: Question) {
    const exam = bank.exams[question.examId];
    const localUrl = localPdfs[exam.id];
    if (localUrl) {
      window.open(localUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (exam.storagePath && supabase) {
      const popup = window.open("", "_blank");
      const result = await supabase.storage.from("exam-files").createSignedUrl(exam.storagePath, 90);
      if (result.data?.signedUrl) {
        if (popup) popup.location.href = result.data.signedUrl;
        else window.location.href = result.data.signedUrl;
        return;
      }
      popup?.close();
    }
    if (/^\d+_\d{4}_[123]_[123]_\d+\.pdf$/.test(exam.sourceFilename)) {
      const sourceUrl = `https://www4.huji.ac.il/exams/${encodeURIComponent(exam.sourceFilename)}`;
      window.open(sourceUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setToast(`כדי לראות את הסריקה, טענו את הקובץ ${exam.sourceFilename} מהמחשב.`);
  }

  function handlePdfFiles(files: FileList | null) {
    if (!files?.length) return;
    const next = { ...localPdfs };
    let matched = 0;
    for (const file of Array.from(files)) {
      const exam = Object.values(bank.exams).find((candidate) => candidate.sourceFilename === file.name);
      if (!exam) continue;
      const oldUrl = next[exam.id];
      if (oldUrl) {
        URL.revokeObjectURL(oldUrl);
        localPdfUrls.current.delete(oldUrl);
      }
      const url = URL.createObjectURL(file);
      localPdfUrls.current.add(url);
      next[exam.id] = url;
      matched += 1;
    }
    setLocalPdfs(next);
    setToast(
      matched
        ? `${matched} קובצי PDF זוהו. כפתור ״דף המקור״ יפתח אותם מהמחשב.`
        : "לא זוהה קובץ מתאים. ודאו ששמות הקבצים נשארו כפי שהורדו.",
    );
    if (pdfInput.current) pdfInput.current.value = "";
  }

  async function sendMagicLink() {
    if (!supabase) {
      setAuthMessage("האתר עדיין במצב מקומי. לאחר חיבור Supabase הכניסה תופעל כאן.");
      return;
    }
    if (!email.trim()) return;
    setAuthBusy(true);
    const result = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setAuthMessage(
      result.error ? "לא הצלחנו לשלוח קישור. בדקו את הכתובת ונסו שוב." : "שלחנו לכם קישור כניסה למייל.",
    );
    setAuthBusy(false);
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    setAuthOpen(false);
    setToast("התנתקתם מהחשבון.");
  }

  const distinctExamCount = new Set(visibleQuestions.map((question) => question.examId)).size;
  const totalSummary = bank.courses.reduce(
    (summary, course) => {
      const current = courseSummary(course);
      summary.questions += current.questions;
      summary.exams += current.exams;
      return summary;
    },
    { questions: 0, exams: 0 },
  );

  return (
    <div className="site-shell">
      <header className="masthead">
        <div className="masthead-inner">
          <button className="brand" type="button" onClick={goHome} aria-label="דף הבית של גיבנק">
            <span className="brand-mark">ג׳</span>
            <span>
              <strong>גיבנק</strong>
              <small>שאלות · רמזים · התקדמות</small>
            </span>
          </button>

          <nav aria-label="ניווט ראשי">
            <button className={!infoOpen ? "selected" : ""} type="button" onClick={goHome}>
              בית
            </button>
            <button type="button" onClick={() => setInfoOpen("about")}>Q&amp;A</button>
            <button type="button" onClick={() => setInfoOpen("how")}>איך זה עובד</button>
          </nav>

          <div className="auth-actions">
            <button className="button button-quiet" type="button" onClick={() => setAuthOpen(true)}>
              {user ? user.email?.split("@")[0] : "כניסה"}
            </button>
            {!user && (
              <button className="button button-navy" type="button" onClick={() => setAuthOpen(true)}>
                הרשמה
              </button>
            )}
          </div>
        </div>
      </header>

      {!selectedCourse ? (
        <main>
          <section className="course-hero">
            <div className="hero-orb orb-one" />
            <div className="hero-orb orb-two" />
            <div className="container hero-content">
              <span className="eyebrow orange">בנק תרגול חכם לסטודנטים</span>
              <h1>פחות זמן לחפש.<br />יותר זמן לפתור.</h1>
              <p>
                כל שאלות המבחנים במקום אחד — מסודרות לפי נושא, סוג שאלה, שנה ומועד.
                פותחים רמז רק כשבאמת נתקעים.
              </p>
              <div className="course-search">
                <SearchIcon />
                <input
                  type="search"
                  value={courseSearch}
                  onChange={(event) => setCourseSearch(event.target.value)}
                  placeholder="חפשו קורס לפי שם או מספר — למשל 80131"
                  aria-label="חיפוש קורס"
                />
              </div>
              <div className="hero-stats" aria-label="נתוני המאגר">
                <span><strong>{totalSummary.questions}</strong> שאלות</span>
                <span><strong>{totalSummary.exams}</strong> מבחנים</span>
                <span><strong>{bank.courses.length}</strong> קורסים</span>
              </div>
            </div>
          </section>

          <section className="container course-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">הקורסים במאגר</span>
                <h2>בחרו מאיפה מתחילים</h2>
              </div>
              <span className={`backend-badge state-${backend}`}>
                {backend === "connected"
                  ? "המאגר מחובר"
                  : backend === "connecting"
                    ? "מתחבר למאגר…"
                    : "תצוגה מקומית"}
              </span>
            </div>

            <div className="course-grid">
              {courseHits.map((course) => {
                const summary = courseSummary(course);
                return (
                  <button className="course-card" type="button" key={course.number} onClick={() => openCourse(course.number)}>
                    <span className="course-number">{course.number}</span>
                    <h3>{course.name}</h3>
                    <p>{course.department}</p>
                    <div className="course-card-stats">
                      <span>{summary.questions} שאלות</span>
                      <span>{summary.exams} מבחנים</span>
                      <span>{summary.years}</span>
                    </div>
                    <span className="course-enter">כניסה למאגר <b>←</b></span>
                  </button>
                );
              })}
              {courseHits.length === 0 && (
                <div className="empty-state">
                  <strong>הקורס הזה עדיין לא במאגר</strong>
                  <p>אפשר להוסיף אותו דרך תהליך הייבוא המסודר של גיבנק.</p>
                </div>
              )}
            </div>
          </section>
        </main>
      ) : (
        <main>
          <section className="course-strip">
            <div className="container course-strip-inner">
              <div>
                <span className="eyebrow">{selectedCourse.number}</span>
                <h1>{selectedCourse.name}</h1>
                <p>{courseQuestions.length} שאלות מתוך {new Set(courseQuestions.map((question) => question.examId)).size} מבחנים</p>
              </div>
              <button className="button button-quiet" type="button" onClick={goHome}>החלפת קורס</button>
            </div>
          </section>

          <section className="container bank-content">
            <div className="question-search">
              <SearchIcon />
              <input
                type="search"
                value={filters.query}
                onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                placeholder="חיפוש בתוך הקורס: סופרמום, רציפות, ויירשטראס…"
                aria-label="חיפוש שאלות"
              />
            </div>

            <div className="filter-panel">
              <div className="filter-grid">
                <FilterSelect
                  label="נושא"
                  value={filters.topic}
                  onChange={(value) => setFilters((current) => ({ ...current, topic: value }))}
                  options={Object.entries(selectedCourse.topics)}
                  placeholder="כל הנושאים"
                />
                <FilterSelect
                  label="אופי השאלה"
                  value={filters.nature}
                  onChange={(value) => setFilters((current) => ({ ...current, nature: value }))}
                  options={Object.entries(selectedCourse.natures)}
                  placeholder="כל סוגי השאלות"
                />
                <FilterSelect
                  label="שנה"
                  value={filters.year}
                  onChange={(value) => setFilters((current) => ({ ...current, year: value }))}
                  options={years.map((year) => [String(year), String(year)])}
                  placeholder="כל השנים"
                />
                <FilterSelect
                  label="סמסטר"
                  value={filters.semester}
                  onChange={(value) => setFilters((current) => ({ ...current, semester: value }))}
                  options={[["א", "סמסטר א׳"], ["ב", "סמסטר ב׳"]]}
                  placeholder="כל הסמסטרים"
                />
                <FilterSelect
                  label="מועד"
                  value={filters.moed}
                  onChange={(value) => setFilters((current) => ({ ...current, moed: value }))}
                  options={[["א", "מועד א׳"], ["ב", "מועד ב׳"]]}
                  placeholder="כל המועדים"
                />
                <FilterSelect
                  label="מיון"
                  value={filters.sort}
                  onChange={(value) => setFilters((current) => ({ ...current, sort: value as Filters["sort"] }))}
                  options={[
                    ["new", "החדשות ביותר"],
                    ["old", "הישנות ביותר"],
                    ["likes", "הכי אהובות"],
                    ["views", "הכי נצפות"],
                    ["solves", "הכי הרבה סיימו"],
                  ]}
                  placeholder="מיון"
                />
              </div>
              <div className="filter-bottom">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={filters.hideSolved}
                    onChange={(event) => setFilters((current) => ({ ...current, hideSolved: event.target.checked }))}
                  />
                  <span>להסתיר שאלות שסיימתי</span>
                </label>
                <button className="button button-cream" type="button" onClick={() => pdfInput.current?.click()}>
                  <UploadIcon />
                  טעינת PDF מהמחשב
                </button>
                <input
                  ref={pdfInput}
                  type="file"
                  accept="application/pdf"
                  multiple
                  hidden
                  onChange={(event) => handlePdfFiles(event.target.files)}
                />
              </div>
            </div>

            <div className="results-heading">
              <div>
                <strong>{visibleQuestions.length} שאלות</strong>
                <span>מתוך {distinctExamCount} מבחנים</span>
              </div>
              <span className="hints-only"><i /> רמזים בלבד — בלי פתרונות מלאים</span>
            </div>

            <div className="question-list">
              {visibleQuestions.map((question) => {
                const exam = bank.exams[question.examId];
                return (
                  <QuestionCard
                    key={question.id}
                    question={question}
                    exam={exam}
                    natureLabel={selectedCourse.natures[question.nature] ?? question.nature}
                    topicLabels={question.topics.map((topic) => selectedCourse.topics[topic] ?? topic)}
                    stats={stats[question.id] ?? EMPTY_STATS}
                    progress={progress[question.id] ?? EMPTY_PROGRESS}
                    hints={hints[question.id] ?? []}
                    onToggleLiked={() => void updateProgress(question.id, "liked")}
                    onToggleSolved={() => void updateProgress(question.id, "solved")}
                    onOpenHints={() => void recordView(question.id)}
                    onPostHint={(text) => postHint(question.id, text)}
                    onVoteHint={voteHint}
                    onOpenSource={() => void openSource(question)}
                  />
                );
              })}
              {visibleQuestions.length === 0 && (
                <div className="empty-state wide">
                  <strong>לא נמצאו שאלות שמתאימות לסינון</strong>
                  <button className="text-button" type="button" onClick={() => setFilters(initialFilters)}>ניקוי כל המסננים</button>
                </div>
              )}
            </div>
          </section>
        </main>
      )}

      <footer>
        <div className="container footer-inner">
          <strong>גיבנק</strong>
          <p>כל הזכויות על השאלות שמורות לאוניברסיטה העברית ולסגלי הקורסים.</p>
          <span>הרמזים נכתבים על ידי סטודנטים — קראו בעין ביקורתית.</span>
        </div>
      </footer>

      {infoOpen && (
        <Modal title={infoCopy[infoOpen].title} onClose={() => setInfoOpen(null)}>
          <div className="info-copy">
            {infoCopy[infoOpen].paragraphs.map(([title, paragraph]) => (
              <section key={title}>
                <h3>{title}</h3>
                <p>{paragraph}</p>
              </section>
            ))}
          </div>
        </Modal>
      )}

      {authOpen && (
        <Modal title={user ? "החשבון שלי" : "כניסה לגיבנק"} onClose={() => setAuthOpen(false)}>
          {user ? (
            <div className="auth-copy">
              <span className="eyebrow">מחובר/ת</span>
              <h3>{user.email}</h3>
              <p>הסימונים וההתקדמות שלכם מסונכרנים בין מכשירים.</p>
              <button className="button button-navy" type="button" onClick={() => void signOut()}>התנתקות</button>
            </div>
          ) : (
            <div className="auth-copy">
              <p>הכניסו כתובת מייל ונשלח קישור כניסה חד־פעמי. אין צורך בסיסמה.</p>
              <label>
                <span>כתובת מייל</span>
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" dir="ltr" />
              </label>
              <button className="button button-navy" type="button" disabled={authBusy || !email.trim()} onClick={() => void sendMagicLink()}>
                {authBusy ? "שולח…" : "שלחו לי קישור כניסה"}
              </button>
              {authMessage && <p className="form-message">{authMessage}</p>}
            </div>
          )}
        </Modal>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[][];
  placeholder: string;
}) {
  return (
    <label className={`filter-field ${value ? "is-active" : ""}`}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{placeholder}</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="text-button" type="button" onClick={onClose}>סגירה</button>
        </div>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}
