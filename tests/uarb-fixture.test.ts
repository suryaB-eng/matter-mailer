// Fixtures adapted from senpilot-matter-mailer tests/source.test.ts, traversal.test.ts,
// and the recording export dialog in tests/transfers.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { CATEGORIES, type MatterSnapshot } from '../src/matter.js';
import { downloadSelected, lookupMatter, selectRecords, UARB_URL } from '../src/uarb.js';
import { packageRecords } from '../src/zip.js';

function overview(mode: 'wrong' | 'negative' | 'normal' | 'delayed' | 'unknown' | 'conflict' | 'timeout') {
  const matterText = mode === 'wrong' ? 'M12205' : mode === 'delayed' ? '' : 'M01234';
  const count = (category: string) => mode === 'unknown' && category === 'Recordings' ? '?'
    : category === 'Key Documents' || (mode === 'unknown' && category === 'Other Documents') ? 1 : 0;
  const overviewHtml = `<div class="iwps_text_box cstitle_text_2" style="position:absolute;top:40px;left:10px">Matter No</div>
    <div class="fm-textarea" style="position:absolute;top:80px;left:10px"><div class="text">${matterText}</div></div>
    <div class="iwps_text_box cstitle_text_2" style="position:absolute;top:40px;left:1000px">Outcome</div>
    <div class="fm-textarea" style="position:absolute;top:80px;left:983px"><div class="text">Dismissed/Denied</div></div>
    ${CATEGORIES.map((category, index) => `<button style="position:absolute;top:0;left:${index * 220}px" onclick="openCategory('${category}')">${category} - ${count(category)}</button>`).join('')}`;
  const row = `${mode === 'conflict' ? '<p>Found Count: 2</p>' : ''}<table><tbody><tr class="v-grid-row"><td><div class="iwps_group"><div class="fm-textarea"><div class="text">00880</div></div></div><button onclick="openDownloads()">GO GET IT</button></td></tr></tbody></table>`;
  const dialog = `<div role="dialog" aria-label="Download Files"><p>Download Files</p><button class="fm-download-button" onclick="transfer(0)">../../same.pdf</button><button class="fm-download-button" onclick="transfer(1)">../../same.pdf</button><button onclick="this.parentElement.remove()">Close</button></div>`;
  const searchField = `<div class="fm-textarea" style="position:absolute;top:120px;left:100px;width:300px;height:30px"><div class="text" style="height:30px" tabindex="0" onclick="this.contentEditable='true'" onblur="this.removeAttribute('contenteditable');this.parentElement.querySelector('.placeholder').textContent=''"></div><div class="placeholder" style="pointer-events:none">eg M01234</div></div>`;
  const negative = '<div role="dialog" aria-label="No Records Found">No Records Found<p>No records matched your search request. Click OK to return to Search page.</p></div>';
  return `<html><body><p>Go Directly to Matter</p>
    ${mode === 'delayed' ? '' : searchField}
    <button style="position:absolute;top:120px;left:420px" onclick="search()">Search</button>
    <button style="position:absolute;top:500px;left:0" onclick="throw Error('wrong Search')">Search</button><div id="slot"></div>
    <script>
    ${mode === 'delayed' ? `setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(searchField)}), 200);` : ''}
    function search() {
      ${mode === 'timeout' ? 'return;' : ''}
      document.body.innerHTML = ${JSON.stringify(mode === 'negative' ? negative : `${overviewHtml}<div id="slot" style="position:absolute;top:160px;left:10px"></div>`)};
      ${mode === 'delayed' ? "setTimeout(() => { const text = document.querySelector('.fm-textarea .text'); if (text) text.textContent = 'M01234'; }, 200);" : ''}
    }
    function openCategory(category) { document.querySelector('#slot').innerHTML = category === 'Key Documents' ? ${JSON.stringify(row)} : '<div role="dialog" aria-label="No Matching Records">No Matching Records<button onclick="this.parentElement.remove()">OK</button></div>'; }
    function openDownloads() { document.querySelector('#slot').insertAdjacentHTML('beforeend', ${JSON.stringify(dialog)}); }
    function transfer(index) {
      const bytes = index === 0 ? ${JSON.stringify('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')} : '<html>error</html>';
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes])); a.download = 'same.pdf'; a.click();
    }
    </script></body></html>`;
}

