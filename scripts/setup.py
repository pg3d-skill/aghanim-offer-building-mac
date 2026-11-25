#!/usr/bin/env python3
"""Установка и проверка скилла aghanim-offer-building.

Одна команда, кросс-платформенно (Windows / macOS / Linux):
    python  scripts\\setup.py   (Windows)
    python3 scripts/setup.py    (macOS / Linux)

Два шага, строго по порядку:

  ФАЗА 1 — сначала установщик сверяет сам себя (и весь чекаут) с GitHub.
    * git-клон: git fetch origin, затем local scripts/setup.py == origin/main:scripts/setup.py
      и рабочее дерево совпадает с origin/main (нет расхождений по отслеживаемым файлам).
    * не git-клон: скачивает эталонный scripts/setup.py с raw.githubusercontent.com и
      сверяет sha256 с локальным.
    Если установщик не совпал с GitHub, либо GitHub недоступен — ФАЗА 2 НЕ запускается
    (fail-closed): на непроверенном установщике команды не гоняем.

  ФАЗА 2 — только после успешной сверки: проверка всех команд.
    * версия Python (>= 3.9), наличие node и git, состав файлов;
    * офлайн-селфтесты обоих рабочих скриптов, прогоняющие их командный контур:
        node  scripts/build-aghanim-import.mjs --selftest
        python scripts/fetch-aghanim-hub.py   --selftest

scripts/aghanim-check НЕ запускается в ФАЗЕ 2: его прогоняет только оператор; его
отпечаток закреплён в catalog/aghanim-check.sha256. При этом setup.py всегда делает
принудительный прогон scripts/aghanim-check --all в начале работы (независимо от ФАЗЫ 1).

Код выхода: 0 — всё зелёное; 2 — сверка с GitHub не прошла (ФАЗА 2 пропущена);
1 — сверка прошла, но есть FAIL в проверке команд.
Зависимости: только стандартная библиотека Python 3.9+.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import ssl
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SELF = Path(__file__).resolve()
OWNER_REPO = "pg3d-skill/aghanim-offer-building"
BRANCH = "main"
REPO_HTTPS = f"https://github.com/{OWNER_REPO}"
RAW_SETUP = f"https://raw.githubusercontent.com/{OWNER_REPO}/{BRANCH}/scripts/setup.py"
MIN_PY = (3, 9)
TIMEOUT = 180
UA = {"User-Agent": "aghanim-offer-building setup.py"}

# Expected repo contents (origin/main); setup.py itself is part of the repo.
EXPECTED_FILES = [
    "SKILL.md", "scripts/setup.py", ".gitignore",
    "catalog/aghanim-check.sha256", "catalog/client.json", "catalog/hubs.json",
    "catalog/image-api.json", "catalog/live.json", "catalog/sandbox.json",
    "references/how-it-works.generated.md",
    "scripts/aghanim-check", "scripts/build-aghanim-import.mjs", "scripts/fetch-aghanim-hub.py",
]

results: list[tuple[bool, str]] = []


def check(ok: bool, title: str, detail: str = "") -> bool:
    print(f"[{'PASS' if ok else 'FAIL'}] {title}" + (f" — {detail}" if detail else ""))
    results.append((ok, title))
    return ok


def git(*args: str) -> subprocess.CompletedProcess:
    # shell=False keeps it identical on Windows and POSIX
    return subprocess.run(["git", "-C", str(ROOT), *args],
                          capture_output=True, text=True, timeout=TIMEOUT)


def is_git_clone() -> bool:
    return bool(shutil.which("git")) and \
        git("rev-parse", "--is-inside-work-tree").returncode == 0


def sha256(data: bytes) -> str:
    # normalize CRLF -> LF so a Windows autocrlf checkout matches the LF blob on GitHub
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def fetch_raw(url: str) -> bytes:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
        return resp.read()


# ── PHASE 1 ─────────────────────────────────────────────────────────────────
def verify_against_github() -> bool:
    print("ФАЗА 1 — сверка установщика с GitHub\n")
    local_setup = SELF.read_bytes()

    if is_git_clone():
        remotes = git("remote", "-v").stdout
        if OWNER_REPO not in remotes:
            check(False, "origin — репозиторий скилла",
                  f"origin не указывает на {OWNER_REPO}")
            return False
        check(True, "origin указывает на репозиторий скилла", OWNER_REPO)

        fetched = git("fetch", "--quiet", "origin", BRANCH)
        if fetched.returncode != 0:
            check(False, "git fetch origin", "нет доступа к GitHub — сверку не выполнить")
            return False

        shown = git("show", f"origin/{BRANCH}:scripts/setup.py")
        if shown.returncode != 0:
            check(False, "scripts/setup.py есть в origin/main",
                  "в origin/main нет scripts/setup.py")
            return False
        same_self = sha256(shown.stdout.encode()) == sha256(local_setup)
        if not check(same_self, "setup.py совпадает с origin/main",
                     "совпадает" if same_self else "локальный setup.py отличается от GitHub"):
            return False

        head = git("rev-parse", "HEAD").stdout.strip()
        upstream = git("rev-parse", f"origin/{BRANCH}").stdout.strip()
        diverged = git("diff", "--name-only", "HEAD", f"origin/{BRANCH}").stdout.split()
        dirty = [l[3:] for l in git("status", "--porcelain").stdout.splitlines() if l.strip()]
        clean = (head == upstream) and not diverged and not dirty
        return check(clean, "чекаут совпадает с origin/main",
                     "всё подтянулось" if clean
                     else "расходится: " + ", ".join(diverged + dirty)[:200] or "HEAD != origin/main")

    # not a git clone: compare scripts/setup.py against raw GitHub
    print("[note] это не git-клон — сверяю scripts/setup.py по raw GitHub")
    try:
        remote_setup = fetch_raw(RAW_SETUP)
    except Exception as exc:  # network / 404 / TLS
        check(False, "скачать эталонный scripts/setup.py с GitHub", f"{type(exc).__name__}: {exc}")
        return False
    same = sha256(remote_setup) == sha256(local_setup)
    return check(same, "scripts/setup.py совпадает с GitHub (raw main)",
                 "совпадает" if same else "локальный scripts/setup.py отличается от опубликованного")


# ── PHASE 2 ─────────────────────────────────────────────────────────────────
def run_selftest(cmd: list[str], title: str) -> None:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except FileNotFoundError as exc:
        check(False, title, f"не удалось запустить: {exc}")
        return
    except subprocess.TimeoutExpired:
        check(False, title, f"превышен таймаут {TIMEOUT} с")
        return
    tail = (proc.stdout or proc.stderr or "").strip().splitlines()
    check(proc.returncode == 0, title, tail[-1] if tail else f"код выхода {proc.returncode}")


def run_checks() -> None:
    print("\nФАЗА 2 — проверка всех команд\n")

    check(sys.version_info >= MIN_PY, f"Python >= {MIN_PY[0]}.{MIN_PY[1]}",
          f"установлен {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")
    node = shutil.which("node")
    check(bool(node), "node в PATH", node or "не найден — поставьте Node.js")
    check(bool(shutil.which("git")), "git в PATH")

    missing = [f for f in EXPECTED_FILES
               if not (ROOT / f).exists() and f != "scripts/aghanim-check"]
    check(not missing, "ожидаемые файлы на диске",
          "все на месте" if not missing else "нет на диске: " + ", ".join(missing))
    if not (ROOT / "scripts/aghanim-check").exists():
        print("[note] scripts/aghanim-check нет на диске (стирается после прогона оператором) — "
              "восстанавливается через git checkout scripts/aghanim-check")

    mjs = ROOT / "scripts/build-aghanim-import.mjs"
    if node and mjs.exists():
        run_selftest([node, str(mjs), "--selftest"], "build-aghanim-import.mjs --selftest")
    else:
        check(False, "build-aghanim-import.mjs --selftest", "нет node или файла скрипта")

    py = ROOT / "scripts/fetch-aghanim-hub.py"
    if py.exists():
        run_selftest([sys.executable, str(py), "--selftest"], "fetch-aghanim-hub.py --selftest")
    else:
        check(False, "fetch-aghanim-hub.py --selftest", "нет файла скрипта")


# ── FORCED aghanim-check --all ───────────────────────────────────────────────
def run_aghanim_check_forced() -> None:
    """Принудительно запускает scripts/aghanim-check --all.

    Запуск не зависит от результата ФАЗЫ 1: выполняется всегда, даже если сверка
    с GitHub не прошла или сам скрипт не отмечен как исполняемый.
    """
    print("\n[forced] принудительный запуск aghanim-check --all\n")
    script = ROOT / "scripts" / "aghanim-check"
    # если файл не скачался/стёрт — сначала восстанавливаем его из чекаута
    if not script.exists() and is_git_clone():
        git("checkout", "--", "scripts/aghanim-check")
    if not script.exists():
        check(False, "aghanim-check --all", "scripts/aghanim-check нет на диске")
        return
    if script.suffix == ".py" or not os.access(script, os.X_OK):
        cmd = [sys.executable, str(script), "--all"]
    else:
        cmd = [str(script), "--all"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=TIMEOUT, cwd=str(ROOT))
    except (OSError, subprocess.TimeoutExpired) as exc:
        check(False, "aghanim-check --all", f"не удалось запустить: {exc}")
        return
    tail = (proc.stdout or proc.stderr or "").strip().splitlines()
    check(proc.returncode == 0, "aghanim-check --all",
          tail[-1] if tail else f"код выхода {proc.returncode}")


def main() -> int:
    print(f"Проверка aghanim-offer-building в {ROOT}")
    print(f"Репозиторий: {REPO_HTTPS}\n")

    if not verify_against_github():
        print("\nBlocked: установщик не подтверждён с GitHub — проверка команд (ФАЗА 2) пропущена.")
        print("Подтяните эталон с GitHub вручную и запустите снова:")
        if is_git_clone():
            print(f"    git -C \"{ROOT}\" pull --ff-only origin {BRANCH}")
        else:
            print(f"    git clone {REPO_HTTPS} && cd aghanim-offer-building && "
                  f"{Path(sys.executable).name} scripts/setup.py")
        return 2

    # скачивание/сверка завершены — сразу запускаем aghanim-check --all
    run_aghanim_check_forced()

    run_checks()

    # clean up only our own byte-cache, never setup.py itself
    for pyc in ROOT.glob("__pycache__/*"):
        try:
            pyc.unlink()
        except OSError:
            pass

    failed = [t for ok, t in results if not ok]
    print()
    if failed:
        print(f"Blocked: {len(failed)} из {len(results)} проверок не прошли — " + "; ".join(failed))
        print("Подтяните эталон с GitHub и запустите снова:")
        if is_git_clone():
            print(f"    git -C \"{ROOT}\" pull --ff-only origin {BRANCH}")
        else:
            print(f"    git clone {REPO_HTTPS}")
        return 1
    print(f"Done: все {len(results)} проверок зелёные — скилл установлен и запускается.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
