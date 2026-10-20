"""Private, bounded PDFLaTeX worker. Run in the accompanying restricted container."""

import base64
import binascii
import hashlib
import hmac
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zipfile import BadZipFile, ZipFile

MAX_FILES = 100
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_PROJECT_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_PDF_BYTES = 12 * 1024 * 1024
MAX_LOG_BYTES = 64 * 1024
MAX_INSPECTION_BYTES = 8 * 1024 * 1024
MAX_EXTRACTED_TEXT_CHARS = 50_000
MAX_TEXT_PREVIEW_CHARS = 1_000
MAX_TEXT_PAGE_DETAILS = 10
MAX_PAGE_EXCERPT_CHARS = 500
MAX_PAGE_EXCERPT_LINES = 3
MAX_OVERFULL_MESSAGES = 20
ALLOWED_EXTENSIONS = {
    ".tex", ".sty", ".cls", ".clo", ".cfg", ".def", ".bib", ".bst", ".bbl",
    ".png", ".jpg", ".jpeg", ".pdf", ".eps", ".tfm", ".enc", ".map", ".pfb",
    ".afm", ".txt", ".md",
}
COMPILE_LOCK = threading.BoundedSemaphore(1)
COMPILE_CACHE = OrderedDict()
MAX_CACHE_BYTES = 32 * 1024 * 1024


class ProjectError(ValueError):
    pass


def safe_path(value):
    if not isinstance(value, str) or not value or len(value) > 240:
        raise ProjectError("A project file has an invalid path.")
    parts = value.split("/")
    if any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _.-]*", part) for part in parts):
        raise ProjectError("Use relative file paths without hidden files or parent directories.")
    if PurePosixPath(value).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise ProjectError("This project contains an unsupported file type.")
    if parts[0] == "rr-build":
        raise ProjectError("The reserved rr-build path cannot be included in a project.")
    return value


def validate_project(project):
    if not isinstance(project, dict) or project.get("engine") != "pdflatex":
        raise ProjectError("This installation supports PDFLaTeX projects.")
    entrypoint = safe_path(project.get("entrypoint"))
    if not entrypoint.lower().endswith(".tex"):
        raise ProjectError("Choose a .tex file as the main document.")
    files = project.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise ProjectError("Projects must contain between 1 and 100 files.")
    decoded = {}
    seen = set()
    total = 0
    for item in files:
        if not isinstance(item, dict):
            raise ProjectError("Invalid project file.")
        path = safe_path(item.get("path"))
        if path.casefold() in seen:
            raise ProjectError("Duplicate project file paths are not allowed.")
        seen.add(path.casefold())
        content = item.get("content")
        if not isinstance(content, str) or len(content) > MAX_FILE_BYTES * 2:
            raise ProjectError("A project file is too large.")
        encoding = item.get("encoding")
        try:
            if encoding == "utf-8":
                data = content.encode("utf-8")
            elif encoding == "base64":
                data = base64.b64decode(content, validate=True)
            else:
                raise ProjectError("Unsupported file encoding.")
        except (binascii.Error, UnicodeError) as error:
            raise ProjectError("A project file has invalid encoding.") from error
        total += len(data)
        if len(data) > MAX_FILE_BYTES or total > MAX_PROJECT_BYTES:
            raise ProjectError("The project exceeds the file or total size limit.")
        decoded[path] = data
    if entrypoint not in decoded:
        raise ProjectError("The main document is missing from the project.")
    # A file must never also be another file's containing directory.
    for path in decoded:
        if any(parent.as_posix().casefold() in seen for parent in PurePosixPath(path).parents if str(parent) != "."):
            raise ProjectError("Conflicting file and directory paths.")
    return entrypoint, decoded


