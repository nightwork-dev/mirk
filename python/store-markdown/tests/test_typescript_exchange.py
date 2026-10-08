from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from mirk.store_markdown import MarkdownStore

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module", autouse=True)
def build_typescript_adapter() -> None:
    result = subprocess.run(
        ["pnpm", "--filter", "@mirk/store", "build"],
        cwd=REPO,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    result = subprocess.run(
        ["pnpm", "--filter", "@mirk/store-markdown", "build"],
        cwd=REPO,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def node(root: Path, body: str) -> dict[str, object]:
    entry = json.dumps((REPO / "packages/store-markdown/dist/index.js").as_uri())
    script = f"""
import {{ MarkdownStore }} from {entry};
const root = {json.dumps(str(root))};
const store = new MarkdownStore({{
  rootDir: root,
  collections: {{
    stories: {{
      directory: 'stories',
      frontmatterFields: ['title', 'status'],
      body: {{ preambleField: 'intent' }},
      index: {{ heading: 'Roadmap', renderLine: (item) => String(item.id) }},
    }},
  }},
}});
{body}
"""
    result = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=REPO,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_typescript_writes_python_reads_and_typescript_reopens(tmp_path: Path) -> None:
    first = node(
        tmp_path,
        """
store.put('stories', {id: 'DOC-101', title: 'Shared', status: 'todo', intent: 'Original'});
console.log(JSON.stringify(store.getById('stories', 'DOC-101')));
""",
    )
    assert first["id"] == "DOC-101"

    path = tmp_path / "stories" / "DOC-101.md"
    path.write_text(
        path.read_text().replace("status: todo", "status: in-progress\nexternalOwner: python")
    )
    python_store = MarkdownStore(
        tmp_path,
        collections={
            "stories": {
                "directory": "stories",
                "frontmatterFields": ["title", "status"],
                "body": {"preambleField": "intent"},
                "index": {"heading": "Roadmap", "renderLine": lambda item: f"- {item['id']}"},
            }
        },
    )
    assert python_store.getById("stories", "DOC-101")["externalOwner"] == "python"
    python_store.put(
        "stories",
        {"id": "DOC-101", "title": "Shared Again", "status": "done", "intent": "Edited in Python"},
    )
    reopened = node(
        tmp_path, "console.log(JSON.stringify({item: store.getById('stories', 'DOC-101')}));"
    )
    item = reopened["item"]
    assert isinstance(item, dict)
    assert item["status"] == "done"
    assert item["externalOwner"] == "python"


def test_python_writes_typescript_reads(tmp_path: Path) -> None:
    store = MarkdownStore(tmp_path)
    store.put("things", {"id": "one", "value": "from-python"})
    reopened = node(
        tmp_path,
        "console.log(JSON.stringify({item: store.getById('things', 'one')}));",
    )
    assert reopened["item"] == {"id": "one", "value": "from-python"}
