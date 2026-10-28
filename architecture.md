# Architecture

Read this with `README.md`. The README covers how to run and operate the service; this document explains how it is put together and why.

## What the system does

The service watches one Gmail inbox. A person emails it in ordinary language with a Nova Scotia UARB matter number and one document category. The service reads the matter page on the UARB website, collects up to ten documents from the requested category, compresses them into a single ZIP, and replies to the sender with that ZIP attached plus the counts and metadata it saw on the page.

There is no website to visit and no account to create. Email in, email out.

Categories are fixed: Exhibits, Key Documents, Other Documents, Transcripts, Recordings. A matter number is the letter `M` followed by exactly five digits, leading zeros preserved.

## Why it is shaped this way

The whole thing is one long-running Node process on one small Linux VM, with a SQLite file for state. No HTTP server, no queue, no worker pool, no database server.

Three reasons:

**Email is the only interface the request needs.** Polling IMAP means there is nothing to expose to the internet, so there is no inbound port, no domain, no certificate, and no webhook to secure or keep alive.

**The hard part is a browser session, not throughput.** The UARB site is a FileMaker WebDirect application: a contenteditable search field, virtualized table rows that get recycled as you scroll, and a modal dialog per download. That work needs a real browser, a writable disk, and minutes of wall time per request. One persistent process with local storage fits that directly. A serverless function would have to be restructured around execution caps and ephemeral filesystems for no gain here.

**Volume is low and correctness matters more than speed.** Requests arrive one at a time from humans. Handling them strictly one at a time removes concurrency bugs entirely and makes the state machine small enough to read in one sitting. The cost is that a second request waits for the first.

The deliberate trade-off throughout: when the service cannot be certain of something, it says so in the reply rather than guessing. Counts it could not read come back as `unknown`. A partial archive is labeled partial with the reasons listed. A send that may have gone through is parked for a human instead of retried.

## The runtime path, email to reply

The loop lives in `src/main.ts`.

**1. Poll.** Every 30 seconds while idle, connect to Gmail over IMAP, open INBOX read-only, and list messages received at or after the configured activation time. Nothing is marked read, moved, or deleted. The IMAP `SINCE` filter is only a coarse date filter, so the real timestamp cut is applied locally in `src/mail.ts`.

**2. Pick one message.** Each message carries Gmail's stable numeric id. The SQLite ledger in `src/state.ts` is checked for that id; anything already recorded is skipped. The oldest unrecorded message wins, and exactly one is handled per pass. Deduplicating on the Gmail id rather than the read flag means opening an email by hand does not cause it to be skipped, and a second email about the same matter is treated as a new request.

**3. Screen the headers.** `classifyHeader` in `src/mail.ts` decides before any body is read. Mail from the service's own address, automatic mail, mailing-list mail, and bounces are ignored so the service cannot talk to itself in a loop. The reply address is one valid `Reply-To`, otherwise one valid `From`; if that is ambiguous the message is held for a human rather than answered. A message over 1 MB is not parsed at all; the sender gets a short note asking for a plain-text request.

**4. Claim it.** The message is inserted into the ledger as `processing` before any work begins. The primary key does the locking: a duplicate insert simply means another pass already took it.

**5. Interpret.** `src/interpret.ts` first strips quoted reply history and runs deterministic checks. Thanks-only replies are dropped. Two matter numbers, two categories, a category with no matter number, or a request that only exists in the quoted text all produce a clarification without calling the model at all. If those checks pass, one bounded call goes to Gemini with the subject and the current message text, constrained to a JSON schema.

The model's answer is then re-checked against the original text rather than trusted. It has to return exact quoted substrings for the matter and the category; those quotes must actually appear in the message, the quoted matter must be the one it claims, the category wording must really be present, and it must not have picked something the sender negated. Anything that fails grounding becomes a system-error reply, which tells the sender the wording could not be checked instead of blaming them. The model never chooses a recipient, a URL, or a file path.