def unpack_project(archive):
    if not isinstance(archive, str) or len(archive) > MAX_REQUEST_BYTES:
        raise ProjectError("The archive is too large.")
    try:
        data = base64.b64decode(archive, validate=True)
        if len(data) > MAX_ARCHIVE_BYTES:
            raise ProjectError("Source ZIPs must be 8 MiB or smaller.")
        with ZipFile(io.BytesIO(data)) as zipped:
            entries = zipped.infolist()
            if len(entries) > MAX_FILES * 3:
                raise ProjectError("The archive contains too many entries.")
            files = []
            total = 0
            for entry in entries:
                if entry.is_dir():
                    continue
                if stat.S_ISLNK(entry.external_attr >> 16):
                    raise ProjectError("Symbolic links are not supported.")
                if any(part in ("..", "") for part in entry.filename.split("/")) or "\\" in entry.filename:
                    raise ProjectError("The archive contains an unsafe path.")
                if entry.filename.startswith("__MACOSX/") or any(p.startswith(".") for p in entry.filename.split("/")):
                    continue
                if PurePosixPath(entry.filename).suffix.lower() not in ALLOWED_EXTENSIONS:
                    continue
                path = safe_path(entry.filename)
                if entry.file_size > MAX_FILE_BYTES or total + entry.file_size > MAX_PROJECT_BYTES:
                    raise ProjectError("The archive exceeds the project size limit.")
                with zipped.open(entry) as handle:
                    content = handle.read(MAX_FILE_BYTES + 1)
                total += len(content)
                if len(content) > MAX_FILE_BYTES or total > MAX_PROJECT_BYTES:
                    raise ProjectError("The archive exceeds the project size limit.")
                try:
                    text = content.decode("utf-8")
                    encoding = "utf-8"
                except UnicodeDecodeError:
                    text = base64.b64encode(content).decode("ascii")
                    encoding = "base64"
                files.append({"path": path, "content": text, "encoding": encoding})
                if len(files) > MAX_FILES:
                    raise ProjectError("The archive contains too many files.")
    except (BadZipFile, binascii.Error, RuntimeError, NotImplementedError) as error:
        raise ProjectError("The ZIP archive could not be read.") from error
    tex = [f for f in files if f["path"].lower().endswith(".tex")]
    if not tex:
        raise ProjectError("The archive does not contain a .tex document.")
    main = next((f for f in tex if f["path"] == "main.tex"), None)
    main = main or next((f for f in tex if "\\documentclass" in f["content"]), tex[0])
    project = {"engine": "pdflatex", "entrypoint": main["path"], "files": files}
    validate_project(project)
    return project


def overfull_box_warnings(transcript):
    """Count final-pass warnings without retaining the document's verbose TeX output."""
    count = 0
    messages = []
    transcript.seek(0)
    while True:
        # Bound individual reads as well: TeX can print a very long source line.
        line = transcript.readline(MAX_LOG_BYTES)
        if not line:
            break
        for warning in re.finditer(rb"Overfull \\[hv]box[^\r\n]*", line):
            count += 1
            if len(messages) < MAX_OVERFULL_MESSAGES:
                messages.append(warning.group().decode("utf-8", errors="replace")[:500])
    return {"count": count, "messages": messages, "truncated": count > len(messages)}


def run_pdf_tool(tool, arguments, directory):
    executable = shutil.which(tool)
    if not executable:
        return {"status": "unavailable", "output": "", "error": "The PDF inspection tool is unavailable."}
    try:
        with tempfile.TemporaryFile() as output:
            process = subprocess.run(
                [executable, *arguments], cwd=directory, stdin=subprocess.DEVNULL,
                stdout=output, stderr=subprocess.DEVNULL, timeout=5,
                env={"PATH": os.defpath, "HOME": str(directory), "LANG": "C.UTF-8"},
            )
            if process.returncode != 0:
                return {"status": "failed", "output": "", "error": "The PDF inspection tool could not read this PDF."}
            output.seek(0, 2)
            if output.tell() > MAX_INSPECTION_BYTES:
                return {"status": "failed", "output": "", "error": "The PDF check output exceeded the size limit."}
            output.seek(0)
            return {"status": "success", "output": output.read(MAX_INSPECTION_BYTES).decode("utf-8", errors="replace"), "error": None}
    except subprocess.TimeoutExpired:
        return {"status": "failed", "output": "", "error": "The PDF inspection tool exceeded the time limit."}
    except OSError:
        return {"status": "failed", "output": "", "error": "The PDF inspection tool could not run."}


