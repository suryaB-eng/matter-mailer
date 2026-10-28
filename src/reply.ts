import type { FetchReport } from './fetch.js';
import { CATEGORIES, OVERLAP_NOTE } from './matter.js';

export const REQUEST_EXAMPLE = 'Example: Key documents for M01234.';

const CLARIFY: Record<string, string> = {
  'missing-matter': 'The message needs one matter number.',
  'missing-category': 'The message needs one category: Exhibits, Key Documents, Other Documents, Transcripts, or Recordings.',
  'conflict-matter': 'The message contains more than one matter number.',
  'conflict-category': 'The message contains more than one category.',
  'quoted-only': 'The only request I can see is in quoted history.',
  'too-long': 'The message is too long to interpret.',
  'unsafe-subject': 'The subject could not be used safely.',
  oversized: 'That message is too large to read. Please send a short text-only request.',
  unsupported: 'That category is not one of Exhibits, Key Documents, Other Documents, Transcripts, or Recordings.',
};

function safeLine(value: string): string | null {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  return /^[\w .,:;()'/-]{1,180}$/.test(clean) ? clean : null;
}

export function renderClarify(reason: string): string {
  const known = CLARIFY[reason];
  const detail = known ?? safeLine(reason) ?? 'I need one matter number and one category in your own words.';
  return `${detail}\nSend one complete request.\n${REQUEST_EXAMPLE}`;
}

export function renderSystem(reason: 'malformed' | 'ungrounded' | 'quota' | 'unavailable'): string {
  if (reason === 'quota' || reason === 'unavailable') {
    return `The language service is temporarily unavailable, so I did not retrieve documents.\nPlease resend the same request later.\n${REQUEST_EXAMPLE}`;
  }
  return `I could not check the wording of that message, so I did not guess a matter or category.\nPlease resend one request.\n${REQUEST_EXAMPLE}`;
}

export function renderInterrupted(): string {
  return 'That request was interrupted before completion and was not retried.\nPlease send a new email if you still want the documents.\nNo archive is attached.';
}

function counts(report: FetchReport): string {
  if (!report.counts) return 'Category counts were not observed.';
  return CATEGORIES.map(category => `${category}: ${report.counts?.[category] ?? 'unknown'}`).join('\n');
}

function noun(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function renderFetch(report: FetchReport): { text: string; attachZip: boolean } {
  const metadata = report.metadata
    .map(item => {
      const label = safeLine(item.label);
      const value = safeLine(item.value);
      return label && value ? `${label}: ${value}` : null;
    })
    .filter((line): line is string => !!line)
    .slice(0, 12)
    .join('\n');
  const header = [`Matter ${report.matter}, category ${report.category}.`, metadata, counts(report), OVERLAP_NOTE].filter(Boolean).join('\n');
  const files = report.files.length;
  const records = new Set(report.files.map(file => file.recordId)).size;
  if (report.outcome === 'not_found') return { attachZip: false, text: `${header}\n\nMatter ${report.matter} was not found. No archive is attached.` };
  if (report.outcome === 'empty') return { attachZip: false, text: `${header}\n\nThe ${report.category} category listed no records. No archive is attached.` };
  if ((report.outcome === 'success' || report.outcome === 'partial') && report.zipPath && files > 0) {
    const attached = `Attached ${noun(records, 'source record')} and ${noun(files, 'file')}.`;
    if (report.outcome === 'success') return { attachZip: true, text: `${header}\n\n${attached}` };
    const omissions = report.omissions.map(item => `- ${item.recordId ?? 'selection'}: ${safeLine(item.reason) ?? 'omitted'}`).join('\n');
    return {
      attachZip: true,
      text: `${header}\n\n${attached}\nSelected ${noun(report.selectedRecords.length, 'source record')}. This is a partial result.${omissions ? `\n${omissions}` : ''}`,
    };
  }
  return { attachZip: false, text: `${header}\n\nThe documents could not be retrieved. No archive is attached.` };
}
