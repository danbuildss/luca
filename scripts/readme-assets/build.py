#!/usr/bin/env python3
"""Builds the README graphics in docs/assets/ from this file: one light and one dark SVG
per graphic, in Luca's palette (landing/styles.css), with Geist, Geist Mono and Newsreader
embedded as small font subsets so GitHub shows the real typefaces.

The chat cards quote Luca's real messages, produced by Luca's own code on sample data
(no real wallet, address or amount). Change wording in Luca first, then here.

  pip install fonttools brotli
  python3 scripts/readme-assets/build.py
"""
from __future__ import annotations

import base64
import io
import re
from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape

import logging

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
FONTS = Path(__file__).resolve().parent / "fonts"
OUT = ROOT / "docs" / "assets"

# --- Palette (landing/styles.css) ------------------------------------------------------
THEMES = {
    "light": dict(bg="#F4F3EE", panel="#FBFAF7", panel2="#ECEAE3", ink="#0B0B0A", ink2="#3A3A36",
                  ink3="#6E6D66", line="#0B0B0A1A", line2="#0B0B0A29", green="#1D7A4C",
                  me="#0B0B0A", on_me="#F4F3EE", mark_bg="#0B0B0A", mark_fg="#F4F3EE"),
    "dark": dict(bg="#161615", panel="#1F1F1D", panel2="#2A2A27", ink="#EDECE6", ink2="#C9C8C1",
                 ink3="#A3A29B", line="#EDECE61A", line2="#EDECE629", green="#52C48A",
                 me="#EDECE6", on_me="#0B0B0A", mark_bg="#EDECE6", mark_fg="#161615"),
}

# The Luca mark (landing/favicon.svg), 318 x 348 units
MARK = ('<path d="M85 0H102V221A30 30 0 0 0 132 251H318V283A65 65 0 0 1 253 348H85A85 85 0 0 1 0 263V85A85 85 0 0 1 85 0Z"/>'
        '<rect x="152" y="118" width="86" height="86" rx="10"/>')

# --- Fonts -------------------------------------------------------------------------------
FACES = {
    "sans": ("Geist", 400, "Geist-Regular.woff2"),
    "sans-md": ("Geist", 500, "Geist-Medium.woff2"),
    "sans-sb": ("Geist", 600, "Geist-SemiBold.woff2"),
    "mono": ("Geist Mono", 400, "GeistMono-Regular.woff2"),
    "mono-md": ("Geist Mono", 500, "GeistMono-Medium.woff2"),
    "serif": ("Newsreader", 400, "newsreader-latin-400-normal.woff2"),
    "serif-md": ("Newsreader", 500, "newsreader-latin-500-normal.woff2"),
}
FALLBACK = {"Geist": "Helvetica, Arial, sans-serif", "Geist Mono": "Menlo, Consolas, monospace",
            "Newsreader": "Georgia, 'Times New Roman', serif"}
_fonts: dict[str, TTFont] = {}


def font(key: str) -> TTFont:
    if key not in _fonts:
        _fonts[key] = TTFont(FONTS / FACES[key][2])
    return _fonts[key]


def width(text: str, key: str, size: float) -> float:
    f = font(key)
    cmap, hmtx = f.getBestCmap(), f["hmtx"]
    upm = f["head"].unitsPerEm
    total = 0
    for ch in text:
        g = cmap.get(ord(ch)) or cmap.get(ord("?"))
        total += hmtx[g][0]
    return total * size / upm


def font_css(used: dict[str, set[str]]) -> str:
    rules = []
    for key, chars in sorted(used.items()):
        family, weight, file = FACES[key]
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.layout_features = ["kern", "liga", "tnum"]
        sub = subset.Subsetter(opts)
        f = TTFont(FONTS / file)
        sub.populate(text="".join(sorted(chars)) + " ")
        sub.subset(f)
        buf = io.BytesIO()
        f.flavor = "woff2"
        f.save(buf)
        data = base64.b64encode(buf.getvalue()).decode()
        rules.append(f"@font-face{{font-family:'L-{key}';font-weight:{weight};"
                     f"src:url(data:font/woff2;base64,{data}) format('woff2')}}")
    return "".join(rules)


