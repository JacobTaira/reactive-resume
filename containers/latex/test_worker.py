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

from worker import bounded_text, compile_project, Handler, inspect_pdf, overfull_box_warnings, ProjectError, run_pdf_tool, unpack_project, validate_project


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
    def test_rejects_invalid_expected_page_counts(self):
        for expected in (0, 101, -1, True, "2", 1.5):
            with self.subTest(expected=expected), self.assertRaises(ProjectError):
                compile_project(project(), expected_page_count=expected)

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


class PdfInspectionTests(unittest.TestCase):
    def inspect(self, info="Pages: 5\n", text="Example candidate\n", expected=None):
        with patch("worker.run_pdf_tool", side_effect=[
            {"status": "success", "output": info, "error": None},
            {"status": "success", "output": text, "error": None},
        ]):
            return inspect_pdf(Path("/tmp/example/resume.pdf"), {"count": 0, "messages": [], "truncated": False}, expected)

    def test_reports_actual_pages_without_assuming_a_one_page_target(self):
        checks = self.inspect()
        self.assertEqual(checks["pageCount"], 5)
        self.assertIsNone(checks["expectedPageCount"])
        self.assertIsNone(checks["pageCountMatches"])
        self.assertEqual(checks["textExtraction"]["status"], "success")
        self.assertEqual(checks["textExtraction"]["characterCount"], len("Example candidate"))

    def test_compares_explicit_page_targets_including_mismatch(self):
        self.assertTrue(self.inspect(expected=5)["pageCountMatches"])
        self.assertFalse(self.inspect(expected=4)["pageCountMatches"])
        self.assertEqual(self.inspect(info="Title: example\nPages: 999\nPages: 5\n")["pageCount"], 5)

    def test_reports_empty_text_instead_of_marking_extraction_as_passed(self):
        text = self.inspect(text=" \n\x0c\t")["textExtraction"]
        self.assertEqual(text["status"], "empty")
        self.assertEqual(text["characterCount"], 0)
        self.assertEqual(text["text"], "")

    def test_page_excerpts_identify_spillover_without_changing_flat_text(self):
        original = "  Candidate name\n\nExperience\nFirst-page evidence\n\x0c  Skills spilled to page two\nPython, C++\n\x0c\n"
        extraction = self.inspect(info="Pages: 2\n", text=original)["textExtraction"]
        self.assertEqual(extraction["text"], original.replace("\x0c", "\n").strip())
        self.assertEqual(extraction["pages"], [
            {
                "page": 1, "characterCount": len("Candidate name\n\nExperience\nFirst-page evidence"),
                "lineCount": 3, "firstLines": "Candidate name\nExperience\nFirst-page evidence",
                "lastLines": "Candidate name\nExperience\nFirst-page evidence",
            },
            {
                "page": 2, "characterCount": len("Skills spilled to page two\nPython, C++"),
                "lineCount": 2, "firstLines": "Skills spilled to page two\nPython, C++",
                "lastLines": "Skills spilled to page two\nPython, C++",
            },
        ])

    def test_keeps_real_blank_pages_and_discards_only_the_terminal_separator(self):
        pages = self.inspect(text="First page\x0c \n\x0cThird page\x0c")["textExtraction"]["pages"]
        self.assertEqual([page["page"] for page in pages], [1, 2, 3])
        self.assertEqual(pages[1], {"page": 2, "characterCount": 0, "lineCount": 0, "firstLines": "", "lastLines": ""})
        self.assertEqual(pages[2]["firstLines"], "Third page")
        blank = self.inspect(text="\x0c\x0c")["textExtraction"]["pages"]
        self.assertEqual(len(blank), 2)
        self.assertEqual([page["characterCount"] for page in blank], [0, 0])
        self.assertEqual(self.inspect(text="")["textExtraction"]["pages"], [])

    def test_bounds_page_details_and_excerpts_without_losing_tail_text(self):
        first_page = "Start " + "😀" * 600 + "\nSecond line\nThird line\nFourth line\n" + "😀" * 600 + " End"
        original = "\x0c".join([first_page, *(f"Page {page}" for page in range(2, 13))]) + "\x0c"
        pages = self.inspect(text=original)["textExtraction"]["pages"]
        self.assertEqual(len(pages), 10)
        self.assertEqual(pages[-1]["firstLines"], "Page 10")
        self.assertEqual(pages[0]["characterCount"], len(first_page))
        self.assertEqual(pages[0]["lineCount"], 5)
        self.assertTrue(pages[0]["firstLines"].startswith("Start "))
        self.assertTrue(pages[0]["lastLines"].endswith(" End"))
        for excerpt in (pages[0]["firstLines"], pages[0]["lastLines"]):
            self.assertLessEqual(len(excerpt.encode("utf-16-le")), 500 * 2)

    def test_bounds_returned_text_and_preview_but_counts_full_text(self):
        original = "Résumé evidence 😀 " * 5_000
        text = self.inspect(text=original)["textExtraction"]
        self.assertTrue(text["truncated"])
        self.assertEqual(text["characterCount"], len(original.strip()))
        self.assertLessEqual(len(text["text"].encode("utf-16-le")), 50_000 * 2)
        self.assertLessEqual(len(text["preview"].encode("utf-16-le")), 1_000 * 2)
        self.assertTrue(original.startswith(text["text"]))
        self.assertEqual(bounded_text("a😀b", 2), "a")

    def test_extraction_failure_or_missing_tools_are_explicit(self):
        for status in ("failed", "unavailable"):
            with self.subTest(status=status), patch("worker.run_pdf_tool", return_value={"status": status, "output": "", "error": "Inspection unavailable."}):
                checks = inspect_pdf(Path("/tmp/resume.pdf"), {"count": 0, "messages": [], "truncated": False}, 2)
                self.assertIsNone(checks["pageCount"])
                self.assertIsNone(checks["pageCountMatches"])
                self.assertEqual(checks["textExtraction"]["status"], status)
                self.assertIsNone(checks["textExtraction"]["characterCount"])
                self.assertEqual(checks["textExtraction"]["text"], "")
                self.assertNotIn("pages", checks["textExtraction"])

    def test_overflow_counts_hbox_and_vbox_and_bounds_warning_details(self):
        transcript = io.BytesIO(("Underfull \\hbox (badness 10000)\n" + "Overfull \\hbox (12pt too wide) at lines 1--2\n" * 24 + "Overfull \\vbox (2pt too high) at line 3\n").encode())
        result = overfull_box_warnings(transcript)
        self.assertEqual(result["count"], 25)
        self.assertEqual(len(result["messages"]), 20)
        self.assertTrue(result["truncated"])

    def test_pdf_tool_failure_timeout_and_output_limits(self):
        with patch("worker.shutil.which", return_value=None):
            self.assertEqual(run_pdf_tool("pdftotext", [], Path("/tmp"))["status"], "unavailable")
        with patch("worker.shutil.which", return_value="/usr/bin/pdftotext"), patch("worker.subprocess.run", side_effect=subprocess.TimeoutExpired("pdftotext", 5)):
            result = run_pdf_tool("pdftotext", [], Path("/tmp"))
            self.assertEqual(result["status"], "failed")
            self.assertIn("time limit", result["error"])
        def oversized(*_args, **kwargs):
            kwargs["stdout"].write(b"x" * 17)
            return subprocess.CompletedProcess([], 0)
        with patch("worker.MAX_INSPECTION_BYTES", 16), patch("worker.shutil.which", return_value="/usr/bin/pdftotext"), patch("worker.subprocess.run", side_effect=oversized):
            self.assertIn("size limit", run_pdf_tool("pdftotext", [], Path("/tmp"))["error"])


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

    def test_cache_keeps_distinct_expected_page_targets(self):
        token = "test-token-" * 4
        data = project(SOURCE + "% target cache fixture")
        def compiled(_project, expected_page_count=None):
            return {"success": True, "pdf": "JVBERi0=", "log": "", "checks": {"expectedPageCount": expected_page_count}}
        with patch.dict(os.environ, {"LATEX_COMPILER_TOKEN": token}), patch("worker.compile_project", side_effect=compiled) as compiler:
            first = self.request("/compile", token=token, body={**data, "expectedPageCount": 1})
            second = self.request("/compile", token=token, body={**data, "expectedPageCount": 2})
            repeated = self.request("/compile", token=token, body={**data, "expectedPageCount": 1})
        self.assertEqual(first[1]["checks"]["expectedPageCount"], 1)
        self.assertEqual(second[1]["checks"]["expectedPageCount"], 2)
        self.assertEqual(repeated, first)
        self.assertEqual(compiler.call_count, 2)


