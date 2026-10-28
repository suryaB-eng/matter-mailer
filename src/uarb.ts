// Browser selectors, overview/count capture, recycled-row traversal, and the recording
// export dialog are adapted from senpilot-matter-mailer src/source/uarb.ts
// (https://github.com/suryaB-eng/senpilot-matter-mailer). Retry, checkpoint repair,
// outbox, and provider code were not copied.
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Download, Locator, Page } from 'playwright';
import {
  assertMatterIdentity, CATEGORIES, MatterIdentityError, MAX_COMPONENT_BYTES, parseRequest,
  type Category, type LookupResult, type MatterSnapshot, type RetrievedRecord, type SavedComponent,
  type SelectedRecord, type Selection, type SelectionResult,
} from './matter.js';
import { safeArchiveName, verifyFile } from './zip.js';

export const UARB_URL = 'https://uarb.novascotia.ca/fmi/webd/UARB15';
const UI_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT = 120_000;
const MAX_SCROLL_STEPS = 40;

export interface SourceOptions {
  uiTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxScrollSteps?: number;
  maxComponentBytes?: number;
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tabPattern = (category: Category) => new RegExp(`^${escapeRegex(category)}\\s*-`);

async function waitForSourceIdle(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(() => {
    const clients = (window as Window & { vaadin?: { clients?: Record<string, { isActive?: () => boolean }> } }).vaadin?.clients;
    return !clients || Object.values(clients).every(client => typeof client.isActive === 'function' && !client.isActive());
  }, undefined, { timeout });
}

async function assertPageMatter(page: Page, matter: string): Promise<void> {
  const identities = await page.locator('.fm-textarea .text').evaluateAll(elements => elements
    .filter(element => !element.closest('.v-grid-row'))
    .map(element => element.textContent?.trim() ?? '').filter(text => /^M[0-9]{5}$/.test(text)));
  assertMatterIdentity(matter, identities.length === 1 ? identities[0]! : identities.join(' '));
}

async function readSnapshot(page: Page, matter: string): Promise<MatterSnapshot> {
  const metadata = await page.evaluate(() => {
    const labels = [...document.querySelectorAll<HTMLElement>('.iwps_text_box.cstitle_text_2')];
    const values = [...document.querySelectorAll<HTMLElement>('.fm-textarea, .iwps_text_box:not(.cstitle_text_2):not(.csheader_text)')]
      .filter(element => !element.closest('.v-grid-row'));
    return labels.flatMap(label => {
      const box = label.getBoundingClientRect();
      const names = label.innerText.split('\n').map(text => text.trim()).filter(Boolean);
      const aligned = values.filter(value => {
        const rect = value.getBoundingClientRect();
        const nearest = [...labels].sort((a, b) => Math.abs(a.getBoundingClientRect().x - rect.x) - Math.abs(b.getBoundingClientRect().x - rect.x))[0];
        return rect.width > 0 && rect.height > 0 && nearest === label && rect.y >= box.bottom - 2;
      }).sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
      if (names.length !== aligned.length) return [];
      return names.map((name, index) => ({ label: name, value: aligned[index]!.innerText.trim(), view: 'matter overview' }));
    });
  });
  const identity = metadata.filter(item => item.label === 'Matter No');
  assertMatterIdentity(matter, identity.length === 1 ? identity[0]!.value : 'unavailable/ambiguous');
  const counts = {} as MatterSnapshot['counts'];
  for (const category of CATEGORIES) {
    const tab = page.getByRole('button', { name: tabPattern(category) });
    const text = await tab.count() === 1 ? (await tab.innerText()).trim() : '';
    const match = text.match(new RegExp(`^${escapeRegex(category)}\\s*-\\s*([0-9]+(?:,[0-9]{3})*)$`));
    const value = match ? Number(match[1]!.replaceAll(',', '')) : NaN;
    counts[category] = Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return { matterId: matter, observedAt: new Date().toISOString(), metadata, counts };
}

export async function lookupMatter(page: Page, matter: string, options: SourceOptions = {}): Promise<LookupResult> {
  const timeout = options.uiTimeoutMs ?? UI_TIMEOUT;
  try {
    parseRequest(matter, 'Key Documents');
    page.setDefaultTimeout(timeout);
    await page.goto(UARB_URL, { waitUntil: 'domcontentloaded', timeout });
    await page.getByText('Go Directly to Matter', { exact: true }).waitFor();
    const promptedField = page.locator('.fm-textarea').filter({ has: page.locator('.placeholder', { hasText: 'eg M01234' }) });
    await promptedField.waitFor();
    if (await promptedField.count() !== 1) throw new Error('Direct-search field unavailable or ambiguous');
    const fieldIndex = await promptedField.evaluate(element => [...document.querySelectorAll('.fm-textarea')].indexOf(element));
    const field = page.locator('.fm-textarea').nth(fieldIndex);
    const box = await field.boundingBox();
    if (!box) throw new Error('Direct-search field is not visible');
    const searches = page.getByRole('button', { name: 'Search', exact: true });
    const aligned = [];
    for (let index = 0; index < await searches.count(); index += 1) {
      const buttonBox = await searches.nth(index).boundingBox();
      if (buttonBox && buttonBox.x >= box.x + box.width - 5 && buttonBox.x <= box.x + box.width + 300
        && buttonBox.y + buttonBox.height / 2 >= box.y && buttonBox.y + buttonBox.height / 2 <= box.y + box.height) aligned.push(searches.nth(index));
    }
    if (aligned.length !== 1) throw new Error('Scoped direct Search control unavailable or ambiguous');
    await field.locator('.text').click();
    const editor = field.locator('[contenteditable="true"]');
    await editor.fill(matter);
    if ((await editor.innerText()).trim() !== matter) throw new Error('Direct-search value did not match requested matter');
    const heading = await page.getByText('Go Directly to Matter', { exact: true }).boundingBox();
    if (!heading) throw new Error('Direct-search heading unavailable');
    await page.mouse.click(heading.x + heading.width / 2, heading.y + heading.height / 2);
    await editor.waitFor({ state: 'hidden' });
    if ((await field.locator('.text').innerText()).trim() !== matter) throw new Error('Direct-search value was not committed');
    await aligned[0]!.click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.iwps_text_box.cstitle_text_2')].some(element => element.innerText.includes('Matter No'))
      || [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(element => element.innerText.includes('No Records Found')), undefined, { timeout });
    const negative = page.getByRole('dialog').filter({ hasText: 'No Records Found' });
    if (await negative.isVisible()) {
      if (!/No records matched your search request/i.test(await negative.innerText())) throw new Error('Unrecognized negative-search dialog');
      return { status: 'not_found', reason: 'Source direct search returned No Records Found / No records matched your search request.' };
    }
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.fm-textarea .text')]
      .some(element => !element.closest('.v-grid-row') && /^M[0-9]{5}$/.test(element.innerText.trim())), undefined, { timeout });
    await page.getByRole('button', { name: /^Key Documents\s*-/ }).waitFor();
    return { status: 'found', snapshot: await readSnapshot(page, matter) };
  } catch (error) {
    if (error instanceof MatterIdentityError) return { status: 'source_failure', reason: reason(error) };
    return { status: 'source_failure', reason: reason(error) };
  }
}

const rowsWithButtons = (page: Page) => page.locator('.v-grid-row').filter({ has: page.getByRole('button', { name: 'GO GET IT', exact: true }) });

async function readRows(page: Page) {
  const heading = page.getByText('Doc No', { exact: true }).or(page.getByText('Exhibit No', { exact: true }));
  const labeledColumns = await page.locator('.iwps_text_box').evaluateAll(elements => elements
    .filter(element => (element as HTMLElement).innerText.split(/\n/).map(text => text.trim()).some(text => text === 'Doc No' || text === 'Exhibit No'))
    .map(element => element.getBoundingClientRect().x));
  const column = labeledColumns.length === 1 ? labeledColumns[0]!
    : await heading.count() === 1 ? (await heading.boundingBox())?.x ?? null : null;
  return rowsWithButtons(page).evaluateAll((elements, columnX) => elements.map(element => {
    const first = element.querySelector('.iwps_group');
    const fields = [...element.querySelectorAll<HTMLElement>('.fm-textarea .text')];
    let identityFields = [...(first ?? element).querySelectorAll<HTMLElement>('.fm-textarea .text')];
    if (columnX !== null && fields.length) {
      const nearest = Math.min(...fields.map(field => Math.abs(field.getBoundingClientRect().x - columnX)));
      identityFields = fields.filter(field => Math.abs(Math.abs(field.getBoundingClientRect().x - columnX) - nearest) < 1);
      const firstLine = Math.min(...identityFields.map(field => field.getBoundingClientRect().y));
      identityFields = identityFields.filter(field => Math.abs(field.getBoundingClientRect().y - firstLine) < 1);
    }
    const style = getComputedStyle(element);
    return {
      identities: identityFields.map(field => field.innerText.trim()).filter(Boolean),
      rowKey: [...element.querySelectorAll<HTMLElement>('.fm-textarea .text')].map(field => field.innerText.trim()),
      top: element.getBoundingClientRect().top,
      offset: style.transform === 'none' ? null : new DOMMatrix(style.transform).m42,
      height: element.getBoundingClientRect().height,
      rawText: (element as HTMLElement).innerText,
    };
  }).sort((a, b) => a.top - b.top), column);
}

async function rowSignature(page: Page): Promise<string> {
  return page.locator('.v-grid-row').evaluateAll(elements => elements.map(element => element.textContent + '|' + (element as HTMLElement).style.transform).join('\n'));
}

async function resetList(page: Page, timeout: number): Promise<void> {
  const scroller = page.locator('.v-grid-scroller-vertical').first();
  if (await scroller.count()) {
    const changed = await scroller.evaluate(element => {
      const moved = element.scrollTop !== 0;
      if (moved) element.scrollTop = 0;
      return moved;
    });
    if (changed) await page.waitForFunction(() => {
      const row = [...document.querySelectorAll<HTMLElement>('.v-grid-row')].find(element => element.innerText.includes('GO GET IT'));
      return row && (getComputedStyle(row).transform === 'none' || new DOMMatrix(getComputedStyle(row).transform).m42 === 0);
    }, undefined, { timeout });
  }
}

async function scrollList(page: Page, timeout: number): Promise<boolean> {
  const scroller = page.locator('.v-grid-scroller-vertical').first();
  if (!await scroller.count()) return false;
  const signature = await rowSignature(page);
  const moved = await scroller.evaluate(element => {
    const previous = element.scrollTop;
    element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, previous + Math.max(1, Math.floor(element.clientHeight * 0.6)));
    return element.clientHeight > 0 && element.scrollTop > previous;
  });
  if (!moved) return false;
  await page.waitForFunction(previous => [...document.querySelectorAll<HTMLElement>('.v-grid-row')]
    .map(element => element.textContent + '|' + element.style.transform).join('\n') !== previous, signature, { timeout });
  return true;
}

