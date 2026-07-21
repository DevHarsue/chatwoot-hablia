#!/usr/bin/env python3
"""Calcula el hash portable del diff de una rama.

Uso:
  python3 scripts/ai/diff_hash.py [--repo RUTA] BASE

El resultado se usa por el gate de pre-review y por ambos adaptadores de
cliente. Trabaja sobre bytes crudos para que el hash no cambie por la
codificación o el final de línea del sistema operativo.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path


class DiffHashError(RuntimeError):
    """La base solicitada no produce un diff verificable."""


def diff_hash(base: str, cwd: str | Path | None = None) -> str:
    process = subprocess.run(
        ["git", "diff", f"{base}...HEAD"],
        cwd=cwd,
        capture_output=True,
        check=False,
    )
    if process.returncode != 0:
        details = (process.stderr or b"").decode("utf-8", "replace").strip()
        raise DiffHashError(details or f"git diff falló contra {base}")
    return hashlib.sha256((process.stdout or b"").strip()).hexdigest()


def usage() -> int:
    sys.stderr.write("uso: diff_hash.py [--repo RUTA] <BASE>\n")
    return 2


def main(argv: list[str]) -> int:
    args = list(argv)
    cwd: str | Path | None = None
    if args[:1] == ["--repo"]:
        if len(args) != 3:
            return usage()
        cwd = args[1]
        args = args[2:]
    if len(args) != 1:
        return usage()
    try:
        print(diff_hash(args[0], cwd))
    except DiffHashError as error:
        sys.stderr.write(f"diff_hash.py: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
