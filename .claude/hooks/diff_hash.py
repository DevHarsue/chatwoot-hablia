#!/usr/bin/env python3
"""Adaptador histórico de Claude para el hash portable del diff."""

from pathlib import Path
import os
import sys


CORE = Path(__file__).resolve().parents[2] / "scripts" / "ai" / "diff_hash.py"
os.execv(sys.executable, [sys.executable, str(CORE), *sys.argv[1:]])
