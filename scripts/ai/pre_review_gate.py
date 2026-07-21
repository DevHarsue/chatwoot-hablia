#!/usr/bin/env python3
"""Gate portable de pre-review para comandos de GitHub y Git.

Recibe el evento JSON de un hook por stdin. La parte reutilizable no conoce
clientes: extrae el comando de las formas de payload soportadas y valida el
marcador local ``.agents/.pre-review-passed`` antes de permitir un ``git push``
de una rama de trabajo o un ``gh pr create``.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

from diff_hash import DiffHashError, diff_hash


MARKER_RELATIVE_PATH = Path(".agents") / ".pre-review-passed"


def block(message: str) -> None:
    sys.stderr.write(f"{message}\n")
    raise SystemExit(2)


def run(args: list[str], cwd: str | None = None) -> tuple[int, str]:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return result.returncode, (result.stdout or "").strip()
    except (OSError, subprocess.SubprocessError):
        return 1, ""


def command_from_payload(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    for key in ("tool_input", "toolInput", "input", "arguments"):
        candidate = payload.get(key)
        if isinstance(candidate, dict) and isinstance(candidate.get("command"), str):
            return candidate["command"]
    command = payload.get("command")
    return command if isinstance(command, str) else ""


def command_target_path(command: str) -> str | None:
    quoted = r'("[^"]+"|\'[^\']+\'|[^\s&|;]+)'
    git_candidates: list[re.Match[str]] = []
    for push_segment in re.finditer(r"\bgit\b[^&|;\n]*\spush(?=\s|$)", command):
        git_candidates.extend(
            re.finditer(rf"\s-C\s+{quoted}", push_segment.group(0))
        )
    shell_candidates = list(
        re.finditer(rf"(?<![A-Za-z0-9_.-])cd\s+{quoted}", command)
    )
    candidates = [*git_candidates, *shell_candidates]
    if not candidates:
        return None
    if len(candidates) != 1:
        block(
            "BLOCKED: el push/PR tiene más de un directorio candidato. "
            "Ejecutalo desde el repositorio o usá un único git -C literal."
        )
    candidate = candidates[0].group(1).strip("\"'")
    if "$" in candidate or "%" in candidate:
        block(
            "BLOCKED: el push/PR usa una ruta con variable de shell. "
            "Ejecutalo desde el repo o usa una ruta literal para verificar el destino."
        )
    return candidate


def effective_base(base: str, cwd: str | None) -> str:
    if base.startswith("origin/"):
        return base
    if run(["git", "rev-parse", "--verify", f"origin/{base}"], cwd)[0] == 0:
        return f"origin/{base}"
    return base


def is_direct_marker_write(command: str) -> bool:
    marker = r"(?:\.agents|\.claude)/\.pre-review-passed\b"
    return bool(re.search(rf"(?:>>?|\btee\b)[^\n]*?{marker}", command))


def push_uses_reviewed_source(command: str, branch: str) -> bool:
    match = re.search(r"\bgit\b[^&|;\n]*\spush(?=\s|$)(?P<args>[^&|;\n]*)", command)
    if not match:
        return False
    try:
        arguments = shlex.split(match.group("args"), comments=True)
    except ValueError:
        return False

    index = 0
    while index < len(arguments) and arguments[index].startswith("-"):
        if arguments[index] not in {"-u", "--set-upstream"}:
            return False
        index += 1
    if index >= len(arguments) or arguments[index] != "origin":
        return False
    refspecs = arguments[index + 1 :]
    if not refspecs:
        return False
    if len(refspecs) != 1:
        return False
    return refspecs[0] in {"HEAD", branch, f"refs/heads/{branch}"}


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        return 0
    command = command_from_payload(payload)
    if not command:
        return 0

    if is_direct_marker_write(command):
        block(
            "BLOCKED: no se permite escribir el marcador directamente. "
            "Ejecutá el flujo pre-review para generar una evidencia válida."
        )

    if re.search(
        r"(^|[&|;\n])\s*(?:sudo|doas|nice|nohup|time)(?:\s+[^\s&|;]+)*\s+(?:git|gh)\b",
        command,
    ):
        block(
            "BLOCKED: no se permiten wrappers de proceso para publicar. "
            "Ejecutá git o gh directamente, o usá las formas literales documentadas."
        )
    if re.search(
        r"(^|[&|;(\n])\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s&|;]+\s+|"
        r"(?:exec|noglob|nocorrect|builtin)\s+|"
        r"(?:/[A-Za-z0-9._-]+)+/(?:git|gh)\b)",
        command,
    ):
        block(
            "BLOCKED: no se permiten launchers alternos para publicar. "
            "Ejecutá git o gh directamente, o usá las formas literales documentadas."
        )

    direct_prefix = r"(?:(?:env|command)(?:\s+[^\s&|;]+)*\s+)?"
    is_push = bool(
        re.search(
            rf"(^|[&|;(\n])\s*{direct_prefix}git\b[^&|;\n]*\spush(?=\s|$)",
            command,
        )
    )
    is_pr = bool(
        re.search(rf"(^|[&|;\n])\s*{direct_prefix}gh\s+pr\s+create\b", command)
    )
    if not is_push and not is_pr:
        return 0
    operation_count = len(
        re.findall(
            r"\bgit\b[^&|;\n]*\spush(?=\s|$)|\bgh\s+pr\s+create\b",
            command,
        )
    )
    if operation_count != 1:
        block(
            "BLOCKED: el comando contiene más de una publicación. "
            "Ejecutá cada push o creación de PR por separado."
        )
    if re.search(
        r"(^|[&|;\n])\s*(?:env|command)\s+(?!git\b|gh\b)", command
    ):
        block(
            "BLOCKED: el wrapper de publicación usa argumentos no verificables. "
            "Ejecutá git o gh directamente, o usá `env git` / `command git`."
        )
    if is_push and re.search(r"--(?:git-dir|work-tree)(?:=|\s)", command):
        block(
            "BLOCKED: el push no puede seleccionar otro repositorio con --git-dir "
            "ni --work-tree. Ejecutalo desde el worktree revisado."
        )
    if is_push and re.search(
        r"(?:--(?:tags|delete|all|mirror|force(?:-with-lease)?)(?:=|\s|$)|"
        r"-[df](?:\s|$)|\s+[+][^\s&|;]+|\s+:[^\s&|;]+|:refs/tags/|"
        r":(?:refs/heads/)?(?:main|develop|release/[^\s&|;]+)|"
        r"\s+(?:refs/heads/)?(?:main|develop|release/[^\s&|;]+)(?=[:\s]|$))",
        command,
        re.IGNORECASE,
    ):
        block(
            "BLOCKED: el push incluye tags, borrados, opciones destructivas o una "
            "rama protegida como destino. Usá el flujo de release o el PR aprobado."
        )
    cwd = command_target_path(command)
    rc, repository_root = run(["git", "rev-parse", "--show-toplevel"], cwd)
    if rc != 0 or not repository_root:
        block("BLOCKED: no pude determinar la raíz del repositorio para el gate de pre-review.")

    rc, branch = run(["git", "branch", "--show-current"], cwd)
    if is_push and (branch in {"main", "develop"} or branch.startswith("release/")):
        block(
            "BLOCKED: no se permite push directo desde una rama protegida. "
            "Usá una rama de trabajo y el PR correspondiente."
        )
    if is_push and not push_uses_reviewed_source(command, branch):
        block(
            "BLOCKED: el push debe usar HEAD o la rama actual revisada como única fuente "
            "y publicar mediante origin."
        )

    marker_path = Path(repository_root) / MARKER_RELATIVE_PATH
    try:
        marker = marker_path.read_text(encoding="utf-8").strip()
    except OSError:
        block(
            "BLOCKED: pre-review requerido antes de push/PR. "
            "Ejecutá el skill pre-review y reintentá solo cuando el veredicto sea PASS."
        )

    marker_base, separator, stored_hash = marker.partition(":")
    if not separator or not marker_base or not stored_hash:
        block("BLOCKED: el marcador de pre-review es inválido; ejecutá pre-review nuevamente.")

    base = effective_base(marker_base, cwd)
    try:
        current_hash = diff_hash(base, cwd)
    except DiffHashError:
        block(
            "BLOCKED: no pude calcular el diff contra la base registrada. "
            "Ejecutá pre-review nuevamente con una base verificable."
        )
    if current_hash != stored_hash:
        block(
            "BLOCKED: el diff cambió desde el último pre-review.\n"
            f"  guardado: {stored_hash[:12]}...\n"
            f"  actual:   {current_hash[:12]}...  (base {base})\n"
            "Volvé a ejecutar pre-review antes de push o PR."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
