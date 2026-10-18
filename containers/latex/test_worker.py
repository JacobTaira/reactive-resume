import base64
import io
import json
import http.client
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from zipfile import ZipFile, ZipInfo

from worker import compile_project, Handler, ProjectError, unpack_project, validate_project


SOURCE = r"""\documentclass[10pt,letterpaper]{article}
\usepackage[T1]{fontenc}
\usepackage{charter}
\usepackage[margin=0.5in]{geometry}
\usepackage{enumitem,titlesec,needspace,xcolor}
\usepackage[hidelinks]{hyperref}
\pagestyle{empty}
\begin{document}
\begin{center}\textbf{Example Candidate}\end{center}
\section*{Research Experience}
\begin{itemize}\item Built a robotics simulation and verified its results.\end{itemize}
\end{document}
"""


def project(source=SOURCE):
    return {"engine": "pdflatex", "entrypoint": "main.tex", "files": [
        {"path": "main.tex", "encoding": "utf-8", "content": source},
    ]}


def archive(entries):
    buffer = io.BytesIO()
    with ZipFile(buffer, "w") as zipped:
        for name, content in entries:
            zipped.writestr(name, content)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class ProjectTests(unittest.TestCase):
    def test_rejects_unsafe_and_duplicate_paths(self):
        for path in ("../secret.tex", "/etc/secret.tex", "a/../b.tex", "a\\b.tex", "-main.tex", ".hidden.tex"):
            data = project()
            data["files"][0]["path"] = path
            with self.subTest(path=path), self.assertRaises(ProjectError):
                validate_project(data)
        data = project()
        data["files"].append({"path": "MAIN.tex", "encoding": "utf-8", "content": "duplicate"})
        with self.assertRaises(ProjectError):
            validate_project(data)

    def test_rejects_missing_entrypoint_invalid_base64_and_large_files(self):
        for data in (
            {**project(), "entrypoint": "missing.tex"},
            {**project(), "engine": "lualatex"},
            {**project(), "files": [{"path": "main.tex", "encoding": "base64", "content": "%%%"}]},
            project("x" * (2 * 1024 * 1024 + 1)),
        ):
            with self.assertRaises(ProjectError):
                validate_project(data)

    def test_unpacks_multifile_project_without_rewriting_source(self):
        source = SOURCE.replace("\\begin{document}", "\\input{parts/macros}\n\\begin{document}")
        data = unpack_project(archive([
            ("main.tex", source), ("parts/macros.tex", "\\newcommand{\\example}{Example}"),
            ("figure.png", b"\x89PNG\r\n\x1a\n\xff"), (".latexmkrc", "must never execute"),
        ]))
        self.assertEqual(data["entrypoint"], "main.tex")
        self.assertEqual(data["files"][0]["content"], source)
        self.assertEqual(len(data["files"]), 3)
        self.assertEqual(data["files"][2]["encoding"], "base64")
        self.assertEqual(validate_project(data)[1]["figure.png"], b"\x89PNG\r\n\x1a\n\xff")

    def test_rejects_zip_traversal_symlinks_and_bombs(self):
        link = ZipInfo("link.tex")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in (
            [("../main.tex", SOURCE)], [(link, "main.tex")],
            [("main.tex", SOURCE), ("huge.txt", "x" * (2 * 1024 * 1024 + 1))],
        ):
            with self.assertRaises(ProjectError):
                unpack_project(archive(entries))

    def test_rejects_reserved_build_directory(self):
        data = project()
        data["files"].append({"path": "rr-build/resume.tex", "encoding": "utf-8", "content": ""})
        with self.assertRaises(ProjectError):
            compile_project(data)

    def test_rejects_case_insensitive_file_directory_conflicts(self):
        data = project()
        data["files"].append({"path": "MAIN.tex/part.tex", "encoding": "utf-8", "content": ""})
        with self.assertRaises(ProjectError):
            validate_project(data)

    def test_enforces_archive_byte_limit(self):
        with patch("worker.MAX_ARCHIVE_BYTES", 16):
            with self.assertRaises(ProjectError):
                unpack_project(archive([("main.tex", SOURCE)]))


class WorkerHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, path, token=None, body=None, method="POST"):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        headers = {} if token is None else {"Authorization": "Bearer " + token}
        try:
            connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_health_does_not_require_credentials(self):
        self.assertEqual(self.request("/health", method="GET"), (200, {"ok": True}))

    def test_rejects_missing_or_incorrect_token_without_compiling(self):
        with patch.dict(os.environ, {"LATEX_COMPILER_TOKEN": "test-token-" * 4}):
            with patch("worker.compile_project") as compiler:
                self.assertEqual(self.request("/compile", body=project())[0], 401)
                self.assertEqual(self.request("/compile", token="wrong", body=project())[0], 401)
                compiler.assert_not_called()

    def test_authenticated_source_import_preserves_original_source(self):
        token = "test-token-" * 4
        with patch.dict(os.environ, {"LATEX_COMPILER_TOKEN": token}):
            status, result = self.request("/unpack", token=token, body={"archive": archive([("main.tex", SOURCE)])})
        self.assertEqual(status, 200)
        self.assertEqual(result["files"][0]["content"], SOURCE)

    def test_rejects_invalid_project_with_clear_bad_request(self):
        token = "test-token-" * 4
        with patch.dict(os.environ, {"LATEX_COMPILER_TOKEN": token}):
            status, result = self.request("/compile", token=token, body=project("x" * (2 * 1024 * 1024 + 1)))
        self.assertEqual(status, 400)
        self.assertIn("size limit", result["error"])


@unittest.skipUnless(shutil.which("pdflatex"), "PDFLaTeX is not installed")
class CompilationTests(unittest.TestCase):
    def test_compiles_imported_multifile_project(self):
        source = SOURCE.replace("\\begin{document}", "\\input{parts/macros}\n\\begin{document}")
        source = source.replace("Built a robotics", "\\example a robotics")
        data = unpack_project(archive([
            ("main.tex", source), ("parts/macros.tex", "\\newcommand{\\example}{Built}"),
        ]))
        result = compile_project(data)
        self.assertTrue(result["success"], result["log"])

    def test_preserves_letter_size_charter_and_readable_text(self):
        result = compile_project(project())
        self.assertTrue(result["success"], result["log"])
        pdf = base64.b64decode(result["pdf"])
        self.assertTrue(pdf.startswith(b"%PDF-"))
        if not all(shutil.which(command) for command in ("pdfinfo", "pdftotext", "pdffonts")):
            return
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "resume.pdf"
            path.write_bytes(pdf)
            metadata = subprocess.check_output(["pdfinfo", str(path)], text=True)
            text = subprocess.check_output(["pdftotext", str(path), "-"], text=True)
            fonts = subprocess.check_output(["pdffonts", str(path)], text=True)
        self.assertIn("612 x 792", metadata)
        self.assertIn("Example Candidate", text)
        self.assertIn("Charter", fonts)

    def test_reports_errors_instead_of_returning_stale_pdf(self):
        result = compile_project(project(SOURCE.replace("Built", "\\undefinedcommand Built")))
        self.assertFalse(result["success"])
        self.assertNotIn("pdf", result)
        self.assertIn("Undefined control sequence", result["log"])

    def test_blocks_reading_files_outside_project(self):
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / "secret.tex"
            secret.write_text("EXTERNAL_PRIVATE_CONTENT")
            source = SOURCE.replace("Built", "\\input{" + str(secret) + "} Built")
            result = compile_project(project(source))
        self.assertFalse(result["success"])
        self.assertNotIn("EXTERNAL_PRIVATE_CONTENT", result["log"])

    def test_kills_nonterminating_tex(self):
        source = SOURCE.replace("\\end{document}", "\\loop\\iftrue\\repeat\\end{document}")
        result = compile_project(project(source), timeout=1)
        self.assertFalse(result["success"])
        self.assertIn("time limit", result["log"])


if __name__ == "__main__":
    unittest.main()
