# Device recovery: first activation rejected

12 November 2026. Run [43306775078](https://github.com/alvarovillalbaa/still-markdown/actions/runs/43306775078)
ended `failure` at activation `1de619f8423122371bc1eabae22ec4c300c609ad`,
workflow 416577013, attempt 1, with zero jobs. Both cases are **UNRUN**.
The CLI reports a likely workflow-file issue; no runner/controller/browser
log or test failure exists. The original activation and preparation
`66c74cfd45a69a239b73e6c0a61b49c81c304e36` remain immutable.

Source review found `${{ runner.temp }}` in `jobs.recovery.env`. GitHub's
[context availability contract](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)
does not allow `runner` in job-level env; it allows it in step env and step
inputs. Move the proof directory to those scopes. This is a source-backed
workflow repair, not a retained GitHub annotation proving the rejection cause:
the check suite had zero check runs, and public-page retrieval failed.

The changed activation preserves the browser/controller/application inputs,
same ten-minute budget and exact owned branch. It starts a new push run, never
reruns the failed attempt. No account, app, production or local runtime change.
Its terminal cleanup will disable only this workflow and remove the exact ref.
