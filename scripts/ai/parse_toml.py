#!/usr/bin/env python3
"""Parsea TOML con la librería estándar sin imprimir su contenido."""

from __future__ import annotations

import sys
import tomllib
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: parse_toml.py <archivo.toml>", file=sys.stderr)
        return 2
    try:
        with Path(sys.argv[1]).open("rb") as source:
            tomllib.load(source)
    except (OSError, tomllib.TOMLDecodeError) as error:
        print(f"TOML inválido: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
