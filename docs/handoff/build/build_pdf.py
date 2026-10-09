"""Builds docs/handoff/Fernhill-Order-Sync-Handoff.pdf from the handoff Markdown files.

Free local tools only: pandoc (Markdown -> HTML), Google Chrome 131+ headless (HTML -> PDF, page numbers via CSS
page margin boxes) and pypdf (reads pass 1 to put real page numbers into the table of contents, adds bookmarks).
The architecture diagram is rendered by Mermaid, loaded from cdn.jsdelivr.net at print time (needs internet).

Usage:  python docs/handoff/build/build_pdf.py        (set CHROME=<path> if Chrome is not in the default place)
"""
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from pypdf import PdfReader, PdfWriter

HANDOFF = Path(__file__).resolve().parents[1]
REPO = HANDOFF.parents[1]
OUT = HANDOFF / "Fernhill-Order-Sync-Handoff.pdf"
DOCS = sorted(p.name for p in HANDOFF.glob("0[1-9]-*.md"))
VERSION, DATE = "1.0", "9 October 2026"
MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"
CHROME = os.environ.get("CHROME") or next(
    (p for p in [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                 r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                 shutil.which("google-chrome") or "", shutil.which("chromium") or ""] if p and Path(p).exists()), None)


def to_html(md_name: str):
    """One document as an HTML section, with ids prefixed per document and links rewritten for a single PDF."""
    num = md_name[:2]
    out = subprocess.run(["pandoc", "-f", "gfm", "-t", "html5", "--wrap=none", md_name], cwd=HANDOFF,
                         capture_output=True, text=True, encoding="utf-8", check=True).stdout
    out = re.sub(r' id="([^"]+)"', rf' id="d{num}-\1"', out)

    def href(m):
        url = m.group(1)
        if re.match(r"^(https?:|mailto:)", url):
            return m.group(0)
        if url.startswith("#"):
            return f'href="#d{num}-{url[1:]}"'
        doc = re.match(r"^(\d\d)-[A-Z0-9-]+\.md(?:#(.*))?$", url)
        if doc:
            return f'href="#d{doc.group(1)}-{doc.group(2)}"' if doc.group(2) else f'href="#doc-{doc.group(1)}"'
        return 'class="local"'  # a file outside the package: no link in the PDF

    out = re.sub(r'href="([^"]+)"', href, out)
    out = re.sub(r'<a class="local">(.*?)</a>', r'', out, flags=re.S)
    out = re.sub(r'src="([^"]+)"', lambda m: m.group(0) if m.group(1).startswith("http")
                 else f'src="{(HANDOFF / m.group(1)).resolve().as_uri()}"', out)
    out = re.sub(r'<pre class="mermaid"><code>(.*?)</code></pre>', r'<pre class="mermaid">\1</pre>', out, flags=re.S)
    title = re.sub(r"<[^>]+>", "", re.search(r"<h1[^>]*>(.*?)</h1>", out, re.S).group(1))
    subs = [(i, re.sub(r"<[^>]+>", "", t)) for i, t in re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', out, re.S)]
    return num, html.unescape(title), [(i, html.unescape(t)) for i, t in subs], f'<section class="doc" id="doc-{num}">{out}</section>'


def page(docs, pages, markers):
    """The whole book as HTML. `pages` maps an anchor id to its page number (empty on pass 1)."""
    def entry(cls, anchor, text):
        mark = f'<span class="mk">@@{anchor}@@</span>' if markers else ""
        return (f'<li class="{cls}"><a href="#{anchor}">{html.escape(text)}</a>{mark}<span class="dots"></span>'
                f'<span class="pg">{pages.get(anchor, "00")}</span></li>')

    toc = []
    body = []
    for num, title, subs, section in docs:
        toc.append(entry("doc", f"doc-{num}", title))
        toc += [entry("sub", anchor, text) for anchor, text in subs]
        if markers:  # invisible, absolutely positioned: does not move layout; found by text extraction on pass 1
            section = re.sub(r'(<h[12] id="([^"]+)"[^>]*>)', r'\1<span class="mk">@@\2@@</span>', section)
            section = section.replace(f'<section class="doc" id="doc-{num}">',
                                      f'<section class="doc" id="doc-{num}"><span class="mk">@@doc-{num}@@</span>', 1)
        body.append(section)
    css = (HANDOFF / "build" / "handoff.css").read_text(encoding="utf-8")
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Fernhill Order Sync: Client Handoff v{VERSION}</title>
<style>{css}
.mk {{ position: absolute; left: 0; font-size: 1pt; color: #fff; }} h1, h2, section.doc {{ position: relative; }}
.toc .mk {{ display: none; }}</style>
<script src="{MERMAID}"></script>
<script>mermaid.initialize({{ startOnLoad: true, theme: 'neutral', securityLevel: 'strict', flowchart: {{ htmlLabels: false }} }});</script>
</head><body>
<div class="cover">
  <div class="kicker">Client handoff package</div>
  <h1>Fernhill Order Sync</h1>
  <p class="subtitle">HubSpot ↔ Supabase order and contact integration</p>
  <div class="meta">Prepared by <strong>Media &amp; Software Manager</strong><br>
  Version {VERSION} · {DATE}<br>
  Live demo: fernhill-order-sync.vercel.app</div>
  <div class="note"><strong>Demo notice.</strong> Fernhill Supply Co. is a fictional company. The live system holds only
  synthetic data: generated names, @example.com email addresses and seeded orders. This document contains no passwords,
  tokens or keys.</div>
</div>
<nav class="toc"><h1>Contents</h1><ol>{''.join(toc)}</ol></nav>
{''.join(body)}
</body></html>"""


def print_pdf(html_text: str, pdf: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "handoff.html"
        src.write_text(html_text, encoding="utf-8")
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                        "--virtual-time-budget=20000",
                        f"--print-to-pdf={pdf}", src.as_uri()], capture_output=True, timeout=180, check=True)


def main() -> None:
    if not CHROME:
        sys.exit("Chrome not found; set CHROME to its path")
    docs = [to_html(d) for d in DOCS]
    anchors = [a for num, _, subs, _ in docs for a in [f"doc-{num}"] + [s for s, _ in subs]]

    with tempfile.TemporaryDirectory() as tmp:
        draft = Path(tmp) / "pass1.pdf"
        print_pdf(page(docs, {}, markers=True), draft)
        reader = PdfReader(draft)
        pages = {}
        for n, p in enumerate(reader.pages, start=1):
            for a in re.findall(r"@@([A-Za-z0-9_-]+)@@", (p.extract_text() or "").replace("\n", "")):
                pages.setdefault(a, n)
        missing = [a for a in anchors if a not in pages]
        if missing:
            sys.exit(f"page numbers not found for: {missing}")
        draft_pages = len(reader.pages)

    print_pdf(page(docs, {a: str(n) for a, n in pages.items()}, markers=False), OUT)
    # Bookmarks from the same page map (Chrome's own outline repeats titles of headings that start a page).
    writer = PdfWriter(clone_from=OUT)
    writer.add_outline_item("Contents", 1)
    for num, title, subs, _ in docs:
        parent = writer.add_outline_item(title, pages[f"doc-{num}"] - 1)
        for anchor, text in subs:
            writer.add_outline_item(text, pages[anchor] - 1, parent=parent)
    writer.page_mode = "/UseOutlines"
    with open(OUT, "wb") as f:
        writer.write(f)
    final_pages = len(PdfReader(OUT).pages)
    if final_pages != draft_pages:
        sys.exit(f"page count changed between passes ({draft_pages} -> {final_pages}); rerun")
    print(f"wrote {OUT.relative_to(REPO)} ({final_pages} pages, {OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
