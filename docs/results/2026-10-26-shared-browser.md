# Shared-backend guest and account browser checks

26 October 2026. The publication owner executed these focused Chrome checks on [Still production](https://still-markdown.vercel.app/) under the owner's consolidation-check approval. This receipt is written from that operator's observed results. Production functional revision `9a789b4` was ready during the check.

## Disposable guest-page verification

The operator created one new page through the New Page UI, leaving existing drafts untouched:

- Title: `Shared backend QA 1793043079217`
- Body: `Temporary verification page. Delete after the shared-backend check.`

After entering that content, the operator reloaded the full page URL and verified that both the title and body still matched. Before cleanup, a fresh check confirmed that the selected page title was exactly the owned fixture title. The operator then used the page's Delete confirmation UI. Searching for that exact title returned “No pages found. Try another word.” The modal was closed and the search cleared afterward.

No existing page content was read or modified, and browser storage was not cleared. An earlier delegated browser call was interrupted after about 1,014 seconds without results or any Still fixture creation; the publication owner stopped that attempt and performed the checks above directly.

## Account controls and responsive layout

| Check | Observed result |
| --- | --- |
| Sign-up control | Submission was disabled with the delivery-pending notice. No account or email request was created. |
| Existing-account sign-in | The Sign In tab remained enabled and the dialog explained the shared Kickoff/Still identity. No credentials were entered or submitted. |
| Desktop width | Browser inner width and document width were both 1440 px. |
| Narrow mobile width | Browser inner width and document width were both 390 px; the account dialog was 358 px wide. |

The checked desktop and mobile states had no horizontal overflow. The browser viewport override was reset at the end. The current account policy is documented in [the confirmed-email receipt](2026-10-26-confirmed-email-policy.md).

## Proof boundary

This verifies the public client, persistence and cleanup of one explicitly owned guest fixture, and the displayed account gates. Real Auth/JWT sessions, password-recovery delivery, SMTP, authenticated MCP transport and simultaneous-client behavior remain unverified by this check. No SMTP action occurred.

The separate 28-group database acceptance, provider URL configuration and old-project retirement evidence belong to [Kickoff's shared-backend receipt](https://github.com/alvarovillalbaa/kickoff/blob/main/docs/results/2026/10-26/shared-backend.md). Those results are not inferred from this guest-page check.
