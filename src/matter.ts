export const CATEGORIES = ['Exhibits', 'Key Documents', 'Other Documents', 'Transcripts', 'Recordings'] as const;
export type Category = typeof CATEGORIES[number];
export const OVERLAP_NOTE = 'Category counts may overlap; a unique physical-file total was not calculated.';
export const MAX_PHYSICAL_FILES = 10;
export const MAX_ZIP_BYTES = 20_000_000;
export const MAX_COMPONENT_BYTES = 100_000_000;

export interface MatterMetadata { label: string; value: string; view: string }
export interface MatterSnapshot {
  matterId: string;
  observedAt: string;
  metadata: MatterMetadata[];
  counts: Record<Category, number | null>;
}
export interface SelectedRecord {
  recordId: string;
  order: number;
  rawText: string;
  rowKey?: string[];
  componentNames?: string[];
}
export interface Selection {
  matterId: string;
  category: Category;
  observedAt: string;
  records: SelectedRecord[];
  foundCount: number | null;
  complete: boolean;
  reason?: string;
}
export interface SavedComponent {
  index: number;
  originalName: string;
  archiveName: string;
  path: string | null;
  bytes: number | null;
  sha256: string | null;
  status: 'verified' | 'failed';
  failureReason?: string;
}
export interface RetrievedRecord {
  recordId: string;
  order: number;
  status: 'complete' | 'failed';
  failureReason?: string;
  components: SavedComponent[];
}
export type LookupResult =
  | { status: 'found'; snapshot: MatterSnapshot }
  | { status: 'not_found'; reason: string }
  | { status: 'source_failure'; reason: string };
export type SelectionResult =
  | { status: 'selected' | 'empty'; selection: Selection }
  | { status: 'source_failure'; reason: string };

export class MatterIdentityError extends Error {}

export function parseRequest(matterInput: string, categoryInput: string): { matter: string; category: Category } {
  const matter = matterInput.trim().toUpperCase();
  if (!/^M[0-9]{5}$/.test(matter)) throw new Error('Matter must be M followed by exactly five digits, including leading zeros.');
  const category = CATEGORIES.find(value => value.toLowerCase().replace(/s$/, '') === categoryInput.trim().toLowerCase().replace(/s$/, ''));
  if (!category) throw new Error(`Category must be one of: ${CATEGORIES.join(', ')}.`);
  return { matter, category };
}

export function assertMatterIdentity(expected: string, actual: string): void {
  if (!/^M[0-9]{5}$/.test(expected) || actual.trim() !== expected) {
    throw new MatterIdentityError(`Matter identity mismatch: expected ${expected}, observed ${actual}.`);
  }
}
