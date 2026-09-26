import { signedImagesForQuestionIds } from "@/lib/question-image";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ urls: {} }, { status: 400 });
  }

  const ids = Array.isArray((body as { ids?: unknown })?.ids)
    ? (body as { ids: unknown[] }).ids
        .filter((id): id is string => typeof id === "string" && id.length <= 200)
        .slice(0, 100)
    : [];
  if (!ids.length) return Response.json({ urls: {} });

  const urls = await signedImagesForQuestionIds(ids);
  return Response.json(
    { urls },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}