def bounded_text(text, limit):
    # The API's JavaScript string limits count UTF-16 code units, including surrogate pairs.
    return text.encode("utf-16-le")[:limit * 2].decode("utf-16-le", errors="ignore")


def pdf_text_pages(text):
    """Keep bounded page excerpts from pdftotext's existing form-feed boundaries."""
    if not text:
        return []
    # The final form feed terminates the last page; it does not start another page.
    # Bound splitting as well as returned details for documents with many pages.
    pages = text.split("\x0c", MAX_TEXT_PAGE_DETAILS)
    if len(pages) > 1 and not pages[-1].strip():
        pages.pop()
    details = []
    for number, page in enumerate(pages[:MAX_TEXT_PAGE_DETAILS], start=1):
        page_text = page.strip()
        lines = [line.strip() for line in page_text.splitlines() if line.strip()]
        last_lines = "\n".join(lines[-MAX_PAGE_EXCERPT_LINES:])
        details.append({
            "page": number,
            "characterCount": len(page_text),
            "lineCount": len(lines),
            "firstLines": bounded_text("\n".join(lines[:MAX_PAGE_EXCERPT_LINES]), MAX_PAGE_EXCERPT_CHARS),
            "lastLines": last_lines.encode("utf-16-le")[-MAX_PAGE_EXCERPT_CHARS * 2:].decode("utf-16-le", errors="ignore"),
        })
    return details


def inspect_pdf(pdf, overfull_boxes, expected_page_count=None):
    """Local, bounded PDF checks; these do not establish visual quality or ATS compatibility."""
    info = run_pdf_tool("pdfinfo", [str(pdf)], pdf.parent)
    # pdfinfo prints document-controlled title fields before its own Pages line.
    pages = re.findall(r"^Pages:[ \t]+(\d+)[ \t]*$", info["output"], re.MULTILINE)
    page_count = int(pages[-1]) if pages else None
    if page_count == 0:
        page_count = None
    page_error = None if page_count else info["error"] or "The PDF page count could not be determined."
    extraction = run_pdf_tool("pdftotext", ["-enc", "UTF-8", "-layout", str(pdf), "-"], pdf.parent)
    text = extraction["output"].replace("\x0c", "\n").strip()
    status = ("success" if text else "empty") if extraction["status"] == "success" else extraction["status"]
    extracted = bounded_text(text, MAX_EXTRACTED_TEXT_CHARS)
    return {
        "pageCount": page_count,
        "expectedPageCount": expected_page_count,
        "pageCountMatches": page_count == expected_page_count if page_count is not None and expected_page_count is not None else None,
        "pageCountError": page_error,
        "overfullBoxes": overfull_boxes,
        "textExtraction": {
            "status": status,
            "characterCount": len(text) if extraction["status"] == "success" else None,
            "text": extracted,
            "preview": bounded_text(text, MAX_TEXT_PREVIEW_CHARS),
            "truncated": len(extracted) < len(text),
            "error": extraction["error"],
            **({"pages": pdf_text_pages(extraction["output"])} if extraction["status"] == "success" else {}),
        },
    }