async function routed(page: Page, mode: Parameters<typeof overview>[0]) {
  await page.route(UARB_URL, route => route.fulfill({ contentType: 'text/html', body: overview(mode) }));
}

test('lookup distinguishes a wrong matter, a real no-match, a delayed overview, and a search timeout', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mode of ['wrong', 'negative', 'delayed'] as const) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
      await routed(page, mode);
      const result = await lookupMatter(page, 'M01234', { uiTimeoutMs: 5_000 });
      assert.equal(result.status, mode === 'wrong' ? 'source_failure' : mode === 'negative' ? 'not_found' : 'found');
      if (result.status === 'source_failure') assert.match(result.reason, /matter identity/i);
      if (result.status === 'not_found') assert.match(result.reason, /No Records Found/);
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await routed(page, 'timeout');
    const timedOut = await lookupMatter(page, 'M01234', { uiTimeoutMs: 1_500 });
    assert.equal(timedOut.status, 'source_failure');
    assert.match(timedOut.status === 'source_failure' ? timedOut.reason : '', /timeout/i);
    await page.close();
  } finally { await browser.close(); }
});

test('unknown counts stay null, zero stays zero, and a conflicting count is not invented', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await routed(page, 'unknown');
    const found = await lookupMatter(page, 'M01234');
    assert.equal(found.status, 'found');
    if (found.status !== 'found') return;
    assert.deepEqual(found.snapshot.counts, { Exhibits: 0, 'Key Documents': 1, 'Other Documents': 1, Transcripts: 0, Recordings: null });
    assert.equal(found.snapshot.metadata.find(item => item.label === 'Outcome')?.value, 'Dismissed/Denied');
    const selected = await selectRecords(page, found.snapshot, 'Key Documents');
    assert.equal(selected.status, 'selected');
    await page.close();
    let lookups = 0;
    const conflict = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await conflict.route(UARB_URL, route => { lookups += 1; return route.fulfill({ contentType: 'text/html', body: overview('conflict') }); });
    const again = await lookupMatter(conflict, 'M01234');
    assert.equal(again.status, 'found');
    if (again.status !== 'found') return;
    const selectedConflict = await selectRecords(conflict, again.snapshot, 'Key Documents');
    assert.equal(lookups, 2);
    assert.equal(again.snapshot.counts['Key Documents'], null);
    assert.equal(selectedConflict.status, 'selected');
    if (selectedConflict.status === 'selected') assert.equal(selectedConflict.selection.complete, false);
  } finally { await browser.close(); }
});

test('duplicate download names do not split a failed component group into the ZIP', async () => {
  const browser = await chromium.launch({ headless: true });
  const dir = await mkdtemp(join(tmpdir(), 'matter-components-'));
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
    await routed(page, 'normal');
    const lookup = await lookupMatter(page, 'M01234');
    assert.equal(lookup.status, 'found');
    if (lookup.status !== 'found') return;
    const empty = await selectRecords(page, lookup.snapshot, 'Transcripts');
    assert.equal(empty.status, 'empty');
    const selected = await selectRecords(page, lookup.snapshot, 'Key Documents');
    assert.equal(selected.status, 'selected');
    if (selected.status !== 'selected') return;
    let frozen = false;
    const records = await downloadSelected(page, selected.selection, dir, async current => {
      if (!frozen) {
        assert.equal(current[0]!.components.length, 2);
        assert.ok(current[0]!.components.every(component => component.path === null));
        frozen = true;
      }
    });
    assert.equal(frozen, true);
    assert.equal(records[0]!.status, 'failed');
    assert.match(records[0]!.failureReason ?? '', /HTML/);
    assert.equal(new Set(records[0]!.components.map(component => component.archiveName)).size, 2);
    const packed = await packageRecords({
      jobDir: dir, matter: 'M01234', category: 'Key Documents', snapshotMatterId: 'M01234', selectionMatterId: 'M01234', records,
    });
    assert.equal(packed.zipPath, null);
  } finally { await browser.close(); await rm(dir, { recursive: true, force: true }); }
});

