"use client";

import { useEffect, useState } from "react";
import { CheckIcon, FileIcon, HeartIcon } from "@/components/icons";
import type { Exam, Hint, Progress, Question, QuestionStats } from "@/lib/types";

declare global {
  interface Window {
    MathJax?: { typesetPromise?: (nodes?: Element[]) => Promise<unknown> };
  }
}

const difficultyLabels = {
  easy: "קל",
  mid: "בינוני",
  hard: "מאתגר",
};

interface QuestionCardProps {
  question: Question;
  exam: Exam;
  natureLabel: string;
  topicLabels: string[];
  stats: QuestionStats;
  progress: Progress;
  hints: Hint[];
  onToggleLiked: () => void;
  onToggleSolved: () => void;
  onOpenHints: () => void;
  onPostHint: (text: string) => Promise<boolean>;
  onVoteHint: (hintId: string) => Promise<void>;
  onOpenSource: () => void;
}

export function QuestionCard({
  question,
  exam,
  natureLabel,
  topicLabels,
  stats,
  progress,
  hints,
  onToggleLiked,
  onToggleSolved,
  onOpenHints,
  onPostHint,
  onVoteHint,
  onOpenSource,
}: QuestionCardProps) {
  const [hintsOpen, setHintsOpen] = useState(false);
  const [hintText, setHintText] = useState("");
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.MathJax?.typesetPromise?.().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [question.id, hintsOpen, hints.length]);

  async function submitHint() {
    const value = hintText.trim();
    if (!value) return;
    setPosting(true);
    const saved = await onPostHint(value);
    if (saved) setHintText("");
    setPosting(false);
  }

  function toggleHints() {
    const next = !hintsOpen;
    setHintsOpen(next);
    if (next) onOpenHints();
  }

  return (
    <article className={`question-card ${progress.solved ? "is-solved" : ""}`}>
      <div className="question-index" aria-label={`שאלה ${question.number}${question.subpart}`}>
        <strong>{String(question.ordinal).padStart(2, "0")}</strong>
        <span />
      </div>

      <div className="question-main">
        <div className="chips">
          <span className="chip chip-meta">
            {exam.year} · סמסטר {exam.semester}׳ · מועד {exam.moed}׳
          </span>
          <span className="chip chip-nature">{natureLabel}</span>
          <span className={`chip chip-level level-${question.difficulty}`}>
            {difficultyLabels[question.difficulty]}
          </span>
          {question.uncertain && <span className="chip chip-warning">בדקו מול הסריקה</span>}
        </div>

        <h2>{question.title}</h2>
        {question.context && <p className="question-context">{question.context}</p>}
        <p className="question-statement">{question.statement}</p>

        <div className="question-footer">
          <div className="topic-list">
            {topicLabels.map((label) => (
              <span className="topic-pill" key={label}>
                {label}
              </span>
            ))}
          </div>

          <div className="question-actions">
            <button className="button button-primary" type="button" onClick={toggleHints}>
              {hints.length ? `רמזים (${hints.length})` : "פתחו רמז ראשון"}
            </button>
            <button
              className={`button button-quiet ${progress.solved ? "active" : ""}`}
              type="button"
              onClick={onToggleSolved}
            >
              <CheckIcon />
              {progress.solved ? "סיימתי" : "סיימתי את השאלה"}
            </button>
            <button
              className={`button button-quiet ${progress.liked ? "active" : ""}`}
              type="button"
              onClick={onToggleLiked}
            >
              <HeartIcon />
              עזרה לי {stats.likes}
            </button>
            <button className="button button-quiet" type="button" onClick={onOpenSource}>
              <FileIcon />
              דף המקור
            </button>
          </div>
        </div>

        <p className="question-meta">
          {stats.views} צפיות · {stats.solves} סיימו · שאלה {question.number}
          {question.subpart} · {question.points} · {exam.instructors}
        </p>
      </div>

      {hintsOpen && (
        <section className="hints-panel">
          <div className="hints-heading">
            <div>
              <span className="eyebrow">רמזים מהקהילה</span>
              <h3>כיוון קטן, לא פתרון מלא</h3>
            </div>
            <button className="text-button light" type="button" onClick={() => setHintsOpen(false)}>
              סגירה
            </button>
          </div>

          {hints.length === 0 ? (
            <p className="empty-hints">אין עדיין רמזים לשאלה הזאת. הרמז הראשון יכול להיות שלכם.</p>
          ) : (
            <div className="hint-list">
              {hints.map((hint) => (
                <div className="hint" key={hint.id}>
                  <p>{hint.text}</p>
                  <button type="button" onClick={() => onVoteHint(hint.id)}>
                    עזר לי · {hint.votes}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="hint-composer">
            <textarea
              value={hintText}
              onChange={(event) => setHintText(event.target.value)}
              placeholder="כתבו כיוון מחשבה. נוסחאות אפשר לכתוב בין סימני דולר, למשל $\\sup A$."
              aria-label="כתיבת רמז"
            />
            <button
              className="button button-inverse"
              type="button"
              disabled={posting || !hintText.trim()}
              onClick={submitHint}
            >
              {posting ? "מפרסם…" : "פרסום הרמז"}
            </button>
          </div>
        </section>
      )}
    </article>
  );
}
