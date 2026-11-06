from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from typing import Any

from mirk.store.coordination_sqlite import SqliteCoordinator
from test_coordination import ManualClock


def test_mixed_language_fenced_lease_exchange(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[3]
    entry = root / "packages/store/dist/coordination/sqlite.js"
    path = tmp_path / "leases.db"

    def node(now: int) -> dict[str, Any]:
        source = f"""
          import {{createSqliteCoordinator}} from {json.dumps(entry.as_uri())};
          const c = createSqliteCoordinator({{path: process.argv[1], clock: {{
            now: () => {now}, sleep: async () => {{ throw Error('unexpected sleep'); }}
          }}}});
          const r = await c.tryAcquire('key', {{leaseMs: 100}});
          console.log(JSON.stringify(r.status === 'acquired' ? {{status:r.status,
            generation:r.lease.fencingGeneration}} : r)); c.close();
        """
        return json.loads(
            subprocess.run(
                ["node", "--input-type=module", "-e", source, str(path)],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )

    async def run() -> None:
        assert node(1000) == {"status": "acquired", "generation": 1}
        clock = ManualClock()
        c = SqliteCoordinator(path=str(path), clock=clock)
        try:
            assert await c.tryAcquire("key") == {"status": "held", "expiresAt": 1100}
            await clock.advance(100)
            result = await c.tryAcquire("key", leaseMs=100)
            assert result["status"] == "acquired"
            lease = result["lease"]
            assert lease.fencingGeneration == 2
            assert node(1100) == {"status": "held", "expiresAt": 1200}
            assert node(1200) == {"status": "acquired", "generation": 3}
            assert not await lease.release()
        finally:
            c.close()

    asyncio.run(run())


def test_python_processes_contend_for_one_lease(tmp_path: Path) -> None:
    import sys

    path = str(tmp_path / "process.db")
    SqliteCoordinator(path=path).close()
    source = """
import asyncio, json, sys
from mirk.store.coordination_sqlite import SqliteCoordinator
c = SqliteCoordinator(path=sys.argv[1])
print('ready', flush=True)
sys.stdin.readline()
r = asyncio.run(c.tryAcquire('key', leaseMs=10000))
print(json.dumps({'status': r['status']}), flush=True)
c.close()
"""
    children = [
        subprocess.Popen(
            [sys.executable, "-c", source, path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(2)
    ]
    try:
        for child in children:
            assert child.stdout and child.stdin
            assert child.stdout.readline().strip() == "ready"
        for child in children:
            assert child.stdin
            child.stdin.write("go\n")
            child.stdin.flush()
        statuses: list[str] = []
        for child in children:
            output, error = child.communicate(timeout=5)
            assert child.returncode == 0, error
            statuses.append(json.loads(output)["status"])
        assert statuses.count("acquired") == 1
        assert set(statuses) <= {"acquired", "held", "unavailable"}
        c = SqliteCoordinator(path=path)
        try:
            assert asyncio.run(c.tryAcquire("key"))["status"] == "held"
        finally:
            c.close()
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
                child.wait()
