# Device recovery: local server readiness stopped execution

12 November 2026. [Run 43307137979](https://github.com/alvarovillalbaa/still-markdown/actions/runs/43307137979),
job 131493289351, activation `65838a216f14d99280ec5d2bbd11f087c979f57d`
failed at the local server readiness loop, before either browser case ran.
The checked preparation remains `66c74cfd45a69a239b73e6c0a61b49c81c304e36`.
No recovery or runtime pass is claimed. Node 24.22.2 and the two isolated tool
installation commands exited zero; their six complete original streams remain
in [the packet](device-recovery-attempt-2.zip). The packet is 5,295 bytes,
SHA-256 `78ce5231b75d4015762bf92a9581872093c439c9aafa2ca1e4b32b447d28cf11`.

The controller retained only `AssertionError()` for readiness; the exact HTTP
status/error is missing. The server printed its loopback address with empty
stderr. Source review independently found a real path defect: `fileURLToPath`
preserves the `../public/` directory URL's trailing separator, but the access
check appends another separator. Normal resolved paths cannot start with
`public//`. Normalize the root with `path.resolve` before applying the existing
containment check. This is a source-backed repair; the original missing HTTP
error is not retrospectively invented. The changed controller retains native
HTTP status/body or exception and full tracebacks, checks exact index/icon bytes
and a traversal refusal before launching the same two browser cases.

The failed invocation lasted 28.832 seconds; owned tools used 731,659,651 bytes.
The server was intentionally terminated with SIGTERM/exit -15; all four owned
process groups were absent. The two 47-file source vectors and Git index hashes
matched; owned scratch was removed. Artifact 13982884229 uploaded successfully.
Six original retirement responses in [the job log](device-recovery-attempt-2.log)
show the exact ref check, workflow disable/readback, exact ref deletion/absence
and proof cleanup. Fresh connected ref lookup also returned an empty list.
The permanent verify workflow, app/API/cloud/storage and production data were
not changed. HOME/cache/runner disposal outside owned paths is not attested.