**6. Retrieve.** `src/fetch.ts` creates a job directory and launches a fresh headless Chromium. `src/uarb.ts` then does the site work: open the matter page, type the matter number into the "Go Directly to Matter" field, press the Search button that belongs to that field, and confirm the page that comes back is actually the requested matter. A genuine "No Records Found" dialog is reported as not found, which is different from the site being unavailable.

With the matter open it reads the five category tab labels for counts and scrapes the overview label/value pairs for metadata. It clicks the requested category tab, then walks the virtualized list. Because rows are recycled DOM nodes, traversal tracks record identity and requires overlapping rows between scroll steps; if continuity cannot be verified it stops and says so instead of silently skipping rows. Selection stops at ten records. If the tab's own found count disagrees with the overview count, it re-reads the matter once and, failing that, reports the count as unavailable rather than picking one.

For each selected record it clicks "Go Get It", handles the export dialog that recordings use, and downloads every file listed in the dialog.

**7. Verify and package.** `src/zip.ts` checks each downloaded file before it can enter an archive: non-empty, not an HTML error page wearing a document's name, and matching the expected signature for its extension. Archive names are rebuilt from a hash of the record id so two files called the same thing cannot collide or escape the directory.

Archives are built record by record. A record goes in whole or not at all, so a multi-file filing is never split. If adding a record would pass ten physical files or the byte budget, that record is dropped with a reason and the next one is tried. The finished ZIP is reopened and every entry is re-hashed against the file it came from before it is allowed out.

**8. Reply.** `src/reply.ts` renders plain text from the retrieval report: the matter and category, the metadata lines, all five category counts, the note that those counts can overlap, and what was attached or why nothing was. `src/mail.ts` builds the MIME message, compares it against the mail size limits, and sends it over SMTP.

Sending is bracketed in the ledger. The row moves to `sending` immediately before the SMTP transaction and is resolved immediately after: accepted becomes `sent`, a permanent rejection becomes `failed`, and anything ambiguous becomes `review`. Nothing in `review` is ever sent again automatically.

**9. Clean up.** The job directory for that request is deleted. The ledger row stays, holding the outcome and a small JSON summary for `inspect`.

**On restart**, `classifyRestart` in `src/state.ts` sweeps the ledger first. Rows stuck in `sending` become `review` with no mail, because the service cannot know whether that message left. Rows stuck in `processing` get one honest reply saying the request was interrupted and was not retried. Leftover job directories are then removed.

## Limits that are part of the design

These are choices, not bugs:

- **One matter and one category per email.** No conversational memory. Missing or conflicting requests get a clarification asking for one complete request.
- **At most ten source records and at most ten files.** Because records are included whole, a matter with multi-file records can deliver fewer than ten records. A dropped record is not replaced by an eleventh.
- **Counts are reported per category and never summed.** The site's category totals can include the same physical file more than once, so the reply states the five counts and explicitly says no unique total was calculated. There is no single "all files" number.
- **20 MB of ZIP, 30 MB of assembled message, and whatever the SMTP server advertises.** Large media will not fit. Those records are omitted with a reason rather than converted, split, or replaced with a download link.
- **No automatic resend.** An uncertain SMTP result is left for a human to check against the Sent folder. Duplicate mail is treated as worse than delayed mail.
- **No retry of a failed retrieval.** If the site errors out, the reply says the documents could not be retrieved and the sender can send a new email.
- **One request at a time, polled on a 30-second idle cycle.** Replies are minutes, not seconds. Each request has a ten-minute budget, after which the browser is closed.
- **Metadata is whatever the overview page exposes.** Nothing is inferred or filled in, and lines that cannot be read cleanly are left out.
- **Ambiguous routing gets no reply.** If the service cannot identify a single reply address it holds the message for a human instead of guessing.
- **Node 24 specifically.** Both `loadConfig` and `runFetch` refuse to start on any other major version, because the ledger uses Node's built-in SQLite module.

## Navigating the codebase

