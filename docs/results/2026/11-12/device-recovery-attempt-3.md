# Device recovery: native server repaired, traversal fixture corrected

12 November 2026. [Run 43307809104](https://github.com/alvarovillalbaa/still-markdown/actions/runs/43307809104),
job 131495624616, checked source `84ec99a86735a7d8b158c23ead57917894bad386`,
activation `705784c578ec6794e580781ecf52c9ca9bbd689f`, remains **failed**.
Both browser cases are still UNRUN. The corrected native server returned actual
HTTP 200 and exact source bytes for the icon and index. The added traversal
observer expected 403 for `/%2e%2e/package.json`, but received 404/`Not found`.
The original status and body are retained; no source bytes were exposed.

The server parses requests with `new URL` before decoding the route. The URL
parser removes that encoded dot segment, leaving `/package.json`, a missing
public file. The changed fixture encodes the separating slash as well:
`/%2e%2e%2fpackage.json` reaches the existing decoded-path containment check.
Keep the required 403 and exact-body checks; no product/server code changes or
test removals are made to satisfy this observation. This is a changed observer
candidate, not a replay of an unchanged failure or an accepted browser case.

[Original packet](device-recovery-attempt-3.zip): 12,565 bytes, SHA-256
`905ce0e5b9115a7ec53dfb96cf93c51568b5ab4d660034284733d213be94170a`.
The [full log](device-recovery-attempt-3.log) retains the six successful control
retirement responses. Three commands/six original streams exited zero; server
SIGTERM/exit -15 and all four owned process groups were absent. Source/index
vectors matched; scratch was removed. Duration 12.801 seconds, tools
731,659,648 bytes. No app browser, account, cloud/backend/model/paid or local
heavy operation occurred.
