#!/usr/bin/env python3
"""Pruebas deterministas del gate portable de pre-review."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts" / "ai" / "pre_review_gate.py"
HASH = ROOT / "scripts" / "ai" / "diff_hash.py"
CLAUDE_GATE = ROOT / ".claude" / "hooks" / "pre_review_gate.py"
CLAUDE_HASH = ROOT / ".claude" / "hooks" / "diff_hash.py"
CLAUDE_SETTINGS = ROOT / ".claude" / "settings.json"


def run(args: list[str], cwd: Path, **kwargs: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True, **kwargs)


def run_gate(
    repo: Path, payload: dict[str, object], entrypoint: Path = GATE
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(entrypoint)],
        cwd=repo,
        text=True,
        input=json.dumps(payload),
        capture_output=True,
        check=False,
    )


def current_hash(repo: Path) -> str:
    return run([sys.executable, str(HASH), "main"], repo).stdout.strip()


def create_repo(parent: Path, name: str = "repo") -> Path:
    repo = parent / name
    repo.mkdir()
    run(["git", "init", "-b", "main"], repo)
    run(["git", "config", "user.email", "tests@example.com"], repo)
    run(["git", "config", "user.name", "Hook tests"], repo)
    (repo / "tracked.txt").write_text("base\n", encoding="utf-8")
    run(["git", "add", "tracked.txt"], repo)
    run(["git", "commit", "-m", "base"], repo)
    run(["git", "switch", "-c", "feature/hook-test"], repo)
    (repo / "tracked.txt").write_text("feature\n", encoding="utf-8")
    run(["git", "add", "tracked.txt"], repo)
    run(["git", "commit", "-m", "feature"], repo)
    return repo


def write_marker(repo: Path) -> None:
    marker = repo / ".agents" / ".pre-review-passed"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"main:{current_hash(repo)}\n", encoding="utf-8")


def assert_code(result: subprocess.CompletedProcess[str], expected: int, label: str) -> None:
    if result.returncode != expected:
        raise AssertionError(f"{label}: esperado {expected}, obtuvo {result.returncode}: {result.stderr}")


def assert_adapters() -> None:
    for wrapper, core_name in (
        (ROOT / ".claude" / "hooks" / "diff_hash.py", "diff_hash.py"),
        (CLAUDE_GATE, "pre_review_gate.py"),
    ):
        if f'scripts" / "ai" / "{core_name}"' not in wrapper.read_text(encoding="utf-8"):
            raise AssertionError(f"{wrapper}: el wrapper no referencia su core portable")

    config = (ROOT / ".codex" / "config.toml").read_text(encoding="utf-8")
    required_fragments = (
        "[[hooks.PreToolUse]]",
        'matcher = "^Bash$"',
        "[[hooks.PreToolUse.hooks]]",
        'type = "command"',
        "pre_review_gate.py",
        "command_windows =",
    )
    if not all(fragment in config for fragment in required_fragments):
        raise AssertionError(".codex/config.toml: falta el handler portable de pre-review")

    settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    registrations = settings.get("hooks", {}).get("PreToolUse", [])
    if not any(
        registration.get("matcher") == "Bash"
        and any(
            hook.get("type") == "command"
            and "pre_review_gate.py" in hook.get("command", "")
            for hook in registration.get("hooks", [])
        )
        for registration in registrations
        if isinstance(registration, dict)
    ):
        raise AssertionError(".claude/settings.json: falta registrar PreToolUse/Bash para el gate portable")


def main() -> int:
    assert_adapters()
    with tempfile.TemporaryDirectory(prefix="hablia-pre-review-") as temporary:
        parent = Path(temporary)
        repo = create_repo(parent)
        push = {"tool_input": {"command": "git push origin feature/hook-test"}}

        assert_code(run_gate(repo, push), 2, "bloquea push sin marcador")
        assert_code(
            run_gate(repo, {"tool_input": {"command": "gh pr create --base main"}}),
            2,
            "bloquea PR sin marcador",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "env git push origin feature/hook-test"}}),
            2,
            "bloquea push con env sin marcador",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "env gh pr create --base main"}}),
            2,
            "bloquea PR con env sin marcador",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "env SAFE=1 git push origin feature/hook-test"}},
            ),
            2,
            "rechaza env con argumentos antes del push",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "command -- gh pr create --base main"}},
            ),
            2,
            "rechaza command con argumentos antes del PR",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "sudo git push origin feature/hook-test"}},
            ),
            2,
            "rechaza un wrapper de privilegios antes del push",
        )
        protected = create_repo(parent, "rama protegida")
        run(["git", "switch", "main"], protected)
        assert_code(
            run_gate(
                protected,
                {"tool_input": {"command": "git push origin feature/no-revisada"}},
            ),
            2,
            "rechaza publicar desde una rama protegida",
        )
        run(["git", "switch", "-c", "develop"], protected)
        assert_code(
            run_gate(
                protected,
                {"tool_input": {"command": "git push origin feature/no-revisada"}},
            ),
            2,
            "rechaza publicar desde develop",
        )
        run(["git", "switch", "main"], protected)
        run(["git", "switch", "-c", "release/1.0"], protected)
        assert_code(
            run_gate(
                protected,
                {"tool_input": {"command": "git push origin feature/no-revisada"}},
            ),
            2,
            "rechaza publicar desde una release",
        )
        write_marker(repo)
        assert_code(run_gate(repo, push), 0, "permite payload Claude con marcador válido")
        assert_code(
            run_gate(repo, {"tool_input": {"command": "git push origin"}}),
            2,
            "rechaza push sin fuente literal revisada",
        )
        assert_code(
            run_gate(repo, push, CLAUDE_GATE),
            0,
            "el wrapper de Claude ejecuta el mismo core",
        )
        if run([sys.executable, str(CLAUDE_HASH), "main"], repo).stdout.strip() != current_hash(repo):
            raise AssertionError("el wrapper de hash de Claude no coincide con el core")
        assert_code(
            run_gate(repo, {"input": {"command": "git push origin feature/hook-test"}}),
            0,
            "permite payload alternativo del cliente",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "git push --tags"}}),
            2,
            "rechaza publicar tags aun con marcador válido",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "git push --delete origin stale"}},
            ),
            2,
            "rechaza borrar refs aun con marcador válido",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "git push -d origin stale"}}),
            2,
            "rechaza borrar refs con la opción corta",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "git push -f origin feature/hook-test"}}),
            2,
            "rechaza force-push con la opción corta",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "git push origin :stale"}},
            ),
            2,
            "rechaza un refspec de borrado",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "git push origin HEAD:refs/tags/v1"}},
            ),
            2,
            "rechaza un refspec de tag",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "git push origin HEAD:main"}},
            ),
            2,
            "rechaza publicar hacia main",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "git push origin feature/hook-test:develop"}},
            ),
            2,
            "rechaza publicar hacia develop",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "git push origin HEAD:release/1.0"}},
            ),
            2,
            "rechaza publicar hacia una release",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "git push origin main"}}),
            2,
            "rechaza publicar desde main",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "git push origin refs/heads/develop"}}),
            2,
            "rechaza publicar desde develop con ref explícita",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "git push origin main:feature/permitida"}},
            ),
            2,
            "rechaza usar main como fuente de un refspec",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "git push origin refs/tags/v1:feature/unreviewed"}},
            ),
            2,
            "rechaza usar un tag como fuente de un refspec",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "git push origin tag-v1"}}),
            2,
            "rechaza publicar una fuente distinta a la rama revisada",
        )
        assert_code(
            run_gate(
                repo,
                {"tool_input": {"command": "git push origin +HEAD:feature/hook-test"}},
            ),
            2,
            "rechaza un refspec forzado",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "git push --mirror origin"}}),
            2,
            "rechaza mirror push",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": "echo forged > .agents/.pre-review-passed"}}),
            2,
            "bloquea escritura shell directa del marcador",
        )
        assert_code(
            run_gate(repo, {"tool_input": {"command": 'git -C "$REPO" push origin feature/hook-test'}}),
            2,
            "rechaza rutas de shell no verificables",
        )
        marker = repo / ".agents" / ".pre-review-passed"
        marker.write_text(f"missing-base:{current_hash(repo)}\n", encoding="utf-8")
        assert_code(run_gate(repo, push), 2, "falla cerrado con una base inválida")
        write_marker(repo)

        (repo / "tracked.txt").write_text("changed after review\n", encoding="utf-8")
        run(["git", "add", "tracked.txt"], repo)
        run(["git", "commit", "-m", "changed"], repo)
        assert_code(run_gate(repo, push), 2, "invalida marcador cuando cambia el diff")

        spaced = create_repo(parent, "repo con espacios")
        write_marker(spaced)
        command = f"git -C '{spaced}' push origin feature/hook-test"
        assert_code(
            run_gate(parent, {"tool_input": {"command": command}}),
            0,
            "resuelve una ruta literal con espacios",
        )
        assert_code(
            run_gate(
                parent,
                {
                    "tool_input": {
                        "command": (
                            f"git -C '{spaced}' -C '{repo}' push origin feature/hook-test"
                        )
                    }
                },
            ),
            2,
            "rechaza múltiples rutas Git candidatas",
        )
        assert_code(
            run_gate(
                parent,
                {
                    "tool_input": {
                        "command": (
                            f"cd '{spaced}'; cd '{repo}'; git push origin feature/hook-test"
                        )
                    }
                },
            ),
            2,
            "rechaza múltiples directorios shell candidatos",
        )
    print("OK: gate portable de pre-review validado")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
