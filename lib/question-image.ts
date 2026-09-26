import "server-only";

import { createClient } from "@supabase/supabase-js";

const STORAGE_BUCKET = "exam-files";
const SIGNED_URL_LIFETIME_SECONDS = 60 * 60;

function getServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function signQuestionImages(paths: string[]) {
  const client = getServerClient();
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (!client || !uniquePaths.length) return new Map<string, string>();

  try {
    // Supabase signs the whole result page in one storage request.
    const result = await client.storage
      .from(STORAGE_BUCKET)
      .createSignedUrls(uniquePaths, SIGNED_URL_LIFETIME_SECONDS);
    if (result.error || !result.data) return new Map<string, string>();
    return new Map(
      result.data
        .filter((item) => item.signedUrl)
        .map((item) => [item.path, item.signedUrl] as const),
    );
  } catch {
    // A missing configuration or temporary storage failure must never hide the
    // question card; callers deliberately fall back to the transcription.
    return new Map<string, string>();
  }
}

export async function signedImagesForQuestionIds(questionIds: string[]) {
  const client = getServerClient();
  const ids = [...new Set(questionIds.filter(Boolean))].slice(0, 100);
  if (!client || !ids.length) return {} as Record<string, string>;

  try {
    const result = await client
      .from("live_questions")
      .select("id,image_path")
      .in("id", ids)
      .eq("is_published", true)
      .not("image_path", "is", null);
    if (result.error || !result.data) return {} as Record<string, string>;

    const signedByPath = await signQuestionImages(
      result.data.map((question) => question.image_path).filter(Boolean) as string[],
    );
    return Object.fromEntries(
      result.data.flatMap((question) => {
        const signedUrl = question.image_path
          ? signedByPath.get(question.image_path)
          : undefined;
        return signedUrl ? [[question.id, signedUrl]] : [];
      }),
    );
  } catch {
    return {} as Record<string, string>;
  }
}

