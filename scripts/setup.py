#!/usr/bin/env python3
"""Установка и офлайн-проверка скилла aghanim-offer-building.

Одна команда, кросс-платформенно (Windows / macOS / Linux):
    python  setup.py           (Windows)
    python3 setup.py           (macOS / Linux)

Что делает:
  * проверяет себя и окружение: Python >= 3.9, наличие node и git,
    состав файлов на диске;
  * запускает офлайн-селфтесты рабочих скриптов (сеть не нужна):
        node   scripts/build-aghanim-import.mjs --selftest
        python scripts/fetch-aghanim-hub.py --selftest

Код выхода: 0 — всё зелёное; 1 — есть FAIL в проверке команд.
Зависимости: только стандартная библиотека Python 3.9+.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MIN_PY = (3, 9)
TIMEOUT = 300

USAGE = """Использование:
    python setup.py           проверка окружения + офлайн-селфтесты скриптов
    python setup.py --help    эта справка"""

# Ожидаемые файлы скилла. Ищем и в scripts/, и рядом с setup.py.
EXPECTED_FILES = [
    "SKILL.md", "setup.py", ".gitignore",
    "catalog/aghanim-check.sha256", "catalog/client.json", "catalog/hubs.json",
    "catalog/image-api.json", "catalog/live.json", "catalog/sandbox.json",
    "references/how-it-works.generated.md",
    "scripts/aghanim-check", "scripts/build-aghanim-import.mjs",
    "scripts/fetch-aghanim-hub.py",
]

results: list[tuple[bool, str]] = []


def check(ok: bool, title: str, detail: str = "") -> bool:
    print(f"[{'PASS' if ok else 'FAIL'}] {title}" + (f" — {detail}" if detail else ""))
    results.append((ok, title))
    return ok


def find_file(rel: str) -> Path | None:
    """Ищет файл по пути rel, затем по его имени рядом с setup.py."""
    for cand in (ROOT / rel, ROOT / Path(rel).name):
        if cand.exists():
            return cand
    return None


def run_step(cmd: list[str], title: str, timeout: int = TIMEOUT) -> None:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        check(False, title, f"не удалось запустить: {exc}")
        return
    except subprocess.TimeoutExpired:
        check(False, title, f"превышен таймаут {timeout} с")
        return
    tail = (proc.stdout or proc.stderr or "").strip().splitlines()
    check(proc.returncode == 0, title,
          tail[-1] if tail else f"код выхода {proc.returncode}")


def run_checks() -> None:
    print("Проверка окружения\n")

    check(sys.version_info >= MIN_PY, f"Python >= {MIN_PY[0]}.{MIN_PY[1]}",
          f"установлен {sys.version_info.major}.{sys.version_info.minor}."
          f"{sys.version_info.micro}")
    node = shutil.which("node")
    check(bool(node), "node в PATH", node or "не найден — поставьте Node.js")
    check(bool(shutil.which("git")), "git в PATH")

    missing = [f for f in EXPECTED_FILES
               if find_file(f) is None and f != "scripts/aghanim-check"]
    check(not missing, "ожидаемые файлы на диске",
          "все на месте" if not missing
          else "нет на диске: " + ", ".join(missing))
    if find_file("scripts/aghanim-check") is None:
        print("[note] scripts/aghanim-check нет на диске "
              "(стирается после прогона оператором) — не ошибка")

    print("\nОфлайн-селфтесты скриптов (сеть не нужна)\n")

    mjs = find_file("scripts/build-aghanim-import.mjs")
    py = find_file("scripts/fetch-aghanim-hub.py")

    if node and mjs:
        run_step([node, str(mjs), "--selftest"],
                 "build-aghanim-import.mjs --selftest (офлайн)")
    else:
        check(False, "build-aghanim-import.mjs --selftest (офлайн)",
              "нет node или файла скрипта")

    if py:
        run_step([sys.executable, str(py), "--selftest"],
                 "fetch-aghanim-hub.py --selftest (офлайн)")
    else:
        check(False, "fetch-aghanim-hub.py --selftest (офлайн)",
              "нет файла скрипта")


def parse_args(argv: list[str]) -> None:
    for arg in argv:
        if arg in ("-h", "--help"):
            print(USAGE)
            raise SystemExit(0)
        print(f"Неизвестный аргумент: {arg}\n")
        print(USAGE)
        raise SystemExit(2)


def main() -> int:
    parse_args(sys.argv[1:])
    print(f"Проверка aghanim-offer-building в {ROOT}\n")

    run_checks()

    failed = [t for ok, t in results if not ok]
    print()
    if failed:
        print(f"FAIL: {len(failed)} из {len(results)} проверок не прошли — "
              + "; ".join(failed))
        return 1
    print(f"OK: все {len(results)} проверок зелёные — скилл установлен и работает.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
