"""GameFinder local web application and Windows game-library API."""
from __future__ import annotations

import json
import ctypes
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import scanner
try:
    import pystray
except ImportError:
    pystray = None

APP = "GameFinder"
ROOT = Path(__file__).resolve().parent
WEB_ROOT = Path(getattr(sys, "_MEIPASS", ROOT)) / "web"
DEFAULT_SETTINGS = scanner.DEFAULT_SETTINGS
settings_lock = threading.RLock()
scan_lock = threading.Lock()
scan_status = {"running": False, "progress": "Prêt", "found": 0, "finished": True, "error": ""}
token = secrets.token_urlsafe(24)
tray_icon = None
server_instance = None
app_url = ""


def get_settings() -> dict:
    data = scanner.load_json("settings.json", DEFAULT_SETTINGS.copy())
    for key, value in DEFAULT_SETTINGS.items():
        data.setdefault(key, value)
    ignored = data.setdefault("ignored", [])
    for key in data.pop("hidden", []):
        old = next((g for g in games if g.key == key), None)
        record = {"key": key, "name": old.name if old else "Élément ignoré", "path": old.path if old else ""}
        if not any((x.get("key") if isinstance(x, dict) else x) == key for x in ignored): ignored.append(record)
    sample = Path(r"D:\SteamLibrary\steamapps\common")
    if not data["locations"] and sample.is_dir():
        data["locations"] = [str(sample)]
        scanner.save_json("settings.json", data)
    return data


def load_games() -> list[scanner.Game]:
    saved = scanner.load_json("games.json", [])
    games = []
    for row in saved:
        try:
            allowed = set(scanner.Game.__dataclass_fields__)
            game = scanner.Game(**{key: value for key, value in row.items() if key in allowed})
            if game.source == "Dossier scanné":
                game.source = "Crack"
            if Path(game.path).is_dir():
                if game.app_id and game.controller_support == "unknown":
                    metadata = scanner.load_json("metadata.json", {}).get(game.app_id, {})
                    game.controller_support = scanner.controller_support(metadata.get("categories", []))
                games.append(game)
        except (TypeError, ValueError):
            continue
    return games


games = load_games()
settings = get_settings()
games = [g for g in games if not any((x.get("key") if isinstance(x, dict) else x) == g.key for x in settings.get("ignored", []))]


def save_games():
    scanner.save_json("games.json", [asdict(game) for game in games])


def add_custom_tag(game: scanner.Game, assignment: dict, value: str) -> str:
    tag = str(value or "").strip()
    if not tag:
        raise ValueError("Le nom du tag est obligatoire.")
    assigned = assignment.setdefault("tags", [])
    if not any(str(existing).strip().casefold() == tag.casefold() for existing in assigned):
        assigned.append(tag)
    if not any(str(existing).strip().casefold() == tag.casefold() for existing in game.tags):
        game.tags.append(tag)
    return tag


def remove_custom_tag(game: scanner.Game, assignment: dict, value: str, source_tags: set[str]) -> str:
    tag = str(value or "").strip()
    if not tag:
        raise ValueError("Sélectionne un tag à retirer.")
    assigned = assignment.get("tags", [])
    removed = next((str(existing).strip() for existing in assigned
                    if str(existing).strip().casefold() == tag.casefold()), None)
    if removed is None:
        raise KeyError("Ce tag personnalisé n’est plus associé à ce jeu.")
    assignment["tags"] = [existing for existing in assigned
                          if str(existing).strip().casefold() != tag.casefold()]
    if tag.casefold() not in source_tags:
        game.tags = [existing for existing in game.tags
                     if str(existing).strip().casefold() != tag.casefold()]
    return removed