Entry points are `src/main.ts` (the poller, which is what the container runs) and `src/cli.ts` (one-shot commands).

| File | What it is for |
| --- | --- |
| `src/main.ts` | The poll loop and the per-message state machine. Claims a message, routes it through interpretation and retrieval, guards every send, and handles restart recovery. The clearest place to start reading. |
| `src/config.ts` | Validates the six environment variables with Zod and enforces the Node major version. Nothing starts without it. |
| `src/connections.ts` | The IMAP and SMTP client factories, with TLS verification and timeouts set in one place. |
| `src/mail.ts` | Everything about mail mechanics: listing eligible messages, header screening and recipient choice, size-capped body reading, MIME assembly, shrinking a reply that will not fit, sending, and classifying the acknowledgement. |
| `src/interpret.ts` | Turns a message into a decision: fetch, clarify, ignore, or system error. Holds the quoted-history trimming, the deterministic prechecks, the model call, and the grounding checks that re-verify the model against the sender's own words. |
| `src/matter.ts` | The shared vocabulary: the five categories, the matter-number format, the ten-file and byte caps, the result types, and the matter-identity assertion used to prove the page on screen is the page that was asked for. |
| `src/fetch.ts` | Orchestrates one retrieval: job directory, browser lifetime, time budget, and assembly of the `FetchReport` that the reply is rendered from. Also writes `result.json` into the job directory. |
| `src/uarb.ts` | All the site-specific browser work, and the most fragile file by nature. Search and identity verification, the counts and metadata snapshot, virtualized-row traversal and selection, and the download dialogs. Selectors here are adapted from an earlier project, as noted at the top of the file. |
| `src/zip.ts` | File verification by signature, safe archive names, archive construction under the file and byte caps, and the readback that re-hashes the finished ZIP. |
| `src/reply.ts` | The exact wording of every outcome: clarification, system error, interruption, not found, empty, partial, and success. Change customer-facing text here and nowhere else. |
| `src/state.ts` | The SQLite ledger. One `messages` table, the allowed state transitions, and the restart sweep. Transitions are conditional updates that throw if the row was not in the expected state, so a misordered send cannot slip through. |
| `src/doctor.ts` | Startup diagnostics: data directory read/write, IMAP login, SMTP authentication, a structured model call, and Chromium reaching the site. Writes a timestamped evidence file and never sends mail. Also holds `safeError`, which is how errors get logged without leaking credentials. |
| `src/probe.ts` | A one-shot mail round trip. Waits for a message with a specific random nonce from a specific mailbox, then replies once with a small generated ZIP. Used to prove the mail path end to end without touching real documents. |
| `src/probe-policy.ts` | The pure decision functions behind the probe, kept separate so they can be tested: argument validation, subject format, the coarse IMAP date, and the match predicate. |
| `src/cli.ts` | Argument parsing and guard rails for `doctor`, `probe`, `fetch`, and `inspect`. The guards exist so that, for example, `fetch` can never send mail. |

Tests are under `tests/` and run on Node's built-in test runner. `agent-policy.test.ts` covers interpretation, header routing, reply text, and ledger transitions. `matter.test.ts` covers matter parsing and identity. `uarb-fixture.test.ts` drives the real `uarb.ts` code against local HTML fixtures that imitate the site's quirks, including recycled rows and the recording export dialog. `zip-package.test.ts` covers the ten-file and byte boundaries and the readback. `probe-policy.test.ts` and `probe-zip.test.ts` cover the probe. These exercise the modules directly; none of them reach the live site.

Runtime and deployment: `Dockerfile` pins the Node base image and installs the matching Chromium, and its entrypoint takes an exclusive lock on the data directory so two pollers cannot share one ledger. `compose.yaml` runs the poller as a non-root user with the data directory bind-mounted. `docker/playwright-seccomp.json` is the browser seccomp profile. `scripts/` holds the deployment script, the remote half it runs, and the VM cloud-init file.