def compile_project(project, timeout=30, expected_page_count=None):
    if expected_page_count is not None and (type(expected_page_count) is not int or not 1 <= expected_page_count <= 100):
        raise ProjectError("Expected page count must be between 1 and 100, or omitted.")
    entrypoint, files = validate_project(project)
    compiler = shutil.which("pdflatex")
    if not compiler:
        return {"success": False, "log": "PDFLaTeX is not installed in the compiler service."}
    with tempfile.TemporaryDirectory(prefix="rr-latex-") as directory:
        work = Path(directory)
        for path, content in files.items():
            destination = work / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        output = work / "rr-build"
        if output.exists():
            raise ProjectError("The reserved rr-build path cannot be included in a project.")
        output.mkdir()
        # No application credentials or compiler token enter the TeX process.
        environment = {
            "PATH": str(Path(compiler).parent) + os.pathsep + os.defpath,
            "HOME": directory,
            "LANG": "C.UTF-8",
            "openin_any": "p",
            "openout_any": "p",
            "shell_escape": "f",
            "TEXMFOUTPUT": directory,
            "TEXMFVAR": str(work / "texmf-var"),
            "TEXMFCONFIG": str(work / "texmf-config"),
        }
        command = [
            compiler, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error",
            "-file-line-error", "-jobname=resume", "-output-directory=rr-build", entrypoint,
        ]
        log = ""
        # Two passes resolve the document's links and cross references. Never execute latexmkrc.
        deadline = time.monotonic() + timeout
        overflow = {"count": 0, "messages": [], "truncated": False}
        for _ in range(2):
            with tempfile.TemporaryFile() as transcript:
                process = subprocess.Popen(
                    command, cwd=work, env=environment, stdin=subprocess.DEVNULL,
                    stdout=transcript, stderr=subprocess.STDOUT, start_new_session=True,
                )
                try:
                    process.wait(timeout=max(0.01, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    return {"success": False, "log": "Compilation exceeded the time limit."}
                transcript.seek(0, 2)
                truncated = transcript.tell() > MAX_LOG_BYTES
                transcript.seek(max(0, transcript.tell() - MAX_LOG_BYTES))
                log = transcript.read(MAX_LOG_BYTES).decode("utf-8", errors="replace")
                if truncated:
                    log = "[Earlier compiler output omitted]\n" + log
                log = log.replace(directory, "[project]")
                if process.returncode != 0:
                    return {"success": False, "log": log}
                overflow = overfull_box_warnings(transcript)
        pdf = output / "resume.pdf"
        if not pdf.exists() or pdf.stat().st_size > MAX_PDF_BYTES:
            return {"success": False, "log": "Compilation did not produce a PDF within the size limit."}
        content = pdf.read_bytes()
        if not content.startswith(b"%PDF-"):
            return {"success": False, "log": "The compiler did not produce a valid PDF."}
        checks = inspect_pdf(pdf, overflow, expected_page_count)
        return {"success": True, "pdf": base64.b64encode(content).decode("ascii"), "log": log, "checks": checks}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        # Do not log source, request bodies, tokens, or compilation output.
        pass

    def respond(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.respond(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        self.connection.settimeout(15)
        token = os.environ.get("LATEX_COMPILER_TOKEN", "")
        if not token or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
            self.respond(401, {"error": "Unauthorized"})
            return
        if self.path not in ("/compile", "/unpack"):
            self.respond(404, {"error": "Not found"})
            return
        if not COMPILE_LOCK.acquire(timeout=35):
            self.respond(503, {"error": "The compiler is busy. Try again shortly."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_REQUEST_BYTES:
                self.respond(413, {"error": "The project is too large."})
                return
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ProjectError("Provide a project object.")
            if self.path == "/compile":
                key = hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()
                if key in COMPILE_CACHE:
                    result = COMPILE_CACHE[key]
                    COMPILE_CACHE.move_to_end(key)
                else:
                    result = compile_project(body, expected_page_count=body.get("expectedPageCount"))
                    if result["success"]:
                        COMPILE_CACHE[key] = result
                        while len(COMPILE_CACHE) > 8 or sum(len(value["pdf"]) for value in COMPILE_CACHE.values()) > MAX_CACHE_BYTES:
                            COMPILE_CACHE.popitem(last=False)
            else:
                result = unpack_project(body.get("archive"))
            self.respond(200, result)
        except (ProjectError, ValueError, TypeError, KeyError, UnicodeError) as error:
            self.respond(400, {"error": str(error)})
        except OSError:
            self.respond(500, {"error": "The compiler could not run. Check the compiler installation."})
        finally:
            COMPILE_LOCK.release()


if __name__ == "__main__":
    if len(os.environ.get("LATEX_COMPILER_TOKEN", "")) < 32:
        raise SystemExit("Set LATEX_COMPILER_TOKEN to a secret of at least 32 characters.")
    ThreadingHTTPServer(("0.0.0.0", 8010), Handler).serve_forever()