def public_game(game: scanner.Game) -> dict:
    value = asdict(game)
    value["key"] = game.key
    value["drive"] = game.drive
    if value["source"] == "Dossier scanné":
        value["source"] = "Crack"
    cover_dir = scanner.app_dir() / "covers"
    art_path = Path(game.art) if game.art else None
    if not art_path or not art_path.is_file():
        identity = game.app_id or __import__("re").sub(r"[^a-zA-Z0-9_-]", "_", game.name)
        cached = cover_dir / f"{identity}.png"
        art_path = cached if cached.is_file() else None
    if not art_path:
        icon_exe = game.icon_exe if game.icon_exe and Path(game.icon_exe).is_file() else (
            game.launch if game.launch and Path(game.launch).is_file() else scanner.first_game_exe(Path(game.path)))
        if icon_exe:
            cover_dir.mkdir(parents=True, exist_ok=True)
            game.icon_exe = icon_exe
            icon_identity = __import__("re").sub(r"[^a-zA-Z0-9_-]", "_", identity)
            icon_path = cover_dir / f"{icon_identity}_exe.png"
            if not icon_path.is_file():
                scanner.extract_exe_icon(icon_exe, icon_path)
            if icon_path.is_file():
                art_path = icon_path
    if not art_path:
        icon_exe = game.icon_exe if game.icon_exe and Path(game.icon_exe).is_file() else (
            game.launch if game.launch and Path(game.launch).is_file() else scanner.first_game_exe(Path(game.path)))
        if icon_exe:
            game.icon_exe = icon_exe
            icon_identity = __import__("re").sub(r"[^a-zA-Z0-9_-]", "_", identity)
            icon_path = cover_dir / f"{icon_identity}_exe.png"
            if not icon_path.is_file():
                scanner.extract_exe_icon(icon_exe, icon_path)
            if icon_path.is_file():
                art_path = icon_path
    if art_path:
        value["image"] = "/covers/" + art_path.name
    elif game.app_id.isdigit():
        metadata = scanner.load_json("metadata.json", {}).get(game.app_id, {})
        value["image"] = metadata.get("art_url") or f"https://cdn.cloudflare.steamstatic.com/steam/apps/{game.app_id}/library_600x900.jpg"
    else:
        value["image"] = ""
    return value


def storage_snapshot() -> list[dict]:
    grouped: dict[str, list[scanner.Game]] = {}
    for game in games:
        grouped.setdefault(game.drive, []).append(game)
    result = []
    for drive, drive_games in sorted(grouped.items()):
        try:
            usage = __import__("shutil").disk_usage(Path(drive + "\\"))
            total, free = usage.total, usage.free
        except OSError:
            total = free = 0
        result.append({"drive": drive, "total": total, "free": free, "used": total - free, "gameSize": sum(g.size for g in drive_games),
                       "games": [{"name": g.name, "path": g.path, "size": g.size} for g in sorted(drive_games, key=lambda x: x.size, reverse=True)]})
    return result


def powershell_dialog(script: str) -> str:
    """Run a WinForms dialog script through PowerShell STA and return its stdout."""
    if os.name != "nt":
        return ""
    powershell = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if not powershell.is_file():
        raise RuntimeError("Windows PowerShell est introuvable pour ouvrir la fenêtre Explorer.")
    encoded = __import__("base64").b64encode(script.encode("utf-16le")).decode("ascii")
    result = subprocess.run(
        [str(powershell), "-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", encoded],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(detail or f"Le sélecteur Explorer s’est fermé avec le code {result.returncode}.")
    return result.stdout.strip()


def choose_location(initial: str = "") -> str:
    """Show Windows' Explorer-backed folder picker without custom COM calls."""
    initial_literal = "'" + initial.replace("'", "''") + "'"
    script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$picker = New-Object System.Windows.Forms.FolderBrowserDialog; "
        "$picker.Description = 'Choisir un dossier de jeux'; "
        "$picker.ShowNewFolderButton = $false; $picker.AutoUpgradeEnabled = $true; "
        f"$picker.SelectedPath = {initial_literal}; "
        "if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { "
        "[Console]::Write($picker.SelectedPath) }; $picker.Dispose()"
    )
    return powershell_dialog(script)


