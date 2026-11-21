from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "web" / "icon.png"
DESTINATION = ROOT / "gamefinder.ico"

if not SOURCE.is_file():
    raise FileNotFoundError(f"Icône GameFinder introuvable : {SOURCE}")

with Image.open(SOURCE) as source_image:
    icon = source_image.convert("RGBA")
    icon.save(
        DESTINATION,
        format="ICO",
        sizes=[(size, size) for size in (128, 64, 48, 32, 24, 16) if size <= min(icon.size)],
    )

print(f"Icône créée depuis {SOURCE}")
