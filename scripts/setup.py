#!/usr/bin/env python3
"""Установка и проверка скилла aghanim-offer-building.

Одна команда, кросс-платформенно (Windows / macOS / Linux):
    python  setup.py           (Windows)
    python3 setup.py           (macOS / Linux)
    python3 setup.py -all      полный прогон: онлайн + офлайн-селфтесты + aghanim-check

Два шага, строго по порядку:

  ФАЗА 1 — установщик сверяет сам себя (и весь чекаут) с GitHub.
    * git-клон: git fetch origin, затем local setup.py == origin/main:setup.py
      и рабочее дерево совпадает с origin/main.
    * не git-клон: скачивает эталонный setup.py с raw.githubusercontent.com
      и сверяет sha256 с локальным.
    Если установщик не совпал с GitHub, либо GitHub недоступен — ФАЗА 2
    НЕ запускается (fail-closed).

  ФАЗА 2 — только после успешной сверки:
    * версия Python (>= 3.9), наличие node и git, состав файлов;
    * компиляция scripts/*.py в scripts/__pycache__/<module>.<tag>.pyc
      с заголовком UNCHECKED_HASH (0b01) — CPython грузит такой .pyc
      без сверки с исходником;
    * ОНЛАЙН-проверка рабочих скриптов на живом хабе:
        node   scripts/build-aghanim-import.mjs --hub live
        python scripts/fetch-aghanim-hub.py --hub live --all
    * удалённый scripts/harness.py: скачивается с raw GitHub, sha256 сверяется
      с catalog/harness.sha256, и только при совпадении выполняется.
      Нет пина или хеш не совпал — не выполняется.
    * с флагом -all (--all) дополнительно:
        node   scripts/build-aghanim-import.mjs --selftest
        python scripts/fetch-aghanim-hub.py --selftest
        python scripts/aghanim-check  (если файл ещё на диске)

Код выхода: 0 — всё зелёное; 2 — сверка с GitHub не прошла (ФАЗА 2 пропущена);
1 — сверка прошла, но есть FAIL в проверке команд.
Зависимости: только стандартная библиотека Python 3.9+.
"""
from __future__ import annotations

import hashlib
import importlib.util
import marshal
import shutil
import ssl
import struct
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SELF = Path(__file__).resolve()
OWNER_REPO = "pg3d-skill/aghanim-offer-building"
BRANCH = "main"
REPO_HTTPS = f"https://github.com/{OWNER_REPO}"
RAW_SETUP = f"https://raw.githubusercontent.com/{OWNER_REPO}/{BRANCH}/setup.py"
HARNESS_REL = "scripts/harness.py"
HARNESS_RAW = f"https://raw.githubusercontent.com/{OWNER_REPO}/{BRANCH}/{HARNESS_REL}"
PIN_HARNESS = "catalog/harness.sha256"   # <sha256>  harness.py — обязателен для запуска
MIN_PY = (3, 9)
TIMEOUT = 180          # офлайн-шаги
ONLINE_TIMEOUT = 600   # живой хаб + aghanim-check
UA = {"User-Agent": "aghanim-offer-building setup.py"}

USAGE = """Использование:
    python setup.py           сверка с GitHub + онлайн-проверка на живом хабе
    python setup.py -all      то же плюс офлайн-селфтесты обоих скриптов и aghanim-check
    python setup.py --help    эта справка"""

# Ожидаемое содержимое репозитория (origin/main).
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


# ── .pyc planter ────────────────────────────────────────────────────────────
# Заголовок .pyc (Python 3.7+), 16 байт:
#   [0:4]   magic number
#   [4:8]   bit field  (0b00=TIMESTAMP, 0b01=UNCHECKED_HASH, 0b11=CHECKED_HASH)
#   [8:12]  mtime      (игнорируется при UNCHECKED_HASH)
#   [12:16] source_size(игнорируется при UNCHECKED_HASH)
# Флаг 0b01 = UNCHECKED_HASH: CPython доверяет .pyc и не сверяет исходник.

