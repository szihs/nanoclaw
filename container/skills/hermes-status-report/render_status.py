#!/usr/bin/env python3
"""render_status.py -- deterministic one-screen HTML status card grid.

Reads ONE JSON payload on stdin, writes a self-contained HTML file to argv[1].
Stdlib only. No network, no external assets, no JavaScript, no fonts to fetch --
the output opens identically from a dashboard artifacts view, a file:// URL, or
an email attachment.

WHY A SCRIPT AND NOT HAND-WRITTEN HTML. The layout is the contract: six small
cards, one screen, no scrolling. A model hand-writing HTML drifts every day
(different palette, different spacing, an extra section) and the human loses the
at-a-glance property that is the whole point. The model's job is to produce the
JSON facts; the layout is frozen here.

Payload schema (every field optional except `cards`; unknown keys ignored):

  {
    "generated_at": "2026-09-03T05:12:00Z",   # rendered in the sub-line + footer
    "title":        "Hermes port - nemoclaw-coworkers",
    "subtitle":     "3 Sep 2026 - box slang-cpu-coworkers - dashboard :3937",
    "headline":     "One sentence the human reads first.",
    "footer":       "Green = done - amber = in flight - grey = queued.",
    "cards": [
      {
        "title": "Milestones",
        "kind":  "rows" | "chain" | "metric" | "progress",
        "rows":  [{"state": "ok|run|todo|bad", "text": "...", "note": "done"}],
        "chain": ["Orchestrator -> architect -> builder", "..."],
        "metric":   {"value": "12 / 12", "label": "smoke -- reliable gate"},
        "progress": {"done": 4, "active": 2, "todo": 55},
        "note":  "short prose with real numbers"
      }
    ]
  }

Robustness rules (all exercised by test_render_status.py):
  * unknown `kind`            -> card skipped, an HTML comment marks the skip
  * missing / null fields     -> that element is simply omitted, never a crash
  * non-string values         -> coerced with str()
  * EVERY string is HTML-escaped (quotes included) before it reaches the output
  * a card that raises for any reason is skipped with a comment, not fatal

Usage:
  python3 render_status.py /path/to/out.html  < payload.json
"""

import html
import json
import math
import sys

# Kinds this renderer knows. Anything else is skipped with a comment so a
# forward-dated payload degrades to "one missing card", never a blank report.
KNOWN_KINDS = ("rows", "chain", "metric", "progress")

# Row state -> dot class. An absent/unknown state renders the row with NO dot
# (the reference report's cost card is exactly that shape: label + number).
STATES = ("ok", "run", "todo", "bad")

# Palette + typography are a verbatim lift of reports/hermes-port-status.html --
# the hand-made reference the human approved. Dark GitHub-ish, 14px system UI,
# auto-fit 310px card grid so six cards land on one screen at any sane width.
CSS = """\
:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--line:#30363d;--ok:#3fb950;\
--run:#d29922;--todo:#6e7681;--bad:#f85149;--acc:#58a6ff}
*{box-sizing:border-box}body{margin:0;padding:28px;background:var(--bg);color:var(--fg);\
font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
h1{font-size:19px;margin:0 0 2px}.sub{color:var(--mut);font-size:12px;margin-bottom:12px}
.headline{font-size:14px;color:var(--fg);border-left:3px solid var(--acc);padding:2px 0 2px 10px;\
margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:14px}
.card{border:1px solid var(--line);border-radius:9px;padding:13px 15px;background:#161b22}
.card h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--mut);\
margin:0 0 10px;font-weight:600}
.row{display:flex;align-items:baseline;gap:9px;padding:3px 0;border-bottom:1px solid #21262d}\
.row:last-child{border:0}
.row .t{flex:1}.row .n{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;position:relative;top:-1px}
.ok{background:var(--ok)}.run{background:var(--run)}.todo{background:var(--todo)}\
.bad{background:var(--bad)}
.chain{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.75;\
color:#c9d1d9;white-space:pre-wrap}
.chain b{color:var(--acc);font-weight:600}
.big{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}\
.big span{font-size:12px;color:var(--mut);font-weight:400}
.bar{height:7px;border-radius:4px;background:#21262d;overflow:hidden;margin:9px 0 4px;display:flex}
.bar i{display:block;height:100%}
.note{color:var(--mut);font-size:12px;margin-top:9px}
.k{color:var(--acc)}.err{color:var(--bad)}.gd{color:var(--ok)}
footer{color:var(--mut);font-size:11px;margin-top:18px;border-top:1px solid var(--line);\
padding-top:10px}
"""

DEFAULT_TITLE = "Hermes port · nemoclaw-coworkers"
DEFAULT_FOOTER = "Green = done · amber = in flight · grey = queued."


def esc(value):
    """HTML-escape anything. Non-strings are str()'d first; None -> ''."""
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    return html.escape(value, quote=True)


def accent_arrows(escaped):
    """Accent-colour the chain arrows AFTER escaping.

    Safe by construction: it runs on already-escaped text and only wraps two
    non-special Unicode characters, so no attacker-controlled byte can become
    markup. Purely cosmetic -- the reference report colours its arrows blue.
    """
    for arrow in ("→", "←"):
        escaped = escaped.replace(arrow, f"<b>{arrow}</b>")
    return escaped


def as_list(value):
    return value if isinstance(value, list) else []


def as_dict(value):
    return value if isinstance(value, dict) else {}