function logicalRow(page: Page, recordId: string, rowKey?: string[]): Locator {
  let rows = rowsWithButtons(page);
  for (const value of rowKey ?? [recordId]) rows = rows.filter({ has: page.locator('.fm-textarea .text').filter({ hasText: new RegExp(`^\\s*${escapeRegex(value)}\\s*$`) }) });
  return rows;
}

async function componentDialog(page: Page, row: Locator, matter: string, timeout: number): Promise<{ dialog: Locator; names: string[] }> {
  const dialog = page.getByRole('dialog', { name: 'Download Files', exact: true });
  const exporter = page.getByRole('dialog', { name: 'Export Field to File', exact: true });
  await waitForSourceIdle(page, timeout);
  await assertPageMatter(page, matter);
  if (!await dialog.isVisible() && !await exporter.isVisible()) {
    if (await page.getByRole('dialog').filter({ visible: true }).count()) throw new Error('Unexpected existing source dialog; cannot attribute components to the frozen record.');
    if (await row.count() !== 1) throw new Error('Frozen source row is missing or ambiguous before GO GET IT');
    await row.getByRole('button', { name: 'GO GET IT', exact: true }).click();
    await dialog.or(exporter).first().waitFor({ timeout });
  }
  if (await exporter.isVisible()) {
    if (!(await exporter.locator('input').inputValue()).trim()) throw new Error('Source export filename unavailable');
    await exporter.getByRole('button', { name: 'OK', exact: true }).click();
    await dialog.waitFor({ timeout });
  }
  await waitForSourceIdle(page, timeout);
  const buttons = dialog.locator('.fm-download-button');
  await buttons.first().waitFor({ timeout });
  const names = (await buttons.allTextContents()).map(name => name.trim());
  if (!names.length || names.some(name => !name)) throw new Error('Download-dialog component list is empty or ambiguous');
  return { dialog, names };
}