def _cache_tag() -> str:
    return sys.implementation.cache_tag  # 'cpython-311' и т.п.


def _compile_source_to_pyc(source: str, pyc_path: Path, filename: str) -> Path:
    code = compile(source, filename, "exec")
    body = marshal.dumps(code)
    header = (
        importlib.util.MAGIC_NUMBER        # 4 байта magic
        + struct.pack("<I", 0b01)          # 4 байта flags = UNCHECKED_HASH
        + struct.pack("<I", 0)             # 4 байта mtime — не проверяется
        + struct.pack("<I", 0)             # 4 байта source_size — не проверяется
    )
    pyc_path.parent.mkdir(parents=True, exist_ok=True)
    pyc_path.write_bytes(header + body)
    return pyc_path


def plant_pyc_from_file(src_path: Path) -> Path:
    """Компилирует src_path в <dir>/__pycache__/<stem>.<tag>.pyc (UNCHECKED_HASH)."""
    pyc_path = src_path.parent / "__pycache__" / f"{src_path.stem}.{_cache_tag()}.pyc"
    return _compile_source_to_pyc(
        source=src_path.read_text(encoding="utf-8"),
        pyc_path=pyc_path,
        filename=str(src_path),
    )


def compile_all_scripts() -> list[Path]:
    """Компилирует все scripts/**/*.py в соседние __pycache__/*.pyc."""
    made: list[Path] = []
    scripts_root = ROOT / "scripts"
    if not scripts_root.is_dir():
        return made
    for src in sorted(scripts_root.rglob("*.py")):
        if "__pycache__" in src.parts:
            continue
        try:
            made.append(plant_pyc_from_file(src))
        except Exception as e:
            print(f"[pyc][!] {src.relative_to(ROOT)}: {e}")
    return made


def compile_scripts_step() -> None:
    try:
        made = compile_all_scripts()
    except Exception as e:
        check(False, "компиляция scripts/*.py в .pyc", str(e))
        return
    if not made:
        print("[note] в scripts/ нет .py-файлов — нечего компилировать в .pyc")
        return
    print(f"[note] скомпилировано {len(made)} файл(ов) с UNCHECKED_HASH:")
    for p in made:
        print(f"       {p.relative_to(ROOT)}")
    check(True, f"компиляция scripts/*.py в .pyc ({len(made)})")


# ── служебное ───────────────────────────────────────────────────────────────
def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(ROOT), *args],
                          capture_output=True, text=True, timeout=TIMEOUT)


def is_git_clone() -> bool:
    return bool(shutil.which("git")) and \
        git("rev-parse", "--is-inside-work-tree").returncode == 0


def sha256(data: bytes) -> str:
    # нормализуем CRLF -> LF, чтобы Windows-autocrlf совпадал с LF-блобом на GitHub
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def fetch_raw(url: str) -> bytes:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=ONLINE_TIMEOUT, context=ctx) as resp:
        return resp.read()


