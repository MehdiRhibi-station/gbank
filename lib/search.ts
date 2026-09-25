const HEBREW_DIACRITICS = /[\u0591-\u05C7]/g;
const QUOTATION_MARKS = /[׳״'’"“”`´]/g;
const DASHES = /[־‐‑‒–—-]/g;
const NON_SEARCH_CHARACTERS = /[^\u05D0-\u05EAa-z0-9]+/gi;

export function normalizeSearchValue(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("he")
    .replace(HEBREW_DIACRITICS, "")
    .replace(QUOTATION_MARKS, "")
    .replace(DASHES, " ")
    .replace(NON_SEARCH_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesSearchText(text: string, query: string) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return true;

  const normalizedText = normalizeSearchValue(text);
  return normalizedQuery
    .split(" ")
    .every((token) => normalizedText.includes(token));
}