function recycled(gap = false) {
  return `<html><body><div class='fm-textarea'><div class='text'>M01234</div></div>
    ${CATEGORIES.map(category => `<button>${category} - 14</button>`).join('')}
    <p>Doc No</p><p>Found Count: 14</p><button onclick='window.allTypes=true'>All Types</button>
    <div class='v-grid' style='position:relative;height:180px;width:1000px'>
    <div class='v-grid-scroller-vertical' style='height:180px;width:10px;overflow-y:scroll'><div style='height:840px'></div></div><div id='rows'></div></div>
    <script>
    const scroller=document.querySelector('.v-grid-scroller-vertical');
    const ids=Array.from({length:14},(_,i)=>String(i>1?i-1:i).padStart(5,'0'));
    function render(){ const first=Math.floor(scroller.scrollTop/60)+(${gap} ? scroller.scrollTop>0?4:0 : 0);
      const holder=document.querySelector('#rows');holder.innerHTML='';ids.slice(first,first+3).forEach((id,i)=>{
        const row=document.createElement('div');row.className='v-grid-row';row.style.cssText='position:absolute;top:0;left:20px;width:900px;height:60px;transform:translateY('+((first+i)*60)+'px)';
        row.innerHTML='<div class="iwps_group"><div class="fm-textarea"><div class="text">'+id+'</div></div></div>';
        const go=document.createElement('button');go.textContent='GO GET IT';go.onclick=()=>openFiles(id);row.append(go);holder.append(row); }); }
    scroller.addEventListener('scroll',render); render();
    function openFiles(id){ const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-label','Download Files');
      const file=document.createElement('button');file.className='fm-download-button';file.textContent=id+'.pdf';file.onclick=()=>transfer(id);
      const close=document.createElement('button');close.textContent='Close';close.onclick=()=>dialog.remove();dialog.append(file,close);document.body.append(dialog); }
    function transfer(id){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([['%PDF-1.4','1 0 obj','<<>>','endobj','%%EOF',''].join(String.fromCharCode(10))]));a.download=id+'.pdf';a.click();}
    </script></body></html>`;
}

const recycledSnapshot = (): MatterSnapshot => ({
  matterId: 'M01234', observedAt: 'fixture', metadata: [],
  counts: { Exhibits: 14, 'Key Documents': 14, 'Other Documents': 14, Transcripts: null, Recordings: 14 },
});