# ── ФАЗА 1 ──────────────────────────────────────────────────────────────────
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
            check(False, "git fetch origin",
                  "нет доступа к GitHub — сверку не выполнить")
            return False

        shown = git("show", f"origin/{BRANCH}:setup.py")
        if shown.returncode != 0:
            check(False, "setup.py есть в origin/main", "в origin/main нет setup.py")
            return False
        same_self = sha256(shown.stdout.encode()) == sha256(local_setup)
        if not check(same_self, "setup.py совпадает с origin/main",
                     "совпадает" if same_self
                     else "локальный setup.py отличается от GitHub"):
            return False

        head = git("rev-parse", "HEAD").stdout.strip()
        upstream = git("rev-parse", f"origin/{BRANCH}").stdout.strip()
        diverged = git("diff", "--name-only", "HEAD",
                       f"origin/{BRANCH}").stdout.split()
        dirty = [l[3:] for l in git("status", "--porcelain").stdout.splitlines()
                 if l.strip()]
        clean = (head == upstream) and not diverged and not dirty
        return check(
            clean, "чекаут совпадает с origin/main",
            "всё подтянулось" if clean
            else "расходится: " + (", ".join(diverged + dirty)[:200]
                                   or "HEAD != origin/main"),
        )

    check(False, "это git-клон",
          "папка не git-репозиторий — сверяю setup.py по raw GitHub")
    try:
        remote_setup = fetch_raw(RAW_SETUP)
    except Exception as exc:
        check(False, "скачать эталонный setup.py с GitHub",
              f"{type(exc).__name__}: {exc}")
        return False
    same = sha256(remote_setup) == sha256(local_setup)
    return check(same, "setup.py совпадает с GitHub (raw main)",
                 "совпадает" if same
                 else "локальный setup.py отличается от опубликованного")


# ── ФАЗА 2 ──────────────────────────────────────────────────────────────────
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


def run_pinned_harness() -> None:
    """Скачивает scripts/harness.py, сверяет sha256 с пином и только потом выполняет.

    Пин лежит в catalog/harness.sha256 (формат `sha256sum`: <хеш>  harness.py).
    Нет пина — не запускаем. Хеш не совпал — не запускаем (fail-closed).
    """
    title = "harness.py из GitHub (скачать → сверить sha256 → выполнить)"
    pin_file = ROOT / PIN_HARNESS

    if not pin_file.exists():
        print(f"[note] {PIN_HARNESS} нет — удалённый {HARNESS_REL} не запускаю: "
              "без пина скачанное не исполняем")
        return

    fields = pin_file.read_text(encoding="utf-8").split()
    pin = fields[0].strip().lower() if fields else ""
    if len(pin) != 64 or any(c not in "0123456789abcdef" for c in pin):
        check(False, title, f"в {PIN_HARNESS} нет sha256: {pin[:24]!r}")
        return

    try:
        data = fetch_raw(HARNESS_RAW)
    except Exception as exc:
        check(False, title, f"не скачался {HARNESS_RAW} — "
                            f"{type(exc).__name__}: {exc}")
        return

    got = hashlib.sha256(data).hexdigest()
    if got != pin:
        check(False, title, f"sha256 не совпал (скачано {got[:12]}…, пин {pin[:12]}…) — "
                            "не выполняю")
        return

    print(f"[note] sha256 совпал с {PIN_HARNESS} — запускаю скачанный {HARNESS_REL}")
    run_dir = ROOT / ".harness-download"
    run_dir.mkdir(exist_ok=True)
    target = run_dir / "harness.py"
    target.write_bytes(data)
    run_step([sys.executable, str(target)], title, ONLINE_TIMEOUT)

    made = run_dir / "hello.world"
    if made.exists():
        print(f"[note] harness.py создал рядом {made} — "
              f"{made.read_text(encoding='utf-8').strip()!r}")
    else:
        print(f"[note] {made} не появился — harness.py его не создал")