# --- A tiny drawing context ---------------------------------------------------------------
class Canvas:
    def __init__(self, w: int, h: int, theme: str, title: str):
        self.w, self.h, self.t, self.title = w, h, THEMES[theme], title
        self.parts: list[str] = []
        self.used: dict[str, set[str]] = {}

    def c(self, name: str) -> str:
        return self.t[name]

    def add(self, s: str) -> None:
        self.parts.append(s)

    def text(self, x: float, y: float, s: str, key: str, size: float, color: str, anchor: str = "start",
             spacing: float = 0, underline: bool = False) -> None:
        self.used.setdefault(key, set()).update(s)
        family = FACES[key][0]
        extra = f' letter-spacing="{spacing}"' if spacing else ""
        deco = ' text-decoration="underline"' if underline else ""
        self.add(f'<text x="{x:.1f}" y="{y:.1f}" font-family="\'L-{key}\', {FALLBACK[family]}" '
                 f'font-size="{size}" font-weight="{FACES[key][1]}" fill="{self.c(color)}" '
                 f'text-anchor="{anchor}"{extra}{deco}>{escape(s)}</text>')

    def line(self, x: float, y: float, runs: list["Run"], size: float, color_override: str | None = None) -> None:
        spans = []
        for r in runs:
            self.used.setdefault(r.key, set()).update(r.text)
            family = FACES[r.key][0]
            deco = ' text-decoration="underline"' if r.underline else ""
            fill = self.c(color_override or r.color)
            spans.append(f'<tspan font-family="\'L-{r.key}\', {FALLBACK[family]}" font-weight="{FACES[r.key][1]}" '
                         f'fill="{fill}"{deco}>{escape(r.text)}</tspan>')
        self.add(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" xml:space="preserve">' + "".join(spans) + "</text>")

    def rect(self, x, y, w, h, fill: str, r: float = 0, stroke: str | None = None, sw: float = 1) -> None:
        st = f' stroke="{self.c(stroke)}" stroke-width="{sw}"' if stroke else ""
        self.add(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{r}" fill="{self.c(fill)}"{st}/>')

    def mark(self, x, y, h, color: str, opacity: float = 1) -> None:
        s = h / 348
        op = f' opacity="{opacity}"' if opacity != 1 else ""
        self.add(f'<g transform="translate({x:.1f} {y:.1f}) scale({s:.4f})" fill="{self.c(color)}"{op}>{MARK}</g>')

    def avatar(self, x, y, d: float) -> None:
        self.add(f'<circle cx="{x + d / 2:.1f}" cy="{y + d / 2:.1f}" r="{d / 2:.1f}" fill="{self.c("mark_bg")}"/>')
        mh = d * 0.42
        self.mark(x + d / 2 - mh * 318 / 348 / 2, y + d / 2 - mh / 2, mh, "mark_fg")

    def svg(self) -> str:
        css = font_css(self.used)
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
                f'viewBox="0 0 {self.w} {self.h}" role="img" aria-label="{escape(self.title)}">'
                f'<title>{escape(self.title)}</title><style>{css}</style>' + "".join(self.parts) + "</svg>\n")


# --- Rich text: plain words, `code`-free; markdown links become green underlined runs -----
@dataclass
class Run:
    text: str
    key: str
    color: str
    underline: bool = False


LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def runs_of(line: str, key: str, color: str, link_color: str = "green") -> list[Run]:
    out, pos = [], 0
    for m in LINK.finditer(line):
        if m.start() > pos:
            out.append(Run(line[pos:m.start()], key, color))
        out.append(Run(m.group(1), key, link_color, True))
        pos = m.end()
    if pos < len(line):
        out.append(Run(line[pos:], key, color))
    return out


def merge(line: list[tuple[float, "Run"]]) -> tuple[float, list["Run"]]:
    start = line[0][0] if line else 0.0
    out: list[Run] = []
    for _, r in line:
        if out and (out[-1].key, out[-1].color, out[-1].underline) == (r.key, r.color, r.underline):
            out[-1] = Run(out[-1].text + r.text, r.key, r.color, r.underline)
        else:
            out.append(Run(r.text, r.key, r.color, r.underline))
    return start, out


def wrap(runs: list[Run], size: float, maxw: float, indent: float = 0) -> list[list[tuple[float, Run]]]:
    """Greedy word wrap; continuation lines start at `indent` (hanging indent for lists)."""
    words: list[Run] = []
    for r in runs:
        for i, part in enumerate(re.split(r"( )", r.text)):
            if part:
                words.append(Run(part, r.key, r.color, r.underline))
    lines: list[list[tuple[float, Run]]] = [[]]
    x = 0.0
    for w in words:
        ww = width(w.text, w.key, size)
        if w.text != " " and x + ww > maxw and lines[-1]:
            while lines[-1] and lines[-1][-1][1].text == " ":
                lines[-1].pop()
            lines.append([])
            x = indent
        if w.text == " " and not lines[-1]:
            continue
        lines[-1].append((x, w))
        x += ww
    return lines


# --- Chat pieces -------------------------------------------------------------------------
BODY, LH = 19, 28


def message_lines(text: str, maxw: float, color: str = "ink") -> list[list[tuple[float, Run]]]:
    out: list[list[tuple[float, Run]]] = []
    for para in text.split("\n"):
        if not para.strip():
            out.append([])
            continue
        m = re.match(r"^(\d+\. |- )", para)
        indent = width(m.group(1), "sans", BODY) if m else 0
        out.extend(wrap(runs_of(para, "sans", color), BODY, maxw, indent))
    return out


def bubble(cv: Canvas | None, x: float, y: float, text: str, maxw: float, me: bool = False) -> float:
    """Draws one chat bubble (or only measures it when cv is None); returns its bottom."""
    pad_x, pad_y = 20, 15
    lines = message_lines(text, maxw - 2 * pad_x, "on_me" if me else "ink")
    used = max((sum(width(r.text, r.key, BODY) for _, r in ln) + (ln[0][0] if ln else 0)) for ln in lines)
    w = min(maxw, used + 2 * pad_x + 2)
    h = len(lines) * LH + 2 * pad_y - 6
    if cv is None:
        return y + h
    bx = x + maxw - w if me else x
    cv.rect(bx, y, w, h, "me" if me else "panel2", r=18)
    for i, ln in enumerate(lines):
        if not ln:
            continue
        start, runs = merge(ln)
        cv.line(bx + pad_x + start, y + pad_y + 20 + i * LH, runs, BODY, "on_me" if me else None)
    return y + h


def chat_frame(cv: Canvas, x: float, y: float, w: float, h: float, when: str) -> float:
    cv.rect(x, y, w, h, "panel", r=22, stroke="line2")
    cv.avatar(x + 22, y + 18, 36)
    cv.text(x + 70, y + 42, "Luca", "sans-sb", 18, "ink")
    cv.text(x + w - 22, y + 42, when, "mono", 15, "ink3", anchor="end")
    cv.add(f'<line x1="{x}" y1="{y + 72}" x2="{x + w}" y2="{y + 72}" stroke="{cv.c("line")}"/>')
    return y + 96


def example_tag(cv: Canvas, x: float, y: float) -> None:
    label = "Example · sample data"
    w = width(label, "mono", 13) + 24
    cv.rect(x - w, y, w, 26, "bg", r=13, stroke="line2")
    cv.text(x - w / 2, y + 17.5, label, "mono", 13, "ink3", anchor="middle")


def caption(cv: Canvas, x: float, y: float, kicker: str, title: list[str], body: list[str]) -> None:
    cv.text(x, y, kicker.upper(), "mono-md", 14, "green", spacing=1.4)
    for i, t in enumerate(title):
        cv.text(x, y + 58 + i * 50, t, "serif", 44, "ink", spacing=-0.6)
    top = y + 58 + len(title) * 50 + 14
    for i, b in enumerate(body):
        cv.text(x, top + i * 30, b, "sans", 19, "ink2")


def panel(cv: Canvas) -> None:
    cv.rect(0.5, 0.5, cv.w - 1, cv.h - 1, "bg", r=28, stroke="line")


def watermark(cv: Canvas) -> None:
    cv.mark(cv.w - 64, cv.h - 66, 34, "ink", opacity=0.12)


# --- Graphics ----------------------------------------------------------------------------
MORNING = """Good morning. Since yesterday morning:
- Received 480 USDC from Studio client.
- Paid 24 USDC to Hosting.

2 things I couldn't place:
1. 250 USDC you received from 0x1a2b…9f3c, Oct 9 [0x8c41…d27e](x)
2. 56.65 USDC you sent to 0x7d4e…06ab, Oct 9 [0x3f90…a1b4](x)
Tell me what they were, like "1 was a swap, 2 was revenue"."""

QUESTION = """Make these 2 changes?
1. Label the USDC transfer from 0x1a2b…9f3c (on Oct 9, $250.00) as revenue
2. Label the USDC payment to 0x7d4e…06ab (on Oct 9, $56.65) as expense

Reply yes or no."""

DONE = """Done:
- Labeled the USDC transfer from 0x1a2b…9f3c (on Oct 9, $250.00) as revenue
- Labeled the USDC payment to 0x7d4e…06ab (on Oct 9, $56.65) as expense

New transfers with this address will be labeled the same way."""

CHECK_ACK = ("Checking the last 30 days across your 2 wallets against the chain now. "
             "I'll message you with the result, usually within a few minutes.")
CHECK_RESULT = ("I checked everything across your 2 wallets over the last 30 days (Sep 9, 09:12 to Oct 9, 09:12): "
                "214 transactions, 231 supported financial movements.\nEvery supported movement reached your books.")


def chat_panel(theme, name, title, kicker, heading, body, when, messages):
    fx, fw, top = 540, 676, 40
    # Measure first, so the card fits its messages exactly
    y = top + 96
    for text, me in messages:
        y = bubble(None, 0, y, text, fw - 44, me) + 12
    h = max(int(y + 60 + top), 480)
    cv = Canvas(1280, h, theme, title)
    panel(cv)
    caption(cv, 64, 92, kicker, heading, body)
    y = chat_frame(cv, fx, top, fw, h - 2 * top, when)
    for text, me in messages:
        y = bubble(cv, fx + 22, y, text, fw - 44, me) + 12
    example_tag(cv, fx + fw - 22, h - top - 40)
    watermark(cv)
    return name, cv


def morning(theme):
    return chat_panel(theme, "card-morning", "Example of Luca's morning message, on sample data", "Every morning",
                      ["One message,", "only if it matters."],
                      ["What came in, what went out and", "what it was for. What it can't place,", "it asks about once, numbered."],
                      "08:00", [(MORNING, False)])


def answer(theme):
    return chat_panel(theme, "card-answer", "Example of answering Luca by number and confirming, on sample data",
                      "You answer, it asks once", ["Nothing changes", "without a yes."],
                      ["Answer in your own words or by number.", "Luca shows exactly what it will change,",
                       "then learns the address for next time."],
                      "08:14", [("1 was revenue, 2 was an expense", True), (QUESTION, False), ("yes", True), (DONE, False)])


def check(theme):
    return chat_panel(theme, "card-check", "Example of Luca checking the books against the chain, on sample data",
                      "Proven, not promised", ["Books checked", "against the chain."],
                      ["Ask any time. Luca re-reads the chain", "and tells you exactly what it covered,",
                       "and anything missing, by transaction."],
                      "09:12", [("Check my books for the last 30 days", True), (CHECK_ACK, False), (CHECK_RESULT, False)])


def hero(theme):
    cv = Canvas(1280, 520, theme, "Luca: keeps the books on the wallets that work while you sleep")
    panel(cv)
    cv.mark(64, 60, 40, "ink")
    cv.text(110, 92, "Luca", "sans-sb", 30, "ink")
    for i, t in enumerate(["Keeps the books on the", "wallets that work", "while you sleep."]):
        cv.text(64, 196 + i * 66, t, "serif", 60, "ink", spacing=-1.2)
    cv.text(64, 418, "On-chain bookkeeping you talk to in Telegram.", "sans", 21, "ink2")
    cv.text(64, 456, "BASE  ·  ETH, USDC, BNKR  ·  READ-ONLY", "mono-md", 14, "ink3", spacing=1.4)
    # A ledger card: what the books say, and that they are proven
    x, y, w = 772, 64, 444
    cv.rect(x, y, w, 392, "panel", r=22, stroke="line2")
    cv.text(x + 28, y + 46, "YOUR BOOKS · LAST 30 DAYS", "mono-md", 13, "ink3", spacing=1.2)
    rows = [("Revenue", "+$4,810.00", "green"), ("Expenses", "−$1,940.00", "ink"), ("Swaps", "$1,204.33", "ink3"),
            ("Network fees", "−$8.42", "ink"), ("Unknown", "$306.65", "ink3")]
    for i, (k, v, col) in enumerate(rows):
        ry = y + 96 + i * 46
        cv.text(x + 28, ry, k, "sans", 19, "ink2")
        cv.text(x + w - 28, ry, v, "mono", 19, col, anchor="end")
        if i < len(rows) - 1:
            cv.add(f'<line x1="{x + 28}" y1="{ry + 18}" x2="{x + w - 28}" y2="{ry + 18}" stroke="{cv.c("line")}"/>')
    cv.rect(x + 28, y + 318, w - 56, 46, "panel2", r=12)
    cv.add(f'<circle cx="{x + 52}" cy="{y + 341}" r="6" fill="{cv.c("green")}"/>')
    cv.text(x + 68, y + 347, "Every balance proven against the chain", "sans-md", 16, "ink")
    example_tag(cv, x + w, y + 400)
    return "hero", cv


STAGES = [
    ("Base", ["Every transfer and", "network fee, read", "from the chain"]),
    ("Ingestion", ["Raw evidence kept,", "cross-checked against", "token transfer logs"]),
    ("Ledger", ["Balances proven to", "the smallest unit,", "every hour"]),
    ("Labels", ["Transaction shape,", "then your rules,", "then AI as a guess"]),
    ("You", ["Morning message,", "alerts and answers", "in Telegram"]),
]


def flow_books(theme):
    cv = Canvas(1280, 456, theme, "How Luca keeps your books: Base, ingestion, ledger proof, labels, then you in Telegram")
    panel(cv)
    cv.text(64, 84, "HOW LUCA KEEPS YOUR BOOKS", "mono-md", 14, "green", spacing=1.4)
    cv.text(64, 132, "From the chain to your chat, checked at every step.", "serif", 34, "ink", spacing=-0.4)
    n, gap, x0, y0 = len(STAGES), 22, 64, 178
    w = (1280 - 2 * x0 - gap * (n - 1)) / n
    for i, (name, lines) in enumerate(STAGES):
        x = x0 + i * (w + gap)
        last = i == n - 1
        cv.rect(x, y0, w, 186, "panel" if not last else "me", r=18, stroke=None if last else "line2")
        fg, sub = ("on_me", "on_me") if last else ("ink", "ink2")
        cv.text(x + 22, y0 + 38, f"0{i + 1}", "mono", 14, "ink3" if not last else "on_me")
        cv.text(x + 22, y0 + 76, name, "sans-sb", 24, fg)
        for j, t in enumerate(lines):
            cv.text(x + 22, y0 + 112 + j * 24, t, "sans", 16, sub)
        if not last:
            ax = x + w + gap / 2
            cv.add(f'<path d="M{ax - 6} {y0 + 80} l8 6 -8 6" fill="none" stroke="{cv.c("ink3")}" stroke-width="2" '
                   f'stroke-linecap="round" stroke-linejoin="round"/>')
    by = y0 + 208
    bx, bw = x0 + (w + gap), 3 * w + 2 * gap
    cv.rect(bx, by, bw, 44, "panel2", r=12)
    cv.text(bx + bw / 2, by + 28, "One PostgreSQL database: the only source of financial truth",
            "sans-md", 16, "ink", anchor="middle")
    watermark(cv)
    return "flow-books", cv


STEPS = [
    ("Luca asks", "about a transfer it can't place, once, in the morning message."),
    ("You answer", "in your own words, or by number: “1 was revenue”."),
    ("One yes", "Luca lists exactly what will change. Nothing moves before “yes”."),
    ("It learns", "that address is labeled the same way, before and after."),
    ("History kept", "the old label stays on record, with your words and the rule it taught."),
]


def flow_teach(theme):
    cv = Canvas(1280, 440, theme, "Teach Luca once: it asks, you answer, you confirm with one yes, it learns, and history is kept")
    panel(cv)
    cv.text(64, 84, "TEACH IT ONCE", "mono-md", 14, "green", spacing=1.4)
    cv.text(64, 132, "Tell Luca once. It remembers for every transfer after.", "serif", 34, "ink", spacing=-0.4)
    y0, x0 = 186, 64
    cv.add(f'<line x1="{x0 + 22}" y1="{y0 + 22}" x2="{x0 + 22}" y2="{y0 + 4 * 46 + 22}" stroke="{cv.c("line2")}" stroke-width="2"/>')
    for i, (head, rest) in enumerate(STEPS):
        y = y0 + i * 46
        cv.add(f'<circle cx="{x0 + 22}" cy="{y + 22}" r="17" fill="{cv.c("me") if i == 2 else cv.c("panel")}" '
               f'stroke="{cv.c("line2")}"/>')
        cv.text(x0 + 22, y + 28, str(i + 1), "mono-md", 15, "on_me" if i == 2 else "ink", anchor="middle")
        cv.line(x0 + 60, y + 29, [Run(head + "  ", "sans-sb", "ink"), Run(rest, "sans", "ink2")], 19)
    watermark(cv)
    return "flow-teach", cv


NEVER = ["Sign a transaction", "Move or send funds", "Swap, trade or bridge",
         "Approve a contract", "Ask for keys or seed phrases", "Show your books to another user"]


def never(theme):
    cv = Canvas(1280, 400, theme, "Read-only by design. Luca never signs, moves funds, swaps, approves contracts, asks for keys, or shows your books to another user")
    panel(cv)
    cv.text(64, 84, "READ-ONLY BY DESIGN", "mono-md", 14, "green", spacing=1.4)
    cv.text(64, 132, "Luca can see. It can never touch.", "serif", 34, "ink", spacing=-0.4)
    cols, x0, y0, gap = 3, 64, 172, 18
    w = (1280 - 2 * x0 - gap * (cols - 1)) / cols
    for i, item in enumerate(NEVER):
        x, y = x0 + (i % cols) * (w + gap), y0 + (i // cols) * 92
        cv.rect(x, y, w, 74, "panel", r=16, stroke="line2")
        cx, cy = x + 38, y + 37
        cv.add(f'<circle cx="{cx}" cy="{cy}" r="13" fill="none" stroke="{cv.c("ink3")}" stroke-width="2"/>'
               f'<line x1="{cx - 9}" y1="{cy + 9}" x2="{cx + 9}" y2="{cy - 9}" stroke="{cv.c("ink3")}" stroke-width="2"/>')
        cv.text(x + 66, y + 32, "NEVER", "mono-md", 12, "ink3", spacing=1.2)
        cv.text(x + 66, y + 55, item, "sans-md", 18, "ink")
    watermark(cv)
    return "never", cv


# --- Buttons (one version: they sit on either GitHub theme) --------------------------------
def button(name: str, label: str, primary: bool, with_mark: bool = False) -> tuple[str, Canvas]:
    size = 15
    tw = width(label, "sans-md", size)
    w = int(tw + (66 if with_mark else 44))
    cv = Canvas(w, 40, "light", label)
    cv.rect(0.5, 0.5, w - 1, 39, "ink" if primary else "panel", r=20, stroke=None if primary else "line2")
    x = 22
    if with_mark:
        cv.mark(20, 12, 16, "bg" if primary else "ink")
        x = 44
    cv.text(x, 25.5, label, "sans-md", size, "bg" if primary else "ink")
    return name, cv


BUTTONS = [("btn-access", "Request access", True, True), ("btn-site", "askluca.xyz", False, False),
           ("btn-x", "@AskLucaAI on X", False, False)]
DOCS = [("doc-architecture", "Architecture"), ("doc-rules", "Operating rules"), ("doc-deployment", "Deployment"),
        ("doc-security", "Security"), ("doc-contributing", "Contributing")]


def main() -> None:
    logging.getLogger("fontTools").setLevel(logging.ERROR)
    OUT.mkdir(parents=True, exist_ok=True)
    built = []
    for theme in THEMES:
        for make in (hero, morning, answer, check, flow_books, flow_teach, never):
            name, cv = make(theme)
            path = OUT / f"{name}-{theme}.svg"
            path.write_text(cv.svg())
            built.append(path)
    for name, label, primary, with_mark in BUTTONS:
        n, cv = button(name, label, primary, with_mark)
        (OUT / f"{n}.svg").write_text(cv.svg())
        built.append(OUT / f"{n}.svg")
    for name, label in DOCS:
        n, cv = button(name, label, False)
        (OUT / f"{n}.svg").write_text(cv.svg())
        built.append(OUT / f"{n}.svg")
    for p in built:
        print(f"{p.relative_to(ROOT)}  {p.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
