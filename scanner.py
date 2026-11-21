"""GameFinder - bibliothèque de jeux Windows avec collections, jaquettes et stockage."""
from __future__ import annotations

import base64
import ctypes
import json
import os
import re
import subprocess
import time
import unicodedata
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

try:
    from PIL import Image
except ImportError:
    Image = None
try:
    from PIL import ImageTk
except ImportError:
    ImageTk = None

APP_NAME = "GameFinder"
HINTS = re.compile(r"game|games|jeu|jeux|steam|epic|gog|ubisoft|origin|ea games|battle\.net|riot|rockstar|xbox|overwatch|fortnite|aim ?labs?|aimtrainer|aim trainer|valorant", re.I)
SKIP = {"$recycle.bin", "system volume information", "windows", "perflogs", "recovery", "config.msi", "windowsapps", "programdata", "appdata", "$windows.~bt", "redist", "redistributables"}


@dataclass
class Game:
    name: str
    path: str
    source: str = "Dossier scanné"
    uninstall: str = ""
    launch: str = ""
    icon_exe: str = ""
    app_id: str = ""
    size: int = 0
    art: str = ""
    tags: list[str] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    controller_support: str = "unknown"
    developer: str = ""
    description: str = ""
    store_url: str = ""
    launch_args: str = ""

    @property
    def key(self) -> str:
        return os.path.normcase(os.path.abspath(self.path)).casefold()

    @property
    def drive(self) -> str:
        return Path(self.path).drive or "—"


def human_size(value: int) -> str:
    if value <= 0:
        return "—"
    number = float(value)
    for unit in ("o", "Ko", "Mo", "Go", "To"):
        if number < 1024 or unit == "To":
            return f"{number:.1f} {unit}"
        number /= 1024
    return "—"


def app_dir() -> Path:
    base = Path(os.environ.get("APPDATA", str(Path.home()))) / APP_NAME
    base.mkdir(parents=True, exist_ok=True)
    return base