@unittest.skipUnless(shutil.which("pdflatex"), "PDFLaTeX is not installed")
class CompilationTests(unittest.TestCase):
    def test_checks_expected_page_count_and_extracts_text_on_compile(self):
        source = SOURCE.replace("\\end{document}", "\\newpage Second page evidence.\\end{document}")
        result = compile_project(project(source), expected_page_count=1)
        self.assertTrue(result["success"], result["log"])
        self.assertEqual(result["checks"]["expectedPageCount"], 1)
        if shutil.which("pdfinfo"):
            self.assertEqual(result["checks"]["pageCount"], 2)
            self.assertFalse(result["checks"]["pageCountMatches"])
        if shutil.which("pdftotext"):
            self.assertEqual(result["checks"]["textExtraction"]["status"], "success")
            self.assertIn("Second page evidence", result["checks"]["textExtraction"]["text"])
            self.assertEqual(len(result["checks"]["textExtraction"]["pages"]), 2)
            self.assertIn("Second page evidence", result["checks"]["textExtraction"]["pages"][1]["firstLines"])

    def test_reports_native_tex_overflow_warnings(self):
        source = SOURCE.replace("Built a robotics", r"\hbox to 1pt{Overflow fixture} Built a robotics")
        result = compile_project(project(source))
        self.assertTrue(result["success"], result["log"])
        self.assertGreater(result["checks"]["overfullBoxes"]["count"], 0)
        self.assertIn("Overfull", result["checks"]["overfullBoxes"]["messages"][0])

    def test_reports_native_empty_extraction_without_failing_pdf(self):
        result = compile_project(project(r"\documentclass{article}\pagestyle{empty}\begin{document}\null\end{document}"))
        self.assertTrue(result["success"], result["log"])
        if shutil.which("pdftotext"):
            self.assertEqual(result["checks"]["textExtraction"]["status"], "empty")

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
