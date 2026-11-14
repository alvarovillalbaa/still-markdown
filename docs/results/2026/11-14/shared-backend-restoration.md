# Shared free backend restored

On14November2026, the existing Still project wosqlzijmyiemueoittw in Clous was
restored from INACTIVE through COMING_UP to ACTIVE_HEALTHY. It is the approved
shared backend for Still and Kickoff. Clous remained on the free plan; no new
project, pause of another project or paid enrollment occurred. Provider inventory
shows only this project's state changed; retired Kickoff remains INACTIVE.

Before restoration, Still's public health endpoint returned503. Its effective
public config and Kickoff's actual served391157B bundle both point only to the
shared project; the retired Kickoff reference is absent. The restore request was
accepted once. During startup, health503 and catalog521 were retained as interim
observations; no second restore was issued. Once provider status became healthy,
Still health and Kickoff's anonymous stable catalog RPC both returned200.
The public catalog contains zero centers, fields, slots and matches.

Published configuration is byte-equivalent before/after restoration. Email
confirmation remains required, while emailDeliveryVerified and password recovery
stay false. No signup, account creation, email/provider message, migration,
role/policy change, schema install, private data query or fixture write occurred.
Postgres remained17.11.0.003. The app health response still identifies its existing
served1d6ecadf revision; this operation did not redeploy application code.

This proves restored provider/Auth/catalog availability, not real signup/email
delivery, account sync, authenticated MCP, reservations, concurrency or all private
data integrity. Existing guest/editor/recovery checks were not replayed. No local
install/build/runtime or new CI is needed for this operational check. The normal
permanent verification workflow and its docs-only push exclusions are unchanged.

The local Still checkout has four unpublished commits beyond its cached origin.
It was read only and remains on5fd33a95; no switch, reset, merge, push or overwrite
of that work occurred. This documentation is appended directly to the canonical
GitHub base1d6ecadf using a non-force expected-head update. It contains no app,
configuration, dependency or CI edits. See shared-backend-restoration.json for
actual before/startup/healthy outcomes and source bindings.

Supabase documents that [free projects may pause after low activity](https://supabase.com/docs/guides/platform/free-project-pausing)
and [paused projects do not occupy active free-project quota](https://supabase.com/docs/guides/platform/billing-faq).
Restoring availability does not establish continuous uptime. No keepalive or plan
change is introduced. The current pause guide and older MCP search result differ
on restore-window wording; this project was created20October and fits both, so
that discrepancy does not affect this restoration.