def text_of(obj, key):
    """Escaped string for obj[key], or '' when absent/blank."""
    if not isinstance(obj, dict):
        return ""
    return esc(obj.get(key))


def non_negative(value):
    """Coerce a count to a finite float >= 0. Junk / NaN / inf / negative -> 0."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n) or n < 0:
        return 0.0
    return n


def count_str(n):
    """'4' for a whole count, '4.5' otherwise -- captions must not read '4.0'."""
    return str(int(n)) if float(n).is_integer() else f"{n:g}"


def render_rows(rows):
    """`rows` -> dot/label/number lines. A row with no text is dropped."""
    out = []
    for row in as_list(rows):
        if not isinstance(row, dict):
            continue
        text = text_of(row, "text")
        if not text:
            continue
        state = row.get("state")
        dot = f'<i class="dot {state}"></i>' if state in STATES else ""
        note = text_of(row, "note")
        note_html = f'<span class="n">{note}</span>' if note else ""
        out.append(f'<div class="row">{dot}<span class="t">{text}</span>{note_html}</div>')
    return out


def render_chain(chain):
    """`chain` -> one monospace block, one payload entry per line."""
    lines = [esc(line) for line in as_list(chain) if esc(line)]
    if not lines:
        return []
    body = accent_arrows("\n".join(lines))
    return [f'<div class="chain">{body}</div>']


def render_metric(metric):
    """`metric` -> the big number plus a muted label."""
    metric = as_dict(metric)
    value = text_of(metric, "value")
    if not value:
        return []
    label = text_of(metric, "label")
    label_html = f"<span>{label}</span>" if label else ""
    return [f'<div class="big">{value} {label_html}</div>']


def render_progress(progress):
    """`progress` -> proportional done/active/todo bar plus a count caption."""
    progress = as_dict(progress)
    done = non_negative(progress.get("done"))
    active = non_negative(progress.get("active"))
    todo = non_negative(progress.get("todo"))
    total = done + active + todo
    if total <= 0:
        return []
    parts = []
    for cls, count in (("ok", done), ("run", active), ("todo", todo)):
        if count <= 0:
            continue
        width = 100.0 * count / total
        parts.append(f'<i class="{cls}" style="width:{width:.2f}%"></i>')
    caption = (
        f"{count_str(done)} done · {count_str(active)} in flight · "
        f"{count_str(todo)} queued — of {count_str(total)}"
    )
    bar = "".join(parts)
    return [f'<div class="bar">{bar}</div>', f'<div class="note">{esc(caption)}</div>']


def render_card(card):
    """One card -> HTML, or an HTML comment explaining why it was skipped."""
    if not isinstance(card, dict):
        return "<!-- skipped card: not an object -->"
    kind = card.get("kind")
    if kind not in KNOWN_KINDS:
        return f"<!-- skipped card: unknown kind {esc(repr(kind))} -->"

    body = []
    # The kind picks the PRIMARY element; any other element present is rendered
    # after it. That is how the reference's e2e card carries a big number, a
    # bar and a note at once without needing a fifth kind.
    if kind == "chain":
        body += render_chain(card.get("chain"))
    elif kind == "metric":
        body += render_metric(card.get("metric"))
    elif kind == "progress":
        body += render_progress(card.get("progress"))

    if kind != "chain":
        body += render_chain(card.get("chain"))
    if kind != "metric":
        body += render_metric(card.get("metric"))
    if kind != "progress":
        body += render_progress(card.get("progress"))
    body += render_rows(card.get("rows"))

    note = text_of(card, "note")
    if note:
        body.append(f'<div class="note">{note}</div>')

    title = text_of(card, "title")
    head = f"<h2>{title}</h2>" if title else ""
    return f'<div class="card">{head}{"".join(body)}</div>'


def render(payload):
    """Full document. Never raises on a malformed card -- it skips it."""
    payload = as_dict(payload)
    generated_at = text_of(payload, "generated_at")
    title = text_of(payload, "title") or esc(DEFAULT_TITLE)
    subtitle = text_of(payload, "subtitle") or generated_at
    headline = text_of(payload, "headline")
    footer = text_of(payload, "footer") or esc(DEFAULT_FOOTER)

    cards = []
    for card in as_list(payload.get("cards")):
        try:
            cards.append(render_card(card))
        # A malformed card must cost one card, never the whole briefing, so the
        # blanket catch is the point here -- the class name is reported inline.
        except Exception as exc:  # noqa: BLE001
            cards.append(f"<!-- skipped card: render error {esc(type(exc).__name__)} -->")

    foot = f"{footer} &middot; generated {generated_at}" if generated_at else footer
    headline_html = f'<div class="headline">{headline}</div>\n' if headline else ""

    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{title}</title>\n<style>\n{CSS}</style></head><body>\n"
        f"<h1>{title}</h1>\n"
        f'<div class="sub">{subtitle}</div>\n'
        f"{headline_html}"
        f'<div class="grid">\n' + "\n".join(cards) + "\n</div>\n"
        f"<footer>{foot}</footer>\n"
        "</body></html>\n"
    )


def main(argv):
    if len(argv) != 1:
        sys.stderr.write("usage: render_status.py <out.html>   (payload JSON on stdin)\n")
        return 2
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError as exc:
        sys.stderr.write(f"render_status.py: payload is not valid JSON: {exc}\n")
        return 1
    out_path = argv[0]
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(render(payload))
    cards = len(as_list(as_dict(payload).get("cards")))
    sys.stderr.write(f"render_status.py: wrote {out_path} ({cards} card(s) submitted)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
