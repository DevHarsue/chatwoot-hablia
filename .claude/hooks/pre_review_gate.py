#!/usr/bin/env python3
"""Adaptador histórico de Claude para el gate portable de pre-review."""

from pathlib import Path
import os
import sys


CORE = Path(__file__).resolve().parents[2] / "scripts" / "ai" / "pre_review_gate.py"
os.execv(sys.executable, [sys.executable, str(CORE), *sys.argv[1:]])