async function closeComponentDialog(page: Page, timeout: number): Promise<void> {
  await waitForSourceIdle(page, timeout);
  const exporter = page.getByRole('dialog', { name: 'Export Field to File', exact: true });
  if (await exporter.isVisible()) await exporter.getByRole('button', { name: 'Cancel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Download Files', exact: true });
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout });
  }
}

export async function selectRecords(page: Page, snapshot: MatterSnapshot, category: Category, options: SourceOptions = {}): Promise<SelectionResult> {
  return selectInitialRecords(page, snapshot, category, true, options);
}

async function selectInitialRecords(page: Page, snapshot: MatterSnapshot, category: Category, allowRefresh: boolean, options: SourceOptions): Promise<SelectionResult> {
  const timeout = options.uiTimeoutMs ?? UI_TIMEOUT;
  page.setDefaultTimeout(timeout);
  const selection: Selection = { matterId: snapshot.matterId, category, observedAt: new Date().toISOString(), records: [], foundCount: null, complete: false };
  try {
    await assertPageMatter(page, snapshot.matterId);
    await page.getByRole('button', { name: tabPattern(category) }).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(element => element.innerText.includes('No Matching Records'))
      || [...document.querySelectorAll<HTMLElement>('.v-grid-row')].some(element => element.innerText.includes('GO GET IT')), undefined, { timeout });
    const empty = page.getByRole('dialog').filter({ hasText: 'No Matching Records' });
    if (await empty.isVisible()) {
      await empty.getByRole('button', { name: 'OK', exact: true }).click();
      if (snapshot.counts[category] !== null && snapshot.counts[category] !== 0 && allowRefresh) return refreshSelection(page, snapshot, category, options);
      if (snapshot.counts[category] !== 0) {
        snapshot.counts[category] = null;
        selection.reason = 'Overview count was unavailable or conflicted with the confirmed empty tab.';
      }
      return { status: 'empty', selection: { ...selection, foundCount: 0, complete: true } };
    }
    const allTypes = page.getByText('All Types', { exact: true });
    await waitForSourceIdle(page, timeout);
    if (await allTypes.count() === 1 && await allTypes.isVisible()) await allTypes.click();
    await waitForSourceIdle(page, timeout);
    await resetList(page, timeout);
    await rowsWithButtons(page).first().waitFor({ timeout });
    await assertPageMatter(page, snapshot.matterId);
    const foundMatch = (await page.locator('body').innerText()).match(/Found Count\s*:\s*([0-9]+(?:,[0-9]{3})*)/i);
    const table = page.locator('.v-grid [role="grid"]');
    const ariaCount = await table.count() === 1 ? await table.getAttribute('aria-rowcount') : null;
    const found = foundMatch ? Number(foundMatch[1]!.replaceAll(',', '')) : ariaCount !== null && /^\d+$/.test(ariaCount) ? Number(ariaCount) : null;
    selection.foundCount = found !== null && Number.isSafeInteger(found) ? found : null;
    let conflict = selection.foundCount !== null && snapshot.counts[category] !== null && selection.foundCount !== snapshot.counts[category];
    if (conflict && allowRefresh) return refreshSelection(page, snapshot, category, options);
    if (conflict) snapshot.counts[category] = null;
    const media = ['Recordings', 'Transcripts'].includes(category) && await page.getByText('Doc No', { exact: true }).count() === 0;
    let previousKeys: string[] = [];
    const mediaPositions = new Map<string, number | null>();
    for (let step = 0; step < (options.maxScrollSteps ?? MAX_SCROLL_STEPS); step += 1) {
      await assertPageMatter(page, snapshot.matterId);
      const rows = await readRows(page);
      const keys = rows.map(row => media ? JSON.stringify(row.rowKey) : row.identities[0] ?? '');
      if (!rows.length) throw new Error('List traversal lost all populated rows');
      if (!previousKeys.length && rows[0]!.offset !== null && rows[0]!.offset !== 0) throw new Error('List reset-to-start continuity could not be verified');
      if (previousKeys.length && !keys.some(key => previousKeys.includes(key))) throw new Error('List continuity gap: overlapping rows could not be verified');
      for (let index = 0; index < rows.length && selection.records.length < 10; index += 1) {
        const row = rows[index]!;
        if (index && row.offset !== null && rows[index - 1]!.offset !== null && row.offset - rows[index - 1]!.offset! > Math.max(row.height, rows[index - 1]!.height) * 1.5) {
          throw new Error('List continuity gap between populated rows');
        }
        if (row.identities.length !== 1 || !row.identities[0]) throw new Error('Source record identity is missing or ambiguous');
        if (media) {
          if (mediaPositions.has(keys[index]!)) {
            if (row.offset !== null && mediaPositions.get(keys[index]!) === row.offset) continue;
            throw new Error('Ambiguous duplicate media row identity; candidate excluded before freezing');
          }
          mediaPositions.set(keys[index]!, row.offset);
          const { names } = await componentDialog(page, logicalRow(page, '', row.rowKey), snapshot.matterId, timeout);
          await closeComponentDialog(page, timeout);
          selection.records.push({
            recordId: `media:${JSON.stringify([row.rowKey, names])}`,
            order: selection.records.length,
            rawText: row.rawText,
            rowKey: row.rowKey,
            componentNames: names,
          });
        } else if (!selection.records.some(record => record.recordId === row.identities[0])) {
          selection.records.push({ recordId: row.identities[0]!, order: selection.records.length, rawText: row.rawText });
        }
      }
      if (snapshot.counts[category] !== null && selection.records.length > snapshot.counts[category]!) {
        if (allowRefresh) return refreshSelection(page, snapshot, category, options);
        snapshot.counts[category] = null;
        conflict = true;
      }
      const total = selection.foundCount ?? snapshot.counts[category];
      if (selection.records.length === 10 || (total !== null && selection.records.length === total)) {
        selection.complete = !conflict;
        break;
      }
      previousKeys = keys;
      if (!await scrollList(page, Math.min(timeout, 5000))) {
        selection.reason = 'List end reached, but the distinct record total could not be reconciled with available counts.';
        break;
      }
    }
    if (conflict) selection.reason = `Source counts conflict after one refresh; requested overview count is unavailable. ${selection.reason ?? ''}`.trim();
    if (!selection.complete && !selection.reason) selection.reason = 'Bounded list traversal ended before selection continuity/end could be confirmed.';
    if (!selection.records.length) throw new Error('No unambiguous records selected from a nonempty source list');
    return { status: 'selected', selection };
  } catch (error) {
    if (error instanceof MatterIdentityError) throw error;
    if (selection.records.length) {
      selection.reason = `Selection interrupted: ${reason(error)}`;
      return { status: 'selected', selection };
    }
    return { status: 'source_failure', reason: reason(error) };
  }
}

