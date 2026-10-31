"""Create a deterministic, dependency-free load-unpacked extension ZIP."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
target = root / "dist" / "reactive-resume-capture.zip"
target.parent.mkdir(exist_ok=True)
files = [root / "manifest.json", *root.glob("*.html"), *root.glob("*.css")]
files.extend(sorted((root / "src").glob("*.js")))
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(files):
        info = zipfile.ZipInfo(str(path.relative_to(root)), date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())
print(target)