def choose_file(initial: str = "") -> str:
    """Show Windows' file picker filtered to executables and shortcuts."""
    head = initial.split(None, 1)[0].strip('"') if initial.split() else ""
    file_name = Path(head).name if head else ""
    initial_literal = "'" + file_name.replace("'", "''") + "'"
    script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$dialog = New-Object System.Windows.Forms.OpenFileDialog; "
        "$dialog.Title = 'Choisir un jeu'; "
        "$dialog.Filter = 'Jeux (*.exe;*.lnk;*.bat;*.cmd)|*.exe;*.lnk;*.bat;*.cmd|Tous les fichiers (*.*)|*.*'; "
        "$dialog.CheckFileExists = $true; $dialog.Multiselect = $false; "
        f"$dialog.FileName = {initial_literal}; "
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { "
        "[Console]::Write($dialog.FileName) }; $dialog.Dispose()"
    )
    return powershell_dialog(script)


def parse_manual_path(raw: str) -> tuple[Path, str]:
    """Accept a folder, a file, or a command line like '"C:\\Game\\game.exe" --play arg'."""
    text = raw.strip()
    if text.startswith('"'):
        end = text.find('"', 1)
        if end > 1:
            candidate = Path(os.path.expandvars(text[1:end]))
            rest = text[end + 1:].strip()
            if candidate.exists() or rest:
                return candidate, rest
    whole = Path(os.path.expandvars(text))
    if whole.exists():
        return whole, ""
    parts = text.split(None, 1)
    if parts:
        candidate = Path(os.path.expandvars(parts[0].strip('"')))
        if candidate.exists():
            return candidate, parts[1] if len(parts) > 1 else ""
    return Path(os.path.expandvars(text)), ""


def launch_application_window(url: str) -> None:
    """Open the library as a visible standalone browser app window."""
    browser_candidates = [
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    ]
    browser = next((candidate for candidate in browser_candidates if candidate.is_file()), None)
    if browser:
        try:
            flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            subprocess.Popen([str(browser), f"--app={url}", "--no-first-run"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=flags)
            return
        except OSError:
            pass
    webbrowser.open(url, new=1)


def firefox_path() -> Path | None:
    """Locate firefox.exe via the App Paths registry or common install folders."""
    candidates: list[Path] = []
    if os.name == "nt":
        try:
            import winreg
            for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                for key_path in (r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe",
                                 r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe"):
                    try:
                        with winreg.OpenKey(hive, key_path) as key:
                            candidates.append(Path(winreg.QueryValueEx(key, "")[0]))
                    except OSError:
                        pass
        except ImportError:
            pass
        for base in (os.environ.get("PROGRAMFILES", r"C:\Program Files"),
                     os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
                     os.environ.get("LOCALAPPDATA", "")):
            candidates.append(Path(base) / "Mozilla Firefox" / "firefox.exe")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    import shutil
    found = shutil.which("firefox") or shutil.which("firefox.exe")
    return Path(found) if found else None


def launch_in_firefox(url: str) -> bool:
    firefox = firefox_path()
    if not firefox:
        return False
    try:
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen([str(firefox), "--new-window", url],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=flags)
        return True
    except OSError:
        return False


def start_tray(url: str) -> None:
    global tray_icon
    if pystray is None:
        return
    try:
        from PIL import Image
        icon_path = WEB_ROOT / "icon.png"
        tray_image = Image.open(icon_path).convert("RGBA")
        def open_app(_icon=None, _item=None):
            launch_application_window(url)
        def quit_app(_icon=None, _item=None):
            if tray_icon: tray_icon.stop()
            threading.Thread(target=server_instance.shutdown, daemon=True).start()
        tray_icon = pystray.Icon("GameFinder", tray_image, "GameFinder", menu=pystray.Menu(
            pystray.MenuItem("Ouvrir", open_app, default=True), pystray.MenuItem("Quitter", quit_app)))
        def run_tray():
            try:
                tray_icon.run()
            except Exception:
                pass
        threading.Thread(target=run_tray, daemon=True).start()
    except Exception:
        tray_icon = None


def gamefinder_windows() -> list[int]:
    if os.name != "nt":
        return []
    user32 = ctypes.windll.user32
    found: list[int] = []
    enum_callback = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar), ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.EnumWindows.argtypes = [enum_callback, ctypes.c_void_p]
    user32.EnumWindows.restype = ctypes.c_bool

    def inspect(hwnd, _extra):
        length = user32.GetWindowTextLengthW(hwnd)
        if not length:
            return True
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, len(title))
        if title.value.strip().casefold().startswith("gamefinder"):
            found.append(int(hwnd))
        return True

    user32.EnumWindows(enum_callback(inspect), 0)
    return found


