export const STAGING_MIGRATION = 'supabase/migrations/202610060006_staged_updates.sql';

export async function requireStaging(client) {
  const result = await client.from('question_updates').select('question_id,revision').limit(1);
  if (result.error) throw new Error(`Apply ${STAGING_MIGRATION} in Supabase SQL Editor first. ${result.error.message}`);
}

// Supabase defaults to a row cap. Explicit pages prevent silent course truncation.
export async function allRows(makeQuery) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const result = await makeQuery().range(offset, offset + 499);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data ?? []).length < 500) return rows;
  }
}