async function refreshSelection(page: Page, snapshot: MatterSnapshot, category: Category, options: SourceOptions): Promise<SelectionResult> {
  const refreshed = await lookupMatter(page, snapshot.matterId, options);
  if (refreshed.status !== 'found') return { status: 'source_failure', reason: `Matter refresh failed during count cross-check: ${refreshed.status === 'source_failure' ? refreshed.reason : 'matter no longer found'}` };
  Object.assign(snapshot, refreshed.snapshot);
  return selectInitialRecords(page, snapshot, category, false, options);
}

async function locateFrozenRow(page: Page, selected: SelectedRecord, options: SourceOptions): Promise<Locator> {
  const timeout = options.uiTimeoutMs ?? UI_TIMEOUT;
  await resetList(page, timeout);
  for (let step = 0; step < (options.maxScrollSteps ?? MAX_SCROLL_STEPS); step += 1) {
    const rows = await readRows(page);
    const matches = rows.filter(row => selected.rowKey
      ? JSON.stringify(row.rowKey) === JSON.stringify(selected.rowKey)
      : row.identities.length === 1 && row.identities[0] === selected.recordId);
    if (matches.length > 1 && (selected.rowKey || new Set(matches.map(row => JSON.stringify(row.rowKey))).size > 1)) throw new Error('Frozen record identity is ambiguous');
    if (matches.length) return logicalRow(page, selected.recordId, selected.rowKey).first();
    if (!await scrollList(page, Math.min(timeout, 5000))) break;
  }
  throw new Error('Frozen record is missing after bounded list traversal');
}

