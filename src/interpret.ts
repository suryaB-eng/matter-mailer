import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { CATEGORIES, type Category } from './matter.js';

export type Decision =
  | { kind: 'fetch'; matter: string; category: Category }
  | { kind: 'clarify'; reason: string }
  | { kind: 'ignore'; reason: string }
  | { kind: 'systemError'; reason: 'malformed' | 'ungrounded' | 'quota' | 'unavailable' };

export interface ModelInput { subject: string; current: string }
export type ModelFn = (input: ModelInput, schema: unknown) => Promise<string>;

const CATEGORY_PATTERNS: { category: Category; pattern: RegExp }[] = [
  { category: 'Key Documents', pattern: /\bkey[\s-]+(?:documents?|docs?)\b/gi },
  { category: 'Other Documents', pattern: /\bother[\s-]+(?:documents?|docs?)\b/gi },
  { category: 'Exhibits', pattern: /\bexhibits?\b/gi },
  { category: 'Transcripts', pattern: /\btranscripts?\b/gi },
  { category: 'Recordings', pattern: /\brecordings?\b/gi },
];

const modelSchema = z.object({
  action: z.enum(['fetch', 'clarify', 'ignore']),
  matter: z.string().max(16),
  category: z.string().max(40),
  matterQuote: z.string().max(200),
  categoryQuote: z.string().max(200),
  reason: z.string().max(300),
}).strict();

export function isThanksOnly(current: string): boolean {
  return /^(?:thanks|thank you|thankyou|got it|received|perfect|great|ok|okay)[.!\s]*$/i.test(current.trim());
}

export function currentAuthorText(raw: string): { current: string; quoted: string } {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\u0000/g, '').split('\n');
  const cut = cutIndex(lines);
  const kept: string[] = [];
  const quoted: string[] = [];
  lines.forEach((line, index) => {
    const quotedLine = index >= cut || /^\s*>/.test(line);
    (quotedLine ? quoted : kept).push(line);
  });
  return { current: kept.join('\n').trim(), quoted: quoted.join('\n').trim() };
}

function cutIndex(lines: string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (/^on .+ wrote:$/i.test(line)) return index;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(line)) return index;
    if (/^-{2,}\s*forwarded message\s*-{2,}$/i.test(line)) return index;
    if (/^from:\s+\S+@\S+/i.test(line)) {
      const window = lines.slice(index, index + 6).map(value => value.trim());
      const hasDate = window.some(value => /^(?:sent|date):\s/i.test(value));
      const hasSubject = window.some(value => /^subject:\s/i.test(value));
      if (hasDate && hasSubject) return index;
    }
  }
  return lines.length;
}

function negatedAt(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 48), index);
  return /\b(?:not|no|don't|dont|do not|without|except)\b[^.!?\n]*$/i.test(window);
}

export function requestSignals(text: string): { matters: string[]; categories: Category[] } {
  const matters = [...new Set([...text.matchAll(/\bM[0-9]{5}\b/gi)].map(match => match[0].toUpperCase()))];
  const categories: Category[] = [];
  for (const entry of CATEGORY_PATTERNS) {
    for (const match of text.matchAll(new RegExp(entry.pattern.source, 'gi'))) {
      if (match.index === undefined || negatedAt(text, match.index)) continue;
      if (!categories.includes(entry.category)) categories.push(entry.category);
    }
  }
  return { matters, categories };
}

export function precheck(subject: string, rawBody: string): Decision | null {
  if (/[\r\n]/.test(subject)) return { kind: 'clarify', reason: 'unsafe-subject' };
  const { current, quoted } = currentAuthorText(rawBody);
  if (isThanksOnly(current)) return { kind: 'ignore', reason: 'thanks' };
  if (current.length > 8_000) return { kind: 'clarify', reason: 'too-long' };
  const active = requestSignals(`${subject}\n${current}`);
  if (active.matters.length > 1) return { kind: 'clarify', reason: 'conflict-matter' };
  if (active.categories.length > 1) return { kind: 'clarify', reason: 'conflict-category' };
  if (active.matters.length === 0 && active.categories.length === 1) return { kind: 'clarify', reason: 'missing-matter' };
  const hidden = requestSignals(quoted);
  if (active.matters.length === 0 && active.categories.length === 0 && (hidden.matters.length > 0 || hidden.categories.length > 0)) {
    return { kind: 'clarify', reason: 'quoted-only' };
  }
  return null;
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || !error) return null;
  const value = error as { status?: unknown; code?: unknown };
  if (typeof value.status === 'number') return value.status;
  if (typeof value.code === 'number') return value.code;
  return null;
}

