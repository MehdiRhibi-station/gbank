import seedJson from "@/data/course-80131.json";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import type { BankData, Course, Exam, LegacySeed, Question } from "@/lib/types";

const seed = seedJson as LegacySeed;

export function getSeedBankData(): BankData {
  const course: Course = {
    number: seed.course.number,
    name: seed.course.name,
    aliases: seed.course.aliases ?? [
      "אינפי 1",
      "אינפי1",
      "חדו״א 1",
      "חדוא 1",
      "infi 1",
      "calculus 1",
    ],
    department: seed.course.department ?? "החוג למתמטיקה, האוניברסיטה העברית",
    topics: seed.topics,
    natures: seed.natures,
  };

  const exams = Object.fromEntries(
    Object.entries(seed.exams).map(([id, exam]) => [
      id,
      {
        id,
        courseNumber: course.number,
        ordinal: exam.n,
        year: exam.y,
        semester: exam.sem,
        moed: exam.moed,
        date: exam.date,
        instructors: exam.teach,
        sourceFilename: exam.file,
        storagePath: null,
        questionsToAnswer: exam.pick,
      } satisfies Exam,
    ]),
  );

  const questions: Question[] = seed.questions.map((question) => ({
    id: question.id,
    examId: question.ex,
    ordinal: question.o,
    number: question.q,
    subpart: question.s,
    points: question.pts,
    nature: question.nat,
    difficulty: question.lvl,
    topics: question.top,
    title: question.title,
    context: question.ctx,
    statement: question.st,
    uncertain: question.unc,
  }));

  return { courses: [course], exams, questions };
}

export async function loadRemoteBankData(): Promise<BankData | null> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return null;

  const [courseResult, examResult, questionResult] = await Promise.all([
    supabase
      .from("courses")
      .select("number,name,aliases,department,topics,natures")
      .eq("is_published", true)
      .order("number"),
    supabase
      .from("exams")
      .select(
        "id,course_number,ordinal,year,semester,moed,exam_date,instructors,source_filename,storage_path,questions_to_answer",
      )
      .eq("is_published", true)
      .order("ordinal"),
    supabase
      .from("questions")
      .select(
        "id,exam_id,ordinal,question_number,subpart,points,nature,difficulty,topics,title,context,statement,uncertain",
      )
      .eq("is_published", true)
      .order("ordinal"),
  ]);

  if (courseResult.error || examResult.error || questionResult.error || !courseResult.data?.length) {
    return null;
  }

  const courses: Course[] = courseResult.data.map((row) => ({
    number: row.number,
    name: row.name,
    aliases: row.aliases ?? [],
    department: row.department ?? "האוניברסיטה העברית",
    topics: (row.topics ?? {}) as Record<string, string>,
    natures: (row.natures ?? {}) as Record<string, string>,
  }));

  const exams = Object.fromEntries(
    examResult.data.map((row) => [
      row.id,
      {
        id: row.id,
        courseNumber: row.course_number,
        ordinal: row.ordinal,
        year: row.year,
        semester: row.semester,
        moed: row.moed,
        date: row.exam_date ?? "",
        instructors: row.instructors ?? "",
        sourceFilename: row.source_filename,
        storagePath: row.storage_path,
        questionsToAnswer: row.questions_to_answer ?? "",
      } satisfies Exam,
    ]),
  );

  const questions: Question[] = questionResult.data
    .filter((row) => exams[row.exam_id])
    .map((row) => ({
      id: row.id,
      examId: row.exam_id,
      ordinal: row.ordinal,
      number: row.question_number,
      subpart: row.subpart ?? "",
      points: row.points ?? "",
      nature: row.nature,
      difficulty: row.difficulty,
      topics: row.topics ?? [],
      title: row.title,
      context: row.context ?? undefined,
      statement: row.statement,
      uncertain: row.uncertain,
    }));

  return { courses, exams, questions };
}
