/**
 * One place for the Gemini text model the app calls. `gemini-1.5-flash` and
 * `gemini-2.0-flash` were retired by Google (HTTP 404 "no longer available", 5 ก.ย. 2569)
 * and every route that named them had been silently falling back to OpenAI.
 */
export const GEMINI_TEXT_MODEL = 'gemini-3.6-flash';

export function geminiUrl(model = GEMINI_TEXT_MODEL) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

/** Newer models may lead with a "thought" part that has no text — join every text part. */
export function geminiText(json: any): string {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}