function isTransient(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(code);
}

function quoteSupports(category: Category, quote: string): boolean {
  const entry = CATEGORY_PATTERNS.find(item => item.category === category);
  return entry ? new RegExp(entry.pattern.source, 'i').test(quote) : false;
}

function onlyNegated(text: string, quote: string): boolean {
  let index = text.indexOf(quote);
  if (index < 0) return true;
  let clear = false;
  while (index >= 0) {
    if (!negatedAt(text, index)) clear = true;
    index = text.indexOf(quote, index + Math.max(quote.length, 1));
  }
  return !clear;
}

function ground(subject: string, current: string, raw: string): Decision {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { kind: 'systemError', reason: 'malformed' }; }
  const result = modelSchema.safeParse(parsed);
  if (!result.success) return { kind: 'systemError', reason: 'malformed' };
  if (result.data.action === 'ignore') return { kind: 'ignore', reason: 'model' };
  if (result.data.action === 'clarify') return { kind: 'clarify', reason: result.data.reason.trim() || 'missing' };
  const haystack = `${subject}\n${current}`;
  const matter = result.data.matter.toUpperCase();
  const category = CATEGORIES.find(value => value.toLowerCase() === result.data.category.trim().toLowerCase());
  const matterQuote = result.data.matterQuote;
  const categoryQuote = result.data.categoryQuote;
  if (!/^M[0-9]{5}$/.test(matter) || !category || !matterQuote || !categoryQuote) return { kind: 'systemError', reason: 'ungrounded' };
  if (!haystack.includes(matterQuote) || !haystack.includes(categoryQuote)) return { kind: 'systemError', reason: 'ungrounded' };
  const quotedMatters = matterQuote.toUpperCase().match(/\bM[0-9]{5}\b/g) ?? [];
  if (quotedMatters.length !== 1 || quotedMatters[0] !== matter) return { kind: 'systemError', reason: 'ungrounded' };
  if (!quoteSupports(category, categoryQuote) || onlyNegated(haystack, categoryQuote)) return { kind: 'systemError', reason: 'ungrounded' };
  const signals = requestSignals(haystack);
  if ((signals.matters.length === 1 && signals.matters[0] !== matter) || (signals.categories.length === 1 && signals.categories[0] !== category)) {
    return { kind: 'systemError', reason: 'ungrounded' };
  }
  return { kind: 'fetch', matter, category };
}

export async function interpretMessage(subject: string, rawBody: string, model: ModelFn): Promise<Decision> {
  const early = precheck(subject, rawBody);
  if (early) return early;
  const { current } = currentAuthorText(rawBody);
  const input = { subject: subject.slice(0, 500), current: current.slice(0, 8_000) };
  const schema = z.toJSONSchema(modelSchema);
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return ground(subject, current, await model(input, schema));
    } catch (error) {
      last = error;
      if (attempt === 1 || !isTransient(error)) break;
    }
  }
  const status = statusOf(last);
  if (status === 429) return { kind: 'systemError', reason: 'quota' };
  if (status === 500 || status === 502 || status === 503 || status === 504) return { kind: 'systemError', reason: 'unavailable' };
  return { kind: 'systemError', reason: 'malformed' };
}

function instruction(subject: string, current: string): string {
  return [
    'Extract one document request from the subject and the current message only.',
    'Return fetch only when one matter and one category are both explicit.',
    'A matter is the letter M plus exactly five digits. Preserve leading zeros, for example M01234.',
    'Categories are Exhibits, Key Documents, Other Documents, Transcripts, and Recordings.',
    'Honor negation. Ordinary synonyms such as key docs or recording count only when the words are present.',
    'Use clarify when a field is missing, the category is unsupported, or two requests conflict.',
    'Use ignore only for thanks-only or unrelated messages.',
    'matterQuote and categoryQuote must be exact copied substrings, or empty when unused.',
    'Do not choose a recipient, URL, file path, or tool.',
    `Subject:\n${subject}`,
    `Current message:\n${current}`,
  ].join('\n');
}

export function geminiInterpreter(config: { GEMINI_API_KEY: string; GEMINI_MODEL: string }): ModelFn {
  const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY, httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } });
  return async (input, schema) => {
    const response = await ai.models.generateContent({
      model: config.GEMINI_MODEL,
      contents: instruction(input.subject, input.current),
      config: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 512 },
    });
    if (!response.text) throw Object.assign(new Error('EMPTY_MODEL'), { status: 502 });
    return response.text;
  };
}
