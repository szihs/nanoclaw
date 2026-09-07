"""Unit tests for render_status.py (stdlib unittest, no third-party deps).

Run:
  python3 -m unittest discover -s container/skills/hermes-status-report -p 'test_*.py' -v
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "render_status.py")

# Load the renderer by path rather than by name: the skill dir is not a package
# and is mirrored to /home/node/.claude/skills/<name>/ inside the container, so
# there is never an importable module named `render_status` on sys.path.
_spec = importlib.util.spec_from_file_location("render_status", SCRIPT)
render_status = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(render_status)


def representative_payload():
    """The six-card shape the skill actually emits, one card per kind."""
    return {
        "generated_at": "2026-09-03T05:12:00Z",
        "title": "Hermes port · nemoclaw-coworkers",
        "subtitle": "3 Sep 2026 · box slang-cpu-coworkers",
        "headline": "Round 5 is running; 4 of 61 rows are merged and no coworker is cost-stopped.",
        "cards": [
            {
                "title": "The team",
                "kind": "chain",
                "chain": [
                    "Orchestrator → architect → builder",
                    "              → tester → reviewer",
                ],
                "note": "5 coworkers, forced A2A wiring, critique gates on.",
            },
            {
                "title": "Milestones",
                "kind": "rows",
                "rows": [
                    {"state": "ok", "text": "P1-HELLO dry run", "note": "closed"},
                    {"state": "run", "text": "Merge gate v2", "note": "building"},
                    {"state": "todo", "text": "T1–T12 fixtures", "note": "queued"},
                    {"state": "bad", "text": "3 candidate upstream bugs", "note": "unfiled"},
                ],
            },
            {
                "title": "61 requirement rows",
                "kind": "progress",
                "progress": {"done": 4, "active": 2, "todo": 55},
                "note": "Ledger rows counted by status column.",
            },
            {
                "title": "Desktop e2e",
                "kind": "metric",
                "metric": {"value": "12 / 12", "label": "smoke — reliable gate"},
                "rows": [{"text": "Full suite", "note": "44 pass / 17 fail / 13 skip"}],
                "note": "Numbers from the JSON reporter only.",
            },
            {
                "title": "Pinned baseline",
                "kind": "chain",
                "chain": [
                    "release tree  v2026.8.31",
                    "fork branch   release/v2026.8.31-e2e-fixed",
                ],
            },
            {
                "title": "Cost posture",
                "kind": "rows",
                "rows": [
                    {"text": "Cap / ceiling per coworker", "note": "$150"},
                    {"text": "Escalations pending", "note": "0"},
                ],
                "note": "ncl cost-cap escalations --state pending",
            },
        ],
    }


class RenderStatusTest(unittest.TestCase):
    def render_to_file(self, payload):
        """Render via the module and return (path, html_text)."""
        fd, path = tempfile.mkstemp(suffix=".html")
        os.close(fd)
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(render_status.render(payload))
        with open(path, encoding="utf-8") as fh:
            return path, fh.read()

    # --- the happy path ---------------------------------------------------

    def test_writes_a_file_that_looks_like_html(self):
        path, out = self.render_to_file(representative_payload())
        self.assertTrue(os.path.exists(path))
        self.assertGreater(os.path.getsize(path), 0)
        self.assertTrue(out.startswith("<!doctype html>"))
        for marker in ("<html", "</html>", "<head", "<body", "</body>", "<style", "</style>"):
            self.assertIn(marker, out)
        # Self-contained: no external assets, no JS.
        self.assertNotIn("<script", out)
        self.assertNotIn("http://", out)
        self.assertNotIn("https://", out)

    def test_headline_and_title_are_present(self):
        _, out = self.render_to_file(representative_payload())
        self.assertIn("Round 5 is running", out)
        self.assertIn('class="headline"', out)
        self.assertIn("Hermes port", out)
        self.assertIn("2026-09-03T05:12:00Z", out)

    def test_one_section_per_card(self):
        payload = representative_payload()
        _, out = self.render_to_file(payload)
        self.assertEqual(out.count('<div class="card">'), len(payload["cards"]))
        for card in payload["cards"]:
            self.assertIn(f"<h2>{card['title']}</h2>", out)

    def test_each_kind_renders_its_primary_element(self):
        _, out = self.render_to_file(representative_payload())
        self.assertIn('class="chain"', out)  # chain
        self.assertIn('class="dot ok"', out)  # rows
        self.assertIn('class="dot run"', out)
        self.assertIn('class="dot todo"', out)
        self.assertIn('class="dot bad"', out)
        self.assertIn('class="bar"', out)  # progress
        self.assertIn('class="big"', out)  # metric
        self.assertIn("12 / 12", out)
        # progress caption reflects the counts it was given
        self.assertIn("4 done", out)
        self.assertIn("55 queued", out)
        self.assertIn("of 61", out)

    def test_row_without_state_renders_without_a_dot(self):
        _, out = self.render_to_file(
            {"cards": [{"title": "Cost", "kind": "rows", "rows": [{"text": "Cap", "note": "$150"}]}]}
        )
        self.assertIn("Cap", out)
        self.assertIn("$150", out)
        self.assertNotIn('class="dot', out)

    # --- escaping ---------------------------------------------------------

    def test_everything_is_html_escaped(self):
        hostile = '<script>alert("x")</script> & <b>bold</b>'
        payload = {
            "title": hostile,
            "subtitle": hostile,
            "headline": hostile,
            "footer": hostile,
            "cards": [
                {
                    "title": hostile,
                    "kind": "rows",
                    "rows": [{"state": "ok", "text": hostile, "note": hostile}],
                    "note": hostile,
                },
                {"title": "c", "kind": "chain", "chain": [hostile]},
                {"title": "m", "kind": "metric", "metric": {"value": hostile, "label": hostile}},
            ],
        }
        _, out = self.render_to_file(payload)
        self.assertNotIn("<script", out)
        self.assertNotIn("</script>", out)
        self.assertNotIn("<b>bold</b>", out)
        self.assertIn("&lt;script&gt;", out)
        self.assertIn("&amp;", out)
        self.assertIn("&quot;x&quot;", out)
        # the only <b> tags in the document are the renderer's own arrow accents
        self.assertEqual(out.count("<b>"), 0)

    def test_arrow_accent_is_added_only_around_arrows(self):
        _, out = self.render_to_file({"cards": [{"title": "t", "kind": "chain", "chain": ["a → b ← c"]}]})
        self.assertIn("<b>→</b>", out)
        self.assertIn("<b>←</b>", out)

    # --- robustness -------------------------------------------------------

    def test_unknown_kind_is_skipped_not_fatal(self):
        _, out = self.render_to_file(
            {
                "headline": "still here",
                "cards": [
                    {"title": "Weird", "kind": "sparkline", "rows": [{"text": "x"}]},
                    {"title": "Fine", "kind": "rows", "rows": [{"state": "ok", "text": "kept"}]},
                ],
            }
        )
        self.assertIn("skipped card: unknown kind", out)
        self.assertNotIn("Weird", out)
        self.assertIn("kept", out)
        self.assertIn("still here", out)
        self.assertEqual(out.count('<div class="card">'), 1)

    def test_missing_optional_fields_are_tolerated(self):
        for payload in (
            {},
            {"cards": []},
            {"cards": [{"kind": "rows"}]},
            {"cards": [{"title": "t", "kind": "chain"}]},
            {"cards": [{"title": "t", "kind": "metric", "metric": {}}]},
            {"cards": [{"title": "t", "kind": "progress", "progress": {"done": 0, "active": 0, "todo": 0}}]},
            {"cards": [{"title": "t", "kind": "rows", "rows": [{"text": None}, "not-a-dict", 7]}]},
            {"cards": [None, 5, "x"]},
            {"cards": "not-a-list"},
            {"headline": None, "generated_at": None, "cards": [{"title": "t", "kind": "rows", "rows": None}]},
        ):
            with self.subTest(payload=payload):
                _, out = self.render_to_file(payload)
                self.assertIn("<html", out)
                self.assertIn("</html>", out)
                self.assertIn("<footer>", out)

    def test_non_string_and_junk_values_are_coerced(self):
        _, out = self.render_to_file(
            {
                "headline": 42,
                "cards": [
                    {"title": 7, "kind": "rows", "rows": [{"state": "nope", "text": 12, "note": 3.5}]},
                    {"title": "p", "kind": "progress", "progress": {"done": "x", "active": -4, "todo": 3}},
                ],
            }
        )
        self.assertIn("42", out)
        self.assertIn("12", out)
        self.assertIn("3.5", out)
        self.assertNotIn('class="dot nope"', out)  # unknown state -> no dot
        self.assertIn('class="bar"', out)  # junk/negative counts floored to 0

    def test_defaults_when_title_and_footer_omitted(self):
        _, out = self.render_to_file({"cards": []})
        self.assertIn("Hermes port", out)
        self.assertIn("Green = done", out)

    # --- the CLI contract the SKILL.md actually invokes --------------------

    def test_cli_reads_stdin_and_writes_argv1(self):
        fd, path = tempfile.mkstemp(suffix=".html")
        os.close(fd)
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        proc = subprocess.run(
            [sys.executable, SCRIPT, path],
            input=json.dumps(representative_payload()),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(path, encoding="utf-8") as fh:
            out = fh.read()
        self.assertIn("Round 5 is running", out)
        self.assertEqual(out.count('<div class="card">'), 6)

    def test_cli_rejects_invalid_json_without_writing(self):
        proc = subprocess.run(
            [sys.executable, SCRIPT, os.devnull],
            input="{not json",
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("not valid JSON", proc.stderr)

    def test_cli_requires_an_output_path(self):
        proc = subprocess.run(
            [sys.executable, SCRIPT], input="{}", capture_output=True, text=True, check=False
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage:", proc.stderr)


if __name__ == "__main__":
    unittest.main()
