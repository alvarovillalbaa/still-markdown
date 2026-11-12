"""One owned CI invocation; not a local test entry point."""
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import traceback
import urllib.error
import urllib.request
import zipfile

assert os.environ.get("GITHUB_ACTIONS") == "true"
assert os.environ["GITHUB_REPOSITORY"] == "alvarovillalbaa/still-markdown"
assert os.environ["GITHUB_REF"] == "refs/heads/qa/still-device-recovery-20261112-3"
source = Path.cwd()
temporary = Path(os.environ["RUNNER_TEMP"]).resolve()
root = temporary / f"still-recovery-{os.environ['GITHUB_RUN_ID']}"
proof = Path(os.environ["STILL_RECOVERY_PROOF"]).resolve()
assert root.parent == temporary and proof.parent == temporary
assert not root.exists() and not proof.exists()
assert shutil.disk_usage(temporary).free >= 4 * 1024**3
root.mkdir(mode=0o700)
proof.mkdir(mode=0o700)
(root / "owner.json").write_text(json.dumps({"run": os.environ["GITHUB_RUN_ID"], "source": os.environ["EXPECTED_SOURCE"]}))
started = time.monotonic()
receipt = {"version": 1, "source": os.environ["EXPECTED_SOURCE"], "activation": os.environ["GITHUB_SHA"],
           "commands": [], "groups": [], "success": False}
env = dict(os.environ, PLAYWRIGHT_BROWSERS_PATH=str(root / "browsers"),
           npm_config_cache=str(root / "npm-cache"), npm_config_update_notifier="false")
server = None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def snapshot():
    names = subprocess.check_output(["git", "ls-files", "-z"]).split(b"\0")
    result = []
    for name in filter(None, names):
        relative = name.decode()
        file = source / relative
        assert file.is_file() and not file.is_symlink()
        data = file.read_bytes()
        result.append({"path": relative, "bytes": len(data), "sha256": digest(data), "mode": file.stat().st_mode & 0o777})
    return result


def group_absent(pgid):
    try:
        os.killpg(pgid, 0)
        return False
    except ProcessLookupError:
        return True


def command(args, limit=90):
    assert len(receipt["commands"]) < 10
    remaining = 420 - (time.monotonic() - started)
    assert remaining > 0
    process = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    entry = {"argv": args, "pid": process.pid}
    receipt["commands"].append(entry)
    try:
        stdout, stderr = process.communicate(timeout=min(limit, remaining))
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate(timeout=5)
        entry["timedOut"] = True
    for label, data in [("stdout", stdout), ("stderr", stderr)]:
        name = f"command-{len(receipt['commands'])}-{label}.bin"
        (proof / name).write_bytes(data)
        entry[label] = {"file": name, "bytes": len(data), "sha256": digest(data), "complete": True}
        assert len(data) <= 2 * 1024**2
    entry["exit"] = process.returncode
    entry["groupAbsent"] = group_absent(process.pid)
    receipt["groups"].append(process.pid)
    assert process.returncode == 0 and entry["groupAbsent"] and not entry.get("timedOut"), entry


