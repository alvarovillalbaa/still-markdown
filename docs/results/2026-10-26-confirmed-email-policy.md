# Confirmed-email policy update

Owner authorization: consolidate Still and Kickoff in the existing Still
Supabase project on the free plan, keep email verification enabled, and supersede
the earlier deferred immediate-signup policy. Do not configure SMTP or enable
production autoconfirm as part of this source change.

Source changes require `EMAIL_DELIVERY_VERIFIED=true` and live confirmed-email
readiness before signup. Confirmation-pending signup leaves the guest signed out
with no new session or workspace switch. Existing-account sign-in stays available.
Recovery additionally requires `PASSWORD_RECOVERY_ENABLED=true`. Both flags are
false by default. Account copy explains the shared email/password and local logout.

Guest storage, cloud save/conflict queues, editor modules, dependencies, database
contracts, provider settings and the existing local logout behavior are unchanged.
README, architecture and MCP docs identify the separate canonical app SQL owners.

The browser verifier now requires an explicitly supplied, already-confirmed fixture
account through private environment variables. It creates a new page rather than
editing an existing selected page, records data cleanup IDs with `delete_user:
false`, and explicitly excludes signup/SMTP delivery proof.

Verification boundary: focused client tests, syntax/static and whitespace checks
only in this subtask. No install, local build, browser checks, provider SQL,
Auth mutation, migration, commit or publication was performed by this subtask.
The updated browser verifier was not run. Provider consolidation, real confirmation
and recovery delivery, and authenticated cloud/MCP behavior need separate proof.

Checks passed:

- `node --test scripts/cloud.test.mjs`: 21 passed, zero failed or skipped. The
  suite uses mocked HTTP/storage and includes the pending-confirmation and
  delivery/policy gates alongside existing session, conflict, and local logout cases.
- `node scripts/check.mjs`: JavaScript syntax, JSON and browser element references.
- `git diff --check`: no whitespace errors.

## Subsequent provider cutover readback

After the separately recorded database and public browser acceptance, the execution
owner paused the replaced Kickoff project. An independent `Supabase list_projects`
read on 26 October confirmed old Kickoff `lucbdtdsofnybynjpdbp` as `INACTIVE`.
Shared Still `wosqlzijmyiemueoittw` and isolated Welyto `faftywddybmgamvseibe`
were both `ACTIVE_HEALTHY` in `eu-central-1`, and were the only active projects.

The canonical migration, zero-data retirement preflight, deployed bundle,
callbacks and pause evidence remain in
[Kickoff's shared-backend receipt](https://github.com/alvarovillalbaa/kickoff/blob/main/docs/results/2026/10-26/shared-backend.md).
This provider readback does not change the email-delivery and authenticated
transport proof boundaries above.