test('five category tabs deduplicate recycled row IDs and stop at ten records', { timeout: 180_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const category of CATEGORIES) {
      const page = await browser.newPage();
      await page.setContent(recycled());
      await page.locator('.v-grid-scroller-vertical').evaluate(element => { element.scrollTop = 180; element.dispatchEvent(new Event('scroll')); });
      const result = await selectRecords(page, recycledSnapshot(), category, { uiTimeoutMs: 5_000, maxScrollSteps: 30 });
      assert.equal(result.status, 'selected', JSON.stringify(result));
      if (result.status !== 'selected') continue;
      assert.deepEqual(result.selection.records.map(row => row.recordId), Array.from({ length: 10 }, (_, index) => String(index).padStart(5, '0')));
      assert.equal(result.selection.complete, true);
      assert.equal(await page.evaluate(() => (window as unknown as { allTypes?: boolean }).allTypes), true);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('a recycled-row gap keeps the records read before the gap', async () => {
  const browser = await chromium.launch({ headless: true });
  const dir = await mkdtemp(join(tmpdir(), 'matter-gap-'));
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.setContent(recycled(true));
    const found = await selectRecords(page, recycledSnapshot(), 'Other Documents', { uiTimeoutMs: 5_000, maxScrollSteps: 5 });
    assert.equal(found.status, 'selected');
    if (found.status !== 'selected') return;
    assert.equal(found.selection.complete, false);
    assert.match(found.selection.reason ?? '', /gap|overlap|continuity/i);
    const records = await downloadSelected(page, found.selection, dir);
    assert.ok(records.some(record => record.status === 'complete'));
    const packed = await packageRecords({
      jobDir: dir, matter: 'M01234', category: 'Other Documents', snapshotMatterId: 'M01234', selectionMatterId: 'M01234', records,
    });
    assert.ok(packed.zipPath);
    assert.ok(packed.fileCount > 0 && packed.fileCount <= 10);
  } finally { await browser.close(); await rm(dir, { recursive: true, force: true }); }
});

test('recording export keeps the source filename and refuses a changed component list before transfer', async () => {
  const browser = await chromium.launch({ headless: true });
  const dir = await mkdtemp(join(tmpdir(), 'matter-recording-'));
  const html = `<html><body><div class='fm-textarea'><div class='text'>M01234</div></div><button>Recordings - 1</button><p>Date</p>
    <div class='v-grid-row'><div class='iwps_group'><div class='fm-textarea'><div class='text'>01/01/2020</div></div></div>
    <div class='fm-textarea'><div class='text'>Hearing</div></div><button onclick='exportFile()'>GO GET IT</button></div><script>
    window.originalName='Track 1.MP3';window.transfers=0;window.busy=false;window.vaadin={clients:{fixture:{isActive:()=>window.busy}}};
    function exportFile(){const d=document.createElement('div');d.setAttribute('role','dialog');d.setAttribute('aria-label','Export Field to File');
    const input=document.createElement('input');input.value=window.originalName;
    const ok=document.createElement('button');ok.textContent='OK';ok.onclick=()=>{d.remove();window.busy=true;setTimeout(()=>window.busy=false,300);files(input.value);};d.append(input,ok);document.body.append(d);}
    function files(name){const d=document.createElement('div');d.setAttribute('role','dialog');d.setAttribute('aria-label','Download Files');
    const file=document.createElement('button');file.className='fm-download-button';file.textContent=name;file.onclick=()=>{if(window.busy)return;window.transfers++;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['ID3 fixture bytes']));a.download=name;a.click();};
    const close=document.createElement('button');close.textContent='Close';close.onclick=()=>d.remove();d.append(file,close);document.body.append(d);}
    </script></body></html>`;
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.setContent(html);
    const snapshot: MatterSnapshot = { matterId: 'M01234', observedAt: 'fixture', metadata: [], counts: { Exhibits: 0, 'Key Documents': 0, 'Other Documents': 0, Transcripts: 0, Recordings: 1 } };
    const found = await selectRecords(page, snapshot, 'Recordings');
    assert.equal(found.status, 'selected');
    if (found.status !== 'selected') return;
    assert.deepEqual(found.selection.records[0]!.componentNames, ['Track 1.MP3']);
    assert.equal(await page.evaluate(() => (window as unknown as { transfers: number }).transfers), 0);
    await page.evaluate(() => { (window as unknown as { originalName: string }).originalName = 'Changed.MP3'; });
    const changed = await downloadSelected(page, found.selection, dir);
    assert.equal(changed[0]!.status, 'failed');
    assert.match(changed[0]!.failureReason ?? '', /list changed/i);
    assert.equal(await page.evaluate(() => (window as unknown as { transfers: number }).transfers), 0);
    await page.evaluate(() => { (window as unknown as { originalName: string }).originalName = 'Track 1.MP3'; });
    const records = await downloadSelected(page, found.selection, dir);
    assert.equal(records[0]!.status, 'complete');
    assert.equal(records[0]!.components[0]!.originalName, 'Track 1.MP3');
  } finally { await browser.close(); await rm(dir, { recursive: true, force: true }); }
});