async function saveComponent(page: Page, dialog: Locator, component: SavedComponent, names: string[], timeout: number, maxBytes: number, filesDir: string): Promise<void> {
  const temp = join(filesDir, `${component.archiveName}.part`);
  let download: Download | undefined;
  try {
    await waitForSourceIdle(page, timeout);
    const buttons = dialog.locator('.fm-download-button');
    if (JSON.stringify((await buttons.allTextContents()).map(name => name.trim())) !== JSON.stringify(names)) throw new Error('Download-dialog component list changed on reopening');
    [download] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      buttons.nth(component.index).click(),
    ]);
    await download.saveAs(temp);
    const failure = await download.failure();
    if (failure) throw new Error(`Browser download failed: ${failure}`);
    const checked = await verifyFile(temp, component.originalName);
    if (checked.bytes > maxBytes) throw new Error('Component exceeds the byte limit');
    const path = join(filesDir, component.archiveName);
    await rename(temp, path);
    Object.assign(component, checked, { path, status: 'verified' as const });
    delete component.failureReason;
  } finally {
    if (component.status !== 'verified') await download?.cancel().catch(() => {});
    await download?.delete().catch(() => {});
    await rm(temp, { force: true });
  }
}

export async function downloadSelected(
  page: Page,
  selection: Selection,
  jobDir: string,
  onProgress: (records: RetrievedRecord[]) => Promise<void> = async () => {},
  options: SourceOptions = {},
): Promise<RetrievedRecord[]> {
  const timeout = options.downloadTimeoutMs ?? options.uiTimeoutMs ?? DOWNLOAD_TIMEOUT;
  const uiTimeout = options.uiTimeoutMs ?? UI_TIMEOUT;
  const maxBytes = options.maxComponentBytes ?? MAX_COMPONENT_BYTES;
  const filesDir = join(jobDir, 'files');
  await mkdir(filesDir, { recursive: true });
  const outcomes: RetrievedRecord[] = selection.records.map(selected => ({
    recordId: selected.recordId, order: selected.order, status: 'failed', failureReason: 'Not processed yet.', components: [],
  }));
  let stopped: string | undefined;
  for (const [index, selected] of selection.records.entries()) {
    const record = outcomes[index]!;
    if (stopped) { record.failureReason = stopped; await onProgress(outcomes); continue; }
    try {
      await assertPageMatter(page, selection.matterId);
      const row = await locateFrozenRow(page, selected, options);
      const opened = await componentDialog(page, row, selection.matterId, uiTimeout);
      if (selected.componentNames && JSON.stringify(opened.names) !== JSON.stringify(selected.componentNames)) {
        throw new Error('Frozen media component list changed on reopening');
      }
      const occurrences = new Map<string, number>();
      record.components = opened.names.map((originalName, componentIndex) => {
        occurrences.set(originalName, (occurrences.get(originalName) ?? 0) + 1);
        return {
          index: componentIndex, originalName, archiveName: safeArchiveName(record.recordId, componentIndex, originalName),
          path: null, bytes: null, sha256: null, status: 'failed' as const, failureReason: 'Not transferred yet',
        };
      });
      delete record.failureReason;
      await onProgress(outcomes);
      for (const component of record.components) {
        if (stopped) { component.failureReason = stopped; continue; }
        try {
          let dialog = opened.dialog;
          if (!await dialog.isVisible()) {
            const again = await componentDialog(page, await locateFrozenRow(page, selected, options), selection.matterId, uiTimeout);
            if (JSON.stringify(again.names) !== JSON.stringify(opened.names)) throw new Error('Download-dialog component list changed on reopening');
            dialog = again.dialog;
          }
          await saveComponent(page, dialog, component, opened.names, timeout, maxBytes, filesDir);
        } catch (error) {
          if (error instanceof MatterIdentityError) throw error;
          component.status = 'failed';
          component.failureReason = reason(error);
        }
        await onProgress(outcomes);
      }
      record.status = record.components.length && record.components.every(component => component.status === 'verified') ? 'complete' : 'failed';
      if (record.status === 'failed') {
        record.failureReason = `At least one component failed; entire document record excluded. ${record.components.filter(component => component.status === 'failed').map(component => component.failureReason).join(' ')}`.trim();
      }
    } catch (error) {
      record.status = 'failed';
      record.failureReason = reason(error);
      if (error instanceof MatterIdentityError) stopped = reason(error);
    } finally {
      try { if (!page.isClosed()) await closeComponentDialog(page, uiTimeout); }
      catch (error) { record.status = 'failed'; record.failureReason = `Could not restore list after download dialog: ${reason(error)}`; }
      await onProgress(outcomes);
    }
  }
  return outcomes;
}