def close_gamefinder_window() -> None:
    user32 = ctypes.windll.user32
    user32.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
    user32.PostMessageW.restype = ctypes.c_bool
    for hwnd in gamefinder_windows():
        user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE


def scan_worker():
    global games
    if not scan_lock.acquire(blocking=False):
        return
    try:
        with settings_lock:
            roots = [Path(p) for p in settings.get("locations", [])]
        scan_status.update(running=True, finished=False, progress="Lecture des lanceurs et emplacements…", found=0, error="")

        def progress(message):
            scan_status["progress"] = message

        found = scanner.steam_games() + scanner.epic_games() + scanner.registry_games() + scanner.scan_known_install_paths()
        found.extend(scanner.scan_locations(roots, progress))
        unique = {}
        for game in found:
            key = game.key
            if key not in unique or (not unique[key].uninstall and game.uninstall):
                unique[key] = game

        ignored_keys = {x.get("key") if isinstance(x, dict) else x for x in settings.get("ignored", [])}
        unique = {k:g for k,g in unique.items() if k not in ignored_keys and str(Path(g.path).resolve()).casefold() not in ignored_keys}

        fresh = []
        for index, game in enumerate(unique.values(), 1):
            scan_status["progress"] = f"Taille et informations : {game.name} ({index}/{len(unique)})"
            game.size = scanner.cached_folder_size(Path(game.path))
            game.icon_exe = game.icon_exe if game.icon_exe and Path(game.icon_exe).is_file() else (
                game.launch if game.launch and Path(game.launch).is_file() else scanner.first_game_exe(Path(game.path)))
            if not game.app_id:
                game.app_id = scanner.find_store_id(game.name)
                if game.app_id:
                    game.store_url = f"https://store.steampowered.com/app/{game.app_id}/"
            if game.app_id:
                metadata = scanner.steam_metadata(game)
                if metadata.get("type") and metadata["type"] != "game":
                    continue
                game.tags = metadata.get("tags", [])
                game.genres = metadata.get("genres", [])
                game.controller_support = scanner.controller_support(metadata.get("categories", []))
                game.developer = metadata.get("developer", "")
                game.description = metadata.get("description", "")
                game.store_url = metadata.get("store_url") or game.store_url
                game.art = scanner.get_art(game, metadata)
            if not game.art:
                game.art = scanner.get_art(game, {})
            assignment = settings.get("assignments", {}).get(game.key, {})
            game.tags = list(dict.fromkeys(game.tags + assignment.get("tags", [])))
            fresh.append(game)
            scan_status["found"] = len(fresh)
            with settings_lock:
                games = list(fresh)
                save_games()
        with settings_lock:
            games = fresh
            save_games()
            settings["last_scan"] = time.strftime("%d/%m/%Y à %H:%M")
            scanner.save_json("settings.json", settings)
        scan_status.update(running=False, finished=True, found=len(fresh), progress=f"Scan terminé · {len(fresh)} jeux", error="")
    except Exception as exc:
        scan_status.update(running=False, finished=True, error=str(exc), progress="Le scan a rencontré une erreur")
    finally:
        scan_lock.release()


