export type Difficulty = "easy" | "mid" | "hard";

export interface Course {
  number: string;
  name: string;
  aliases: string[];
  department: string;
  topics: Record<string, string>;
  natures: Record<string, string>;
}

export interface Exam {
  id: string;
  courseNumber: string;
  ordinal: number;
  year: number;
  semester: string;
  moed: string;
  date: string;
  instructors: string;
  sourceFilename: string;
  storagePath?: string | null;
  questionsToAnswer: string;
}

export interface Question {
  id: string;
  examId: string;
  ordinal: number;
  number: string;
  subpart: string;
  points: string;
  nature: string;
  difficulty: Difficulty;
  topics: string[];
  title: string;
  context?: string;
  statement: string;
  uncertain?: boolean;
}

export interface BankData {
  courses: Course[];
  exams: Record<string, Exam>;
  questions: Question[];
}

export interface QuestionStats {
  likes: number;
  views: number;
  solves: number;
}

export interface Hint {
  id: string;
  questionId: string;
  text: string;
  votes: number;
  createdAt: string;
}

export interface Progress {
  liked: boolean;
  solved: boolean;
}

export type BackendState = "local" | "connecting" | "connected" | "unavailable";

export interface LegacySeed {
  course: { number: string; name: string; aliases?: string[]; department?: string };
  exams: Record<
    string,
    {
      n: number;
      y: number;
      sem: string;
      moed: string;
      date: string;
      teach: string;
      file: string;
      pick: string;
    }
  >;
  topics: Record<string, string>;
  natures: Record<string, string>;
  questions: Array<{
    id: string;
    ex: string;
    o: number;
    q: string;
    s: string;
    pts: string;
    nat: string;
    lvl: Difficulty;
    top: string[];
    title: string;
    ctx?: string;
    st: string;
    unc?: boolean;
  }>;
}