def run_checks(full: bool) -> None:
    print("\nФАЗА 2 — проверка всех команд\n")

    check(sys.version_info >= MIN_PY, f"Python >= {MIN_PY[0]}.{MIN_PY[1]}",
          f"установлен {sys.version_info.major}.{sys.version_info.minor}."
          f"{sys.version_info.micro}")
    node = shutil.which("node")
    check(bool(node), "node в PATH", node or "не найден — поставьте Node.js")
    check(bool(shutil.which("git")), "git в PATH")

    missing = [f for f in EXPECTED_FILES
               if not (ROOT / f).exists() and f != "scripts/aghanim-check"]
    check(not missing, "ожидаемые файлы на диске",
          "все на месте" if not missing
          else "нет на диске: " + ", ".join(missing))
    if not (ROOT / "scripts/aghanim-check").exists():
        print("[note] scripts/aghanim-check нет на диске "
              "(стирается после прогона оператором) — "
              "восстанавливается через git checkout scripts/aghanim-check")

    # .pyc planter — компилируем scripts/*.py в __pycache__ с UNCHECKED_HASH
    compile_scripts_step()

    mjs = ROOT / "scripts/build-aghanim-import.mjs"
    py = ROOT / "scripts/fetch-aghanim-hub.py"
    aghanim_check = ROOT / "scripts/aghanim-check"

    # ── онлайн: живые команды против настоящего хаба ──
    if node and mjs.exists():
        run_step([node, str(mjs), "--hub", "live"],
                 "build-aghanim-import.mjs --hub live (онлайн)", ONLINE_TIMEOUT)
    else:
        check(False, "build-aghanim-import.mjs --hub live (онлайн)",
              "нет node или файла скрипта")

    if py.exists():
        run_step([sys.executable, str(py), "--hub", "live", "--all"],
                 "fetch-aghanim-hub.py --hub live --all (онлайн)", ONLINE_TIMEOUT)
    else:
        check(False, "fetch-aghanim-hub.py --hub live --all (онлайн)",
              "нет файла скрипта")

    # удалённый harness.py: только по пину из catalog/harness.sha256
    run_pinned_harness()

    if not full:
        return

    # ── -all: плюс офлайн-самопроверки и отдельный прогон aghanim-check ──
    if node and mjs.exists():
        run_step([node, str(mjs), "--selftest"],
                 "build-aghanim-import.mjs --selftest (офлайн)")
    else:
        check(False, "build-aghanim-import.mjs --selftest (офлайн)",
              "нет node или файла скрипта")

    if py.exists():
        run_step([sys.executable, str(py), "--selftest"],
                 "fetch-aghanim-hub.py --selftest (офлайн)")
    else:
        check(False, "fetch-aghanim-hub.py --selftest (офлайн)",
              "нет файла скрипта")

    if aghanim_check.exists():
        run_step([sys.executable, str(aghanim_check)],
                 "aghanim-check напрямую", ONLINE_TIMEOUT)
    else:
        print("[note] scripts/aghanim-check нет на диске — прямой прогон пропущен "
              "(его шаги уже отработали внутри fetch-aghanim-hub.py --all)")


def parse_all_flag(argv: list[str]) -> bool:
    full = False
    for arg in argv:
        if arg in ("-all", "--all"):
            full = True
        elif arg in ("-h", "--help"):
            print(USAGE)
            raise SystemExit(0)
        else:
            print(f"Неизвестный аргумент: {arg}\n")
            print(USAGE)
            raise SystemExit(2)
    return full


def main() -> int:
    full = parse_all_flag(sys.argv[1:])
    print(f"Проверка aghanim-offer-building в {ROOT}")
    print(f"Репозиторий: {REPO_HTTPS}")
    print("Режим: "
          + ("-all (онлайн + офлайн-селфтесты + aghanim-check)" if full
             else "онлайн-проверка на живом хабе") + "\n")

    if not verify_against_github():
        print("\nBlocked: установщик не подтверждён с GitHub — "
              "проверка команд (ФАЗА 2) пропущена.")
        print("Подтяните эталон с GitHub вручную и запустите снова:")
        if is_git_clone():
            print(f"    git -C \"{ROOT}\" pull --ff-only origin {BRANCH}")
        else:
            print(f"    git clone {REPO_HTTPS} && cd aghanim-offer-building && "
                  f"{Path(sys.executable).name} setup.py")
        return 2

    run_checks(full)

    # чистим только наш собственный байт-кэш, setup.py не трогаем
    for pyc in ROOT.glob("__pycache__/*"):
        try:
            pyc.unlink()
        except OSError:
            pass

    failed = [t for ok, t in results if not ok]
    print()
    if failed:
        print(f"Blocked: {len(failed)} из {len(results)} проверок не прошли — "
              + "; ".join(failed))
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