def json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = min(int(handler.headers.get("Content-Length", "0")), 1_000_000)
    return json.loads(handler.rfile.read(length) or b"{}")


class Handler(BaseHTTPRequestHandler):
    server_version = "GameFinder/2.0"

    def log_message(self, _format, *_args):
        return

    def send_bytes(self, data: bytes, content_type: str, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, value, status=200):
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def authorized(self) -> bool:
        return self.headers.get("X-GameFinder-Token", "") == token

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            if not self.authorized():
                return self.send_json({"error": "unauthorized"}, 403)
            with settings_lock:
                self.send_json({"settings": settings, "games": [public_game(g) for g in games], "scan": scan_status, "storage": storage_snapshot()})
            return
        if parsed.path.startswith("/covers/"):
            name = Path(unquote(parsed.path.removeprefix("/covers/"))).name
            candidate = (scanner.app_dir() / "covers" / name).resolve()
            if candidate.parent == (scanner.app_dir() / "covers").resolve() and candidate.is_file() and candidate.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}[candidate.suffix.lower()]
                return self.send_bytes(candidate.read_bytes(), mime)
            return self.send_bytes(b"", "text/plain", 404)
        local = "/index.html" if parsed.path == "/" else parsed.path
        candidate = (WEB_ROOT / unquote(local.lstrip("/"))).resolve()
        if candidate != WEB_ROOT.resolve() and WEB_ROOT.resolve() not in candidate.parents:
            return self.send_bytes(b"Not found", "text/plain", 404)
        if not candidate.is_file():
            return self.send_bytes(b"Not found", "text/plain", 404)
        suffix = candidate.suffix.lower()
        mime = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp"}.get(suffix, "application/octet-stream")
        self.send_bytes(candidate.read_bytes(), mime)

    def do_POST(self):
        if not self.authorized():
            return self.send_json({"error": "unauthorized"}, 403)
        try:
            body = json_body(self)
            path = urlparse(self.path).path
            if path == "/api/settings":
                with settings_lock:
                    settings.update(body)
                    scanner.save_json("settings.json", settings)
                    self.send_json({"ok": True, "settings": settings})
            elif path == "/api/ignore":
                key = str(body.get("key", ""))
                game = next((g for g in games if g.key == key), None)
                if not game: return self.send_json({"error": "game not found"}, 404)
                record = {"key": game.key, "name": game.name, "path": game.path}
                with settings_lock:
                    settings.setdefault("ignored", []).append(record)
                    games[:] = [g for g in games if g.key != game.key]
                    scanner.save_json("settings.json", settings); save_games()
                self.send_json({"ok": True, "settings": settings})
            elif path == "/api/ignored/restore":
                key = str(body.get("key", ""))
                with settings_lock:
                    settings["ignored"] = [x for x in settings.get("ignored", []) if (x.get("key") if isinstance(x, dict) else x) != key]
                    scanner.save_json("settings.json", settings)
                self.send_json({"ok": True, "settings": settings})
            elif path == "/api/manual":
                raw = str(body.get("path", "")).strip()
                if not raw:
                    return self.send_json({"error": "Indique un dossier de jeu, un .exe, un raccourci .lnk ou une commande complète."}, 400)
                target, launch_args = parse_manual_path(raw)
                suffix = target.suffix.lower()
                launch = icon_exe = ""
                if target.is_file() and suffix == ".lnk":
                    resolved, shortcut_args = scanner.resolve_shortcut(target)
                    if not resolved:
                        return self.send_json({"error": "Impossible de résoudre ce raccourci .lnk."}, 400)
                    exe = Path(resolved)
                    icon_exe = str(exe)
                    if launch_args:
                        launch, launch_args = str(exe), " ".join(x for x in (shortcut_args, launch_args) if x)
                    else:
                        launch = str(target)
                    folder = exe.parent
                elif target.is_file() and suffix in {".exe", ".bat", ".cmd", ".com"}:
                    launch = str(target)
                    icon_exe = str(target) if suffix == ".exe" else ""
                    folder = target.parent
                elif target.is_dir():
                    folder = target
                    found = scanner.first_game_exe(folder)
                    if found:
                        launch = icon_exe = found
                else:
                    return self.send_json({"error": "Le fichier ou dossier n’existe pas. Exemples : un dossier de jeu, \"C:\\Jeu\\jeu.exe\" ou \"C:\\Jeu\\jeu.exe\" --play arg."}, 400)
                if not folder.is_dir():
                    return self.send_json({"error": "Indique un dossier de jeu ou un fichier exécutable."}, 400)
                game = scanner.Game(str(body.get("name") or folder.name), str(folder), "Ajout manuel", launch=launch, icon_exe=icon_exe, launch_args=launch_args)
                game.size = scanner.cached_folder_size(folder); game.art = scanner.get_art(game, {})
                with settings_lock:
                    games[:] = [g for g in games if g.key != game.key]; games.append(game); save_games()
                self.send_json({"ok": True, "game": public_game(game)})
            elif path == "/api/scan":
                if scan_status["running"]:
                    return self.send_json({"ok": True, "running": True})
                threading.Thread(target=scan_worker, daemon=True).start()
                self.send_json({"ok": True, "running": True}, 202)
            elif path == "/api/browse":
                try:
                    if str(body.get("mode", "")) == "file":
                        selected = choose_file(str(body.get("initial", "")))
                    else:
                        selected = choose_location(str(body.get("initial", "")))
                except Exception as exc:
                    return self.send_json({"error": f"Impossible d’ouvrir le sélecteur : {exc}"}, 500)
                self.send_json({"path": selected})
            elif path == "/api/game":
                game = next((g for g in games if g.key == body.get("key")), None)
                if not game:
                    return self.send_json({"error": "game not found"}, 404)
                action = body.get("action")
                with settings_lock:
                    if action == "favorite":
                        favorites = settings["favorites"]
                        if game.key in favorites: favorites.remove(game.key)
                        else: favorites.append(game.key)
                    elif action == "category":
                        assignment = settings["assignments"].setdefault(game.key, {"tags": []})
                        category = str(body.get("value", "")).strip()
                        if category: assignment["category"] = category
                        else: assignment.pop("category", None)
                    elif action == "hidden":
                        hidden = settings.setdefault("hidden", [])
                        if game.key in hidden: hidden.remove(game.key)
                        else: hidden.append(game.key)
                    elif action == "tag_add":
                        assigned = settings["assignments"].setdefault(game.key, {"tags": []})
                        try:
                            add_custom_tag(game, assigned, body.get("value", ""))
                        except ValueError as exc:
                            return self.send_json({"error": str(exc)}, 400)
                    elif action == "tag_remove":
                        assigned = settings["assignments"].get(game.key, {})
                        # Retirer les variantes personnalisées sans toucher aux genres venant des métadonnées.
                        metadata = scanner.load_json("metadata.json", {}).get(game.app_id, {}) if game.app_id else {}
                        source_tags = {str(value).strip().casefold() for value in (metadata.get("tags", []) + metadata.get("genres", []))}
                        try:
                            remove_custom_tag(game, assigned, body.get("value", ""), source_tags)
                        except ValueError as exc:
                            return self.send_json({"error": str(exc)}, 400)
                        except KeyError as exc:
                            return self.send_json({"error": str(exc.args[0])}, 404)
                    scanner.save_json("settings.json", settings)
                    save_games()
                self.send_json({"ok": True, "settings": settings, "game": public_game(game)})
            elif path == "/api/category":
                with settings_lock:
                    action = body.get("action", "add")
                    categories = settings.setdefault("categories", [])
                    if action == "add":
                        name = str(body.get("name", "")).strip()
                        if not name: return self.send_json({"error": "name required"}, 400)
                        if name not in categories: categories.append(name)
                    elif action == "reorder":
                        requested = [str(v) for v in body.get("categories", [])]
                        if set(requested) != set(categories) or len(requested) != len(categories):
                            return self.send_json({"error": "invalid category order"}, 400)
                        settings["categories"] = requested
                    elif action == "rename":
                        old, name = str(body.get("old", "")), str(body.get("name", "")).strip()
                        if old not in categories or not name: return self.send_json({"error": "invalid category"}, 400)
                        if name != old and name in categories: return self.send_json({"error": "Ce nom de catégorie existe déjà."}, 409)
                        settings["categories"][categories.index(old)] = name
                        for assignment in settings.get("assignments", {}).values():
                            if assignment.get("category") == old: assignment["category"] = name
                    elif action == "delete":
                        name = str(body.get("name", ""))
                        if name in categories: categories.remove(name)
                        for assignment in settings.get("assignments", {}).values():
                            if assignment.get("category") == name: assignment.pop("category", None)
                    else:
                        return self.send_json({"error": "unknown category action"}, 400)
                    scanner.save_json("settings.json", settings)
                self.send_json({"ok": True, "settings": settings})
            elif path == "/api/filter":
                with settings_lock:
                    name, tag = str(body.get("name", "")).strip(), str(body.get("tag", "")).strip()
                    if not name or not tag: return self.send_json({"error": "name and tag required"}, 400)
                    settings["filters"].append({"name": name, "tag": tag})
                    scanner.save_json("settings.json", settings)
                self.send_json({"ok": True, "settings": settings})
            elif path == "/api/action":
                game = next((g for g in games if g.key == body.get("key")), None)
                if not game: return self.send_json({"error": "game not found"}, 404)
                action = body.get("action")
                if action == "open":
                    os.startfile(game.path)
                elif action == "launch":
                    if game.source == "Steam" and game.app_id: os.startfile(f"steam://rungameid/{game.app_id}")
                    elif game.launch and Path(game.launch).is_file():
                        launch_args = str(getattr(game, "launch_args", "") or "").strip()
                        if launch_args:
                            subprocess.Popen(f'"{game.launch}" {launch_args}', shell=True)
                        else:
                            os.startfile(game.launch)
                    else:
                        exe = scanner.first_game_exe(Path(game.path))
                        if exe: os.startfile(exe)
                        else: return self.send_json({"error": "Aucun exécutable trouvé"}, 400)
                elif action == "uninstall":
                    if not game.uninstall: return self.send_json({"error": "Aucun désinstalleur enregistré"}, 400)
                    if game.uninstall.startswith(("steam://", "com.epicgames.launcher://")): os.startfile(game.uninstall)
                    else: subprocess.Popen(game.uninstall, shell=True)
                elif action == "delete":
                    import shutil
                    shutil.rmtree(game.path)
                    with settings_lock:
                        games[:] = [g for g in games if g.key != game.key]
                        save_games()
                else: return self.send_json({"error": "action inconnue"}, 400)
                self.send_json({"ok": True})
            elif path == "/api/open-firefox":
                if not app_url or not launch_in_firefox(app_url):
                    return self.send_json({"error": "Firefox est introuvable sur cet ordinateur."}, 404)
                self.send_json({"ok": True})
            elif path == "/api/quit":
                self.send_json({"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                threading.Timer(0.2, close_gamefinder_window).start()
            else:
                self.send_json({"error": "not found"}, 404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "null")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-GameFinder-Token")
        self.end_headers()


def serve():
    global server_instance, app_url
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_instance = server
    server.daemon_threads = True
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/?token={token}"
    app_url = url
    try:
        scanner.save_json("server-session.json", {"url": url, "pid": os.getpid()})
    except OSError:
        pass
    threading.Timer(0.7, lambda: launch_application_window(url)).start()
    start_tray(url)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    serve()