try:
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    assert actual == receipt["source"]
    receipt["sourceBefore"] = snapshot()
    receipt["indexBefore"] = digest(subprocess.check_output(["git", "ls-files", "--stage", "-z"]))
    assert subprocess.check_output(["git", "status", "--porcelain"]) == b""
    command(["node", "--version"])
    assert (proof / "command-1-stdout.bin").read_text().strip() == "v24.22.2"
    command(["npm", "install", "--prefix", str(root / "tools"), "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts", "playwright@1.61.1"], 100)
    command(["node", str(root / "tools/node_modules/playwright/cli.js"), "install", "chromium"], 150)
    assert shutil.disk_usage(temporary).free >= 2 * 1024**3
    receipt["scratchBytes"] = sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink())
    assert receipt["scratchBytes"] <= 2 * 1024**3
    stdout_file = (proof / "server-stdout.bin").open("wb")
    stderr_file = (proof / "server-stderr.bin").open("wb")
    server = subprocess.Popen(["node", "scripts/dev.mjs"], env=env, stdout=stdout_file, stderr=stderr_file, start_new_session=True)
    receipt["server"] = {"pid": server.pid}
    deadline = time.monotonic() + 15
    receipt["readiness"] = []
    while True:
        assert server.poll() is None
        try:
            with urllib.request.urlopen("http://127.0.0.1:3210/favicon.svg", timeout=1) as response:
                body = response.read(1_048_577)
                assert len(body) <= 1_048_576
                receipt["readiness"].append({"status": response.status, "bytes": len(body), "sha256": digest(body)})
                assert response.status == 200
                assert body == (source / "public/favicon.svg").read_bytes()
            break
        except urllib.error.HTTPError as error:
            body = error.read(1_048_577)
            receipt["readiness"].append({"status": error.code, "body": base64.b64encode(body).decode()})
            raise
        except OSError as error:
            receipt["readiness"].append({"error": repr(error)})
            assert time.monotonic() < deadline
            time.sleep(0.2)
    receipt["http"] = []
    for route, expected in [("/", 200), ("/%2e%2e%2fpackage.json", 403)]:
        try:
            with urllib.request.urlopen("http://127.0.0.1:3210" + route, timeout=3) as response:
                status, body = response.status, response.read(1_048_577)
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read(1_048_577)
        assert len(body) <= 1_048_576
        receipt["http"].append({"route": route, "status": status, "body": base64.b64encode(body).decode(), "sha256": digest(body)})
        assert status == expected
        if route == "/":
            assert body == (source / "public/index.html").read_bytes()
    env["PLAYWRIGHT_MODULE"] = str(root / "tools/node_modules/playwright/index.mjs")
    env["STILL_RECOVERY_OUT"] = str(proof)
    command(["node", "scripts/device-recovery-browser.mjs"], 135)
    browser = json.loads((proof / "browser.json").read_text())
    assert browser["success"] and browser["browserClosed"]
    assert [c["id"] for c in browser["cases"] if c["passed"] and c["contextClosed"]] == ["R01", "R02"]
    receipt["success"] = True
except BaseException as error:
    receipt["error"] = repr(error)
    receipt["traceback"] = traceback.format_exc()
finally:
    try:
        if server:
            assert server.poll() is None, "Server stopped before owned shutdown"
            os.killpg(server.pid, signal.SIGTERM)
            receipt["server"]["exit"] = server.wait(timeout=8)
            stdout_file.close()
            stderr_file.close()
            receipt["server"]["groupAbsent"] = group_absent(server.pid)
            assert receipt["server"]["exit"] == -signal.SIGTERM and receipt["server"]["groupAbsent"]
        receipt["sourceAfter"] = snapshot()
        receipt["indexAfter"] = digest(subprocess.check_output(["git", "ls-files", "--stage", "-z"]))
        assert receipt["sourceBefore"] == receipt["sourceAfter"]
        assert receipt["indexBefore"] == receipt["indexAfter"]
        assert all(group_absent(pgid) for pgid in receipt["groups"])
        assert json.loads((root / "owner.json").read_text())["run"] == os.environ["GITHUB_RUN_ID"]
        shutil.rmtree(root)
        receipt["scratchAbsent"] = not root.exists()
        assert receipt["scratchAbsent"]
    except BaseException as error:
        receipt["cleanupError"] = repr(error)
        receipt["success"] = False
    receipt["elapsedSeconds"] = time.monotonic() - started
    (proof / "controller.json").write_text(json.dumps(receipt, indent=2) + "\n")
    files = sorted(proof.iterdir())
    assert len(files) <= 150 and all(p.is_file() and not p.is_symlink() for p in files)
    assert sum(p.stat().st_size for p in files) <= 16 * 1024**2
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, file.name)
    packet = output.getvalue()
    assert len(packet) <= 3 * 1024**2
    print("STILL_RECOVERY_PACKET_BEGIN", digest(packet), len(packet), flush=True)
    encoded = base64.b64encode(packet).decode()
    for index in range(0, len(encoded), 20_000):
        print(encoded[index:index + 20_000], flush=True)
    print("STILL_RECOVERY_PACKET_END", flush=True)
    print(json.dumps({"success": receipt["success"], "elapsedSeconds": receipt["elapsedSeconds"]}), flush=True)
raise SystemExit(0 if receipt["success"] else 1)