def load_json(name: str, fallback):
    try:
        return json.loads((app_dir() / name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


DEFAULT_SETTINGS = {
    "locations": [], "layout": "Grille", "columns": 3, "sort": "Nom",
    "show_size": True, "show_drive": True, "show_tags": True, "show_banner": True,
    "favorites": [], "hidden": [], "ignored": [], "categories": [], "assignments": {}, "filters": [],
}


def save_json(name: str, value) -> None:
    dest = app_dir() / name
    temp = dest.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(dest)


def vdf_value(text: str, key: str) -> str:
    match = re.search(r'"' + re.escape(key) + r'"\s+"([^"]*)"', text)
    return match.group(1) if match else ""


def steam_games() -> list[Game]:
    steam_dirs = [Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Steam"]
    try:
        import winreg
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for reg_path in (r"Software\Valve\Steam", r"Software\WOW6432Node\Valve\Steam"):
                try:
                    with winreg.OpenKey(hive, reg_path) as key:
                        steam_dirs.append(Path(winreg.QueryValueEx(key, "InstallPath")[0]))
                except OSError:
                    pass
    except ImportError:
        pass
    found: dict[str, Game] = {}
    for steam in steam_dirs:
        app_dirs = [steam / "steamapps"]
        try:
            content = (steam / "steamapps" / "libraryfolders.vdf").read_text(encoding="utf-8", errors="ignore")
            app_dirs.extend(Path(p.replace("\\\\", "\\")) / "steamapps" for p in re.findall(r'"path"\s+"((?:[^"\\]|\\.)*)"', content))
        except OSError:
            pass
        for apps in app_dirs:
            try:
                for manifest in apps.glob("appmanifest_*.acf"):
                    text = manifest.read_text(encoding="utf-8", errors="ignore")
                    name, app_id, folder_name = vdf_value(text, "name"), vdf_value(text, "appid"), vdf_value(text, "installdir")
                    folder = apps / "common" / folder_name
                    if name and app_id and folder.is_dir():
                        game = Game(name, str(folder), "Steam", f"steam://uninstall/{app_id}", app_id=app_id, store_url=f"https://store.steampowered.com/app/{app_id}/")
                        found[game.key] = game
            except OSError:
                continue
    return list(found.values())


def epic_games() -> list[Game]:
    base = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "Epic" / "EpicGamesLauncher" / "Data" / "Manifests"
    found = []
    try:
        for manifest in base.glob("*.item"):
            try:
                item = json.loads(manifest.read_text(encoding="utf-8", errors="ignore"))
                folder = Path(item.get("InstallLocation", ""))
                name, app_id = item.get("DisplayName") or item.get("AppName"), item.get("AppName", "")
                if name and folder.is_dir():
                    found.append(Game(name, str(folder), "Epic Games", f"com.epicgames.launcher://apps/{quote(app_id)}?action=uninstall", app_id=app_id))
            except (OSError, ValueError, TypeError):
                pass
    except OSError:
        pass
    return found


def registry_games() -> list[Game]:
    try:
        import winreg
    except ImportError:
        return []
    entries = []
    keys = [(hive, path) for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER)
            for path in (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                         r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall")]
    game_publishers = re.compile(r"valve|epic|rockstar|ubisoft|electronic arts|\bea\b|origin|riot|blizzard|battle\.net|gog|cd projekt|xbox|microsoft game|bandai|capcom|square enix|sega|2k games|take.?two|bethesda|paradox|devolver|itch", re.I)
    for hive, path in keys:
        try:
            with winreg.OpenKey(hive, path) as root:
                for i in range(winreg.QueryInfoKey(root)[0]):
                    try:
                        with winreg.OpenKey(root, winreg.EnumKey(root, i)) as key:
                            def value(name):
                                try: return winreg.QueryValueEx(key, name)[0]
                                except OSError: return ""
                            name = str(value("DisplayName")).strip()
                            publisher = str(value("Publisher")).strip()
                            raw = str(value("InstallLocation")).strip().strip('"')
                            if not raw:
                                icon = str(value("DisplayIcon")).strip().strip('"')
                                if icon and Path(os.path.expandvars(icon)).is_file(): raw = str(Path(os.path.expandvars(icon)).parent)
                            if name and raw and (HINTS.search(name + " " + raw) or game_publishers.search(publisher)):
                                folder = Path(os.path.expandvars(raw))
                                exe = first_game_exe(folder) if folder.is_dir() else ""
                                if exe:
                                    source = next((s for pat,s in [(r"rockstar", "Rockstar Games"),(r"ubisoft", "Ubisoft Connect"),(r"electronic arts|\bea\b|origin", "EA app / Origin"),(r"riot", "Riot Client"),(r"blizzard|battle\.net", "Battle.net"),(r"gog", "GOG Galaxy"),(r"xbox|microsoft game", "Xbox") ] if re.search(pat,publisher,re.I)), "Windows")
                                    entries.append(Game(name, str(folder), source, str(value("QuietUninstallString") or value("UninstallString")), launch=exe, icon_exe=exe))
                    except OSError:
                        pass
        except OSError:
            pass
    return entries


def resolve_shortcut(path: Path) -> tuple[str, str]:
    """Resolve a .lnk shortcut to (target exe, arguments) via WScript.Shell."""
    if os.name != "nt" or path.suffix.lower() != ".lnk":
        return "", ""
    powershell = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if not powershell.is_file():
        return "", ""
    literal = "'" + str(path).replace("'", "''") + "'"
    script = f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut({literal});$s.TargetPath+'|'+$s.Arguments"
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    try:
        result = subprocess.run(
            [str(powershell), "-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", encoded],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        target, _, args = result.stdout.strip().partition("|")
        target = target.strip().strip('"')
        return (target, args.strip()) if target and Path(target).is_file() else ("", "")
    except (OSError, subprocess.SubprocessError):
        return "", ""


def is_inside(path: Path, roots: list[Path]) -> bool:
    try:
        resolved = path.resolve()
        return any(resolved == root.resolve() or root.resolve() in resolved.parents for root in roots)
    except OSError:
        return False


def first_game_exe(folder: Path) -> str:
    candidates = []
    folder_name = re.sub(r"[^a-z0-9]", "", folder.name.casefold())
    helper_names = ("epicwebhelper", "crashreport", "crashhandler", "unins", "setup", "launcher",
                    "bootstrap", "updater", "patcher", "easyanticheat", "battleye", "vc_redist",
                    "vcredist", "unitycrash", "reporter", "prereq")
    for base, dirs, files in os.walk(folder, onerror=lambda _e: None):
        depth = len(Path(base).relative_to(folder).parts)
        dirs[:] = [d for d in dirs if d.casefold() not in SKIP and depth < 8]
        for name in files:
            lowered = name.casefold()
            if not lowered.endswith(".exe") or lowered.startswith(helper_names):
                continue
            path = Path(base) / name
            normalized = re.sub(r"[^a-z0-9]", "", Path(name).stem.casefold())
            matches_folder = bool(folder_name and folder_name in normalized)
            try: size = path.stat().st_size
            except OSError: size = 0
            candidates.append((not matches_folder, depth, -size, lowered, path))
    if not candidates:
        return ""
    candidates.sort(key=lambda item: item[:4])
    return str(candidates[0][4])


def scan_locations(roots: list[Path], progress) -> list[Game]:
    found: dict[str, Game] = {}
    for root in roots:
        if not root.is_dir():
            progress(f"Emplacement introuvable : {root}")
            continue
        progress(f"Analyse de {root}")
        try:
            # If the selected path is a game install itself, scan it as one candidate.
            has_exe_here = any(p.is_file() and p.suffix.casefold() == ".exe" for p in root.iterdir())
            candidates = [root] if has_exe_here else [p for p in root.iterdir() if p.is_dir() and p.name.casefold() not in SKIP]
        except OSError:
            continue
        for folder in candidates:
            exe = first_game_exe(folder)
            if not exe:
                continue
            # Configured game-library folders are trusted; general folders require a game-like name or large game binary.
            trusted = bool(HINTS.search(str(root)))
            try: large_binary = Path(exe).stat().st_size >= 24 * 1024 * 1024
            except OSError: large_binary = False
            if trusted or large_binary or HINTS.search(folder.name):
                game = Game(folder.name, str(folder), "Crack", launch=exe, icon_exe=exe)
                found[game.key] = game
    return list(found.values())


def scan_known_install_paths() -> list[Game]:
    """Catch common installs for launchers whose manifests can be missing."""
    if os.name != "nt":
        return []
    mask = ctypes.windll.kernel32.GetLogicalDrives()
    relatives = (
        (r"Program Files (x86)\Overwatch", "Blizzard"),
        (r"Program Files\Overwatch", "Blizzard"),
        (r"Program Files (x86)\Battle.net\Overwatch", "Blizzard"),
        (r"Program Files (x86)\Battle.net\Overwatch 2", "Blizzard"),
        (r"Battle.net\Overwatch", "Blizzard"),
        (r"Battle.net\Overwatch 2", "Blizzard"),
        (r"Games\Overwatch", "Blizzard"),
        (r"Games\Overwatch 2", "Blizzard"),
        (r"Program Files\Epic Games\Fortnite", "Epic Games"),
        (r"Program Files (x86)\Epic Games\Fortnite", "Epic Games"),
        (r"Epic Games\Fortnite", "Epic Games"),
        (r"Games\Fortnite", "Epic Games"),
        (r"Program Files\Aimlabs", "Aimlabs"),
        (r"Program Files (x86)\Aimlabs", "Aimlabs"),
        (r"Games\Aimlabs", "Aimlabs"),
        (r"Games\Aim Lab", "Aimlabs"),
        (r"Games\Aimtrainer", "Aimlabs"),
    )
    found = {}
    for index in range(26):
        if not mask & (1 << index):
            continue
        drive = Path(f"{chr(index + 65)}:/")
        for relative, source in relatives:
            folder = drive / relative
            if not folder.is_dir():
                continue
            exe = first_game_exe(folder)
            if not exe:
                continue
            game = Game(folder.name, str(folder), source, launch=exe, icon_exe=exe)
            found[game.key] = game
    return list(found.values())


def folder_size(folder: Path) -> int:
    total = 0
    pending = [folder]
    while pending:
        current = pending.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name.casefold() not in {"$recycle.bin", "system volume information"}:
                                pending.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def cached_folder_size(folder: Path) -> int:
    """Reuse recent sizes to make repeat scans nearly immediate."""
    cache = load_json("sizes.json", {})
    key = os.path.normcase(os.path.abspath(folder)).casefold()
    entry = cache.get(key)
    now = time.time()
    if entry and now - entry.get("checked", 0) < 900 and folder.is_dir():
        return int(entry.get("size", 0))
    size = folder_size(folder)
    cache[key] = {"size": size, "checked": now}
    # Expire old paths instead of growing the cache indefinitely.
    cache = {k: v for k, v in cache.items() if now - v.get("checked", 0) < 30 * 86400}
    try: save_json("sizes.json", cache)
    except OSError: pass
    return size


class SteamDBTags(HTMLParser):
    def __init__(self):
        super().__init__()
        self._active = 0
        self.tags: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href", "")
            if "/tag/" in href or "/tags/" in href:
                self._active += 1

    def handle_endtag(self, tag):
        if tag == "a" and self._active:
            self._active -= 1

    def handle_data(self, data):
        value = html.unescape(data).strip()
        if self._active and value and len(value) < 50 and value not in self.tags:
            self.tags.append(value)


def request_bytes(url: str, timeout: int = 8) -> bytes:
    request = Request(url, headers={"User-Agent": "GameFinder/1.0 (local game library)", "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7"})
    with urlopen(request, timeout=timeout) as response:
        return response.read(8_000_000)


def steam_metadata(game: Game) -> dict:
    if not game.app_id.isdigit():
        return {}
    cache = load_json("metadata.json", {})
    cached = cache.get(game.app_id)
    if cached and cached.get("_version") == 2:
        return cached
    result: dict = {}
    try:
        data = json.loads(request_bytes(f"https://store.steampowered.com/api/appdetails?appids={game.app_id}&l=french&cc=fr").decode("utf-8", "replace"))
        details = data.get(game.app_id, {}).get("data", {})
        result.update({"type": details.get("type", ""), "description": details.get("short_description", ""), "developer": ", ".join(details.get("developers", [])),
                       "genres": [g.get("description", "") for g in details.get("genres", [])],
                       "categories": [c.get("description", "") for c in details.get("categories", [])],
                       "art_url": details.get("header_image", ""), "store_url": details.get("steam_appid") and f"https://store.steampowered.com/app/{game.app_id}/"})
    except Exception:
        pass
    try:
        page = request_bytes(f"https://steamdb.info/app/{game.app_id}/").decode("utf-8", "replace")
        parser = SteamDBTags()
        parser.feed(page)
        result["tags"] = parser.tags[:24]
    except Exception:
        result["tags"] = []
    if not result.get("art_url"):
        result["art_url"] = f"https://cdn.cloudflare.steamstatic.com/steam/apps/{game.app_id}/library_600x900.jpg"
    result["tags"] = result.get("tags") or result.get("genres", [])
    result["_version"] = 2
    cache[game.app_id] = result
    try: save_json("metadata.json", cache)
    except OSError: pass
    return result


def controller_support(categories: list[str]) -> str:
    values = ["".join(ch for ch in unicodedata.normalize("NFKD", str(value).casefold())
                      if not unicodedata.combining(ch)) for value in categories]
    if any("full controller support" in value or "controleurs complete" in value
           or "manettes complete" in value for value in values):
        return "full"
    if any("partial controller support" in value or "controleurs partielle" in value
           or "manettes partielle" in value for value in values):
        return "partial"
    return "unknown"


def find_store_id(name: str) -> str:
    try:
        payload = json.loads(request_bytes(f"https://store.steampowered.com/api/storesearch/?term={quote(name)}&l=french&cc=fr").decode("utf-8", "replace"))
        normalized = re.sub(r"[^a-z0-9]", "", name.casefold())
        for item in payload.get("items", []):
            candidate = re.sub(r"[^a-z0-9]", "", item.get("name", "").casefold())
            if candidate == normalized and str(item.get("id", "")).isdigit():
                return str(item["id"])
    except Exception:
        pass
    return ""


def get_art(game: Game, metadata: dict) -> str:
    if Image is None:
        return ""
    art_urls = []
    if game.app_id.isdigit():
        art_urls.append(f"https://cdn.cloudflare.steamstatic.com/steam/apps/{game.app_id}/library_600x900.jpg")
    if metadata.get("art_url"):
        art_urls.append(metadata["art_url"])
    cache_dir = app_dir() / "covers"
    cache_dir.mkdir(exist_ok=True)
    identity = game.app_id or re.sub(r"[^a-zA-Z0-9_-]", "_", game.name)
    target = cache_dir / f"{identity}.png"
    if target.exists() and art_urls:
        return str(target)
    from io import BytesIO
    for art_url in dict.fromkeys(art_urls):
        try:
            with Image.open(BytesIO(request_bytes(art_url, 10))) as image:
                image.convert("RGB").save(target, "PNG")
            return str(target)
        except Exception:
            continue
    exe = game.icon_exe if game.icon_exe and Path(game.icon_exe).is_file() else (
        game.launch if game.launch and Path(game.launch).is_file() else first_game_exe(Path(game.path)))
    if not exe:
        return ""
    icon_target = cache_dir / f"{identity}_exe.png"
    if icon_target.is_file():
        return str(icon_target)
    return extract_exe_icon(exe, icon_target)


def extract_exe_icon(executable: str, destination: Path) -> str:
    """Extract the Windows executable icon and convert it to a cached PNG."""
    if Image is None or os.name != "nt":
        return ""
    large = small = dc = memory_dc = bitmap = previous = None
    try:
        from ctypes import wintypes

        class BitmapInfoHeader(ctypes.Structure):
            _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                        ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
                        ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]

        class BitmapInfo(ctypes.Structure):
            _fields_ = [("bmiHeader", BitmapInfoHeader), ("bmiColors", wintypes.DWORD * 3)]

        shell = ctypes.windll.shell32
        user = ctypes.windll.user32
        gdi = ctypes.windll.gdi32
        large, small = wintypes.HICON(), wintypes.HICON()
        shell.ExtractIconExW.argtypes = [wintypes.LPCWSTR, ctypes.c_int, ctypes.POINTER(wintypes.HICON), ctypes.POINTER(wintypes.HICON), wintypes.UINT]
        shell.ExtractIconExW.restype = wintypes.UINT
        if not shell.ExtractIconExW(str(executable), 0, ctypes.byref(large), ctypes.byref(small), 1):
            return ""
        icon = large.value or small.value
        if not icon:
            return ""

        user.GetDC.argtypes = [ctypes.c_void_p]
        user.GetDC.restype = ctypes.c_void_p
        user.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        user.ReleaseDC.restype = ctypes.c_int
        user.DrawIconEx.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, wintypes.HICON,
                                    ctypes.c_int, ctypes.c_int, wintypes.UINT, ctypes.c_void_p, wintypes.UINT]
        user.DrawIconEx.restype = wintypes.BOOL
        user.DestroyIcon.argtypes = [wintypes.HICON]
        user.DestroyIcon.restype = wintypes.BOOL
        gdi.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
        gdi.CreateCompatibleDC.restype = ctypes.c_void_p
        gdi.CreateDIBSection.argtypes = [ctypes.c_void_p, ctypes.POINTER(BitmapInfo), wintypes.UINT,
                                         ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, wintypes.DWORD]
        gdi.CreateDIBSection.restype = ctypes.c_void_p
        gdi.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        gdi.SelectObject.restype = ctypes.c_void_p
        gdi.DeleteObject.argtypes = [ctypes.c_void_p]
        gdi.DeleteObject.restype = wintypes.BOOL
        gdi.DeleteDC.argtypes = [ctypes.c_void_p]
        gdi.DeleteDC.restype = wintypes.BOOL

        size = 64
        dc = user.GetDC(None)
        if not dc:
            return ""
        memory_dc = gdi.CreateCompatibleDC(dc)
        if not memory_dc:
            return ""
        info = BitmapInfo()
        info.bmiHeader = BitmapInfoHeader(ctypes.sizeof(BitmapInfoHeader), size, -size, 1, 32, 0, size * size * 4, 0, 0, 0, 0)
        bits = ctypes.c_void_p()
        bitmap = gdi.CreateDIBSection(dc, ctypes.byref(info), 0, ctypes.byref(bits), None, 0)
        if not bitmap or not bits.value:
            return ""
        previous = gdi.SelectObject(memory_dc, bitmap)
        if not previous or previous == ctypes.c_void_p(-1).value:
            return ""
        if not user.DrawIconEx(memory_dc, 0, 0, icon, size, size, 0, None, 3):
            return ""
        image = Image.frombytes("RGBA", (size, size), ctypes.string_at(bits, size * size * 4), "raw", "BGRA")
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination, "PNG")
        return str(destination)
    except Exception:
        return ""
    finally:
        try:
            if previous and memory_dc:
                gdi.SelectObject(memory_dc, previous)
            if bitmap:
                gdi.DeleteObject(bitmap)
            if memory_dc:
                gdi.DeleteDC(memory_dc)
            if dc:
                user.ReleaseDC(None, dc)
            if large and large.value:
                user.DestroyIcon(large)
            if small and small.value:
                user.DestroyIcon(small)
        except Exception:
            pass


