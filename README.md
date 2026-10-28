# matter-mailer

Send one matter number and one document category by email. The service reads the Nova Scotia UARB matter page, replies with the five category counts, and attaches a ZIP of up to 10 files.

**Agent address:** suryajaan319@gmail.com

Example, sent from any other mailbox:

- Subject: `Key documents for M01234`
- Body: `Please send me the key documents for matter M01234.`

Expected reply: counts for Exhibits, Key Documents, Other Documents, Transcripts, and Recordings; the note that those counts can overlap and were not added into one total; and a ZIP of the requested records. An empty category, an unknown matter, a clarification, or an error comes back as text only. There is no web page to open.

The poller runs on the Azure VM. The laptop does not need to stay on, and no SSH session is required for a reply.

## Acceptance

| Check | Result |
| --- | --- |
| M01234 Key Documents by email | Passed. SMTP accepted the reply at 2026-10-28T03:44:56Z. Counts were 0/1/1/0/0. One record and one file. ZIP 33,734 bytes, SHA-256 `d0267491d8d7b49f6773ac4ac2a314d41b0e0ce9f7f611f63ff37b001d6e0d3c`. The sender confirmed the ZIP opened. |
| More than 10 records | Passed on the VM for M12205 Other Documents. Counts 13/6/43/0/0. First 10 records: `97289,97291,97354,97364,97408,97434,97468,97532,97750,97933`. ZIP 2,070,814 bytes. No eleventh record. |
| Empty category | Passed. M01234 Transcripts, observed 2026-10-28T03:54:12Z, had no records and no ZIP. M01234 Exhibits, observed 2026-10-28T03:55:15Z, was also empty and had no ZIP. |
| Recordings | Partial. M10698 had five recordings. One MP3 was attached (14,960,128 bytes, SHA-256 `f372efbe138e2f792c15adc080e4bbec4845393645cf89a229a8e3eb9b63e09b`). The ZIP was 13,922,028 bytes. The other four were omitted because the archive cap is 20 MB. |
| Reboot | Passed. The VM was rebooted once while idle. Docker brought the same container back at 2026-10-28T04:05:08Z. The ledger still had the same three messages, and the earlier M01234 reply was not sent again. |
| Local checks | Passed on Node 24.22.1: typecheck, build, and 20 tests. |
| Malformed email | Not run live. The wording checks are covered by tests. A live clarification reply has not been sent. |

Nonempty Transcripts, nonempty Exhibits, and a real multi-component record were not found in the matters already checked. No further matter numbers were guessed.

## Decisions that bound the reply

- One matter (`M` plus five digits, leading zeros kept) and one category per email. Missing or conflicting requests get a short clarification instead of a guess.
- Categories: Exhibits, Key Documents, Other Documents, Transcripts, Recordings.
- At most 10 source records and 10 files. A record is included whole or omitted with a reason.
- Category counts are reported separately and may overlap.
- Mail is polled every 30 seconds. A Gmail message id is stored as text, so opening a message does not skip it, and a second email about the same matter is a new request.
- If an SMTP send might have succeeded, it is not retried automatically.

## Operate

Prerequisites: Node 24, a dedicated Gmail account with an app password, and a Gemini API key on the free tier with no paid billing. Copy `.env.example` to `.env`. Do not run a second poller on a laptop while the VM is using that inbox.

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run fetch -- --matter M01234 --category "Key Documents"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy.ps1
```

`fetch` does not read mail credentials and does not send email. `deploy.ps1 -UploadEnv` is only for replacing the ignored `.env` on the host. The activation time must stay `2026-10-28T02:03:56.580Z`.

On the VM the service is `/opt/matter-mailer/current`. Logs and ledger:

```bash
docker logs matter-mailer-app-1
docker exec matter-mailer-app-1 node dist/cli.js inspect
```

Doctor and fetch are one-shot commands and cannot run while the poller holds the data lock. Stop it, run the command, then start it again:

```bash
cd /opt/matter-mailer/current
docker compose --env-file .deploy.env stop app
docker compose --env-file .deploy.env run -T --rm --no-deps app node dist/cli.js doctor --live
docker compose --env-file .deploy.env up -d --no-deps app
```

A VM reboot is enough to restart the poller. Docker is enabled at boot, and the container restart policy is `unless-stopped`.
