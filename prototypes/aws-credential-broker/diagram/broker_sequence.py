"""Render the AWS credential broker sequence diagram from vendored draw.io stencils.

One model, three outputs, all deterministic:
  broker-sequence.svg     standalone SVG (light palette baked), re-openable in draw.io
  broker-sequence.drawio  editable draw.io file (icons embedded as shape=stencil(...))
  README.md               richdocs source; the inline SVG paints with the viewer's
                          CSS variables, so it flips with the light/dark toggle

Run from the repo root:
  uv run --no-project prototypes/aws-credential-broker/diagram/broker_sequence.py
"""

from __future__ import annotations

import html
import sys
from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import quoteattr

RICHDOCS = Path.home() / ".claude/plugins/cache/jpeakai/jpai-essentials/0.15.1/skills/richdocs"
sys.path.insert(0, str(RICHDOCS / "scripts"))
from stencil import load_stencils  # noqa: E402  # pyright: ignore[reportMissingImports]  (resolved via sys.path above)

OUT = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Actor:
    id: str
    label: str
    icon: str
    color: str  # CSS colour or var(); AWS service colours are fixed brand hues


@dataclass(frozen=True)
class Msg:
    src: str
    dst: str
    label: str
    reply: bool = False


@dataclass(frozen=True)
class Phase:
    title: str
    msgs: tuple[Msg, ...]


ACTORS = [
    Actor("vm", "Claude Code\ncloud session VM", "mxgraph.aws4/client", "var(--rd-fg)"),
    Actor("proxy", "Anthropic agent proxy\n(holds network secret)", "mxgraph.aws4/data encryption key", "var(--rd-accent)"),
    Actor("broker", "Credential broker\nLambda Function URL", "mxgraph.aws4/lambda function", "#ED7100"),
    Actor("sts", "AWS STS\nclaude-s3-readonly role", "mxgraph.aws4/role", "#DD344C"),
    Actor("s3", "Amazon S3\nsource data bucket", "mxgraph.aws4/s3", "#7AA116"),
]

PHASES = [
    Phase("1. Boot", (
        Msg("vm", "vm", "setup script writes ~/.aws/config\ncredential_process = broker-creds"),
    )),
    Phase("2. Fetch credentials (first AWS call)", (
        Msg("vm", "vm", "aws s3 cp …\nCLI runs credential_process"),
        Msg("vm", "proxy", "GET https://‹id›.lambda-url…on.aws\nno auth header in the VM"),
        Msg("proxy", "proxy", "host matches network secret\nadd Authorization: Bearer ‹token›"),
        Msg("proxy", "broker", "request + bearer token\n(token never enters the VM)"),
        Msg("broker", "broker", "constant-time compare\nreject on mismatch (401)"),
        Msg("broker", "sts", "AssumeRole(claude-s3-readonly,\nDurationSeconds=3600)"),
        Msg("sts", "broker", "ASIA… key, secret,\nsession token, Expiration", reply=True),
        Msg("broker", "proxy", "credential_process JSON\n{Version: 1, …}", reply=True),
        Msg("proxy", "vm", "200 OK", reply=True),
    )),
    Phase("3. Use credentials", (
        Msg("vm", "s3", "SigV4-signed GetObject (signed inside the VM)\nreached via Limited allowlist *.amazonaws.com"),
        Msg("s3", "vm", "object bytes", reply=True),
    )),
    Phase("4. Expiry (≤ 1 hour)", (
        Msg("vm", "vm", "Expiration passed: CLI re-runs\ncredential_process, repeat phase 2"),
    )),
]

# Layout constants (px)
COL_W, LEFT, TOP, ICON = 230, 150, 24, 52
HEAD_H = TOP + ICON + 44  # icon + two label lines
ROW_H, PHASE_GAP = 50, 34
SELF_W = 34

# Light palette for the standalone SVG (osakanights light tokens)
LIGHT = {
    "var(--rd-fg)": "#1c1a20",
    "var(--rd-muted)": "#57525e",
    "var(--rd-accent)": "#5c4295",
    "var(--rd-surface)": "#ffffff",
    "var(--rd-border)": "#d6ccd2",
    "var(--rd-font-body)": "'Fira Sans', -apple-system, 'Segoe UI', sans-serif",
    "var(--rd-font-mono)": "'JetBrains Mono', ui-monospace, Menlo, monospace",
}


def x_of(actor_id: str) -> float:
    return LEFT + [a.id for a in ACTORS].index(actor_id) * COL_W


def rows() -> tuple[list[tuple[Phase, float, float]], list[tuple[Msg, float]], float]:
    """Assign a y to every message; return phase bands, placed messages, total height."""
    y = HEAD_H + 20
    bands, placed = [], []
    for ph in PHASES:
        start = y
        y += 26  # room for the phase title
        for m in ph.msgs:
            y += ROW_H if m.src != m.dst else ROW_H + 8
            placed.append((m, y))
        y += 18
        bands.append((ph, start, y))
        y += PHASE_GAP - 18
    return bands, placed, y + 20


def text_lines(x: float, y: float, label: str, *, anchor: str, size: float,
               fill: str, font: str, weight: str = "400", line_h: float = 13) -> str:
    lines = label.split("\n")
    spans = "".join(
        f'<tspan x="{x:.1f}" dy="{0 if i == 0 else line_h}">{html.escape(t)}</tspan>'
        for i, t in enumerate(lines)
    )
    return (f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" font-size="{size}" '
            f'font-weight="{weight}" fill="{fill}" font-family="{font}">{spans}</text>')


def plate(x: float, y: float, label: str, *, anchor: str) -> str:
    """Surface-coloured backing so a label reads cleanly over the lifelines it crosses."""
    lines = label.split("\n")
    w = max(len(t) for t in lines) * 6.35 + 8
    left = x - 4 if anchor == "start" else x - w / 2
    return (f'<rect x="{left:.1f}" y="{y - 11:.1f}" width="{w:.1f}" height="{13 * len(lines) + 3}" '
            'rx="3" fill="var(--rd-surface)" fill-opacity="0.92"/>')


def compose_svg(stencils: dict, drawio: str) -> str:
    bands, placed, height = rows()
    width = LEFT + (len(ACTORS) - 1) * COL_W + 190
    p: list[str] = []

    for ph, y0, y1 in bands:
        p.append(f'<rect x="12" y="{y0:.1f}" width="{width - 24}" height="{y1 - y0:.1f}" '
                 'rx="10" fill="var(--rd-border)" fill-opacity="0.22" stroke="var(--rd-border)"/>')
        p.append(text_lines(24, y0 + 17, ph.title, anchor="start", size=11.5,
                            fill="var(--rd-muted)", font="var(--rd-font-body)", weight="600"))

    for a in ACTORS:
        cx = x_of(a.id)
        p.append(f'<line x1="{cx}" y1="{HEAD_H}" x2="{cx}" y2="{height - 10}" '
                 'stroke="var(--rd-muted)" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>')

    for m, y in placed:
        x1, x2 = x_of(m.src), x_of(m.dst)
        dash = ' stroke-dasharray="6 4"' if m.reply else ""
        if m.src == m.dst:
            d = f"M {x1} {y - 16} h {SELF_W} v 16 h {-SELF_W + 4}"
            p.append(f'<path d="{d}" fill="none" stroke="var(--rd-fg)" stroke-width="1.3" '
                     'marker-end="url(#arrow)"/>')
            p.append(plate(x1 + SELF_W + 8, y - 15, m.label, anchor="start"))
            p.append(text_lines(x1 + SELF_W + 8, y - 15, m.label, anchor="start", size=10.5,
                                fill="var(--rd-fg)", font="var(--rd-font-mono)"))
        else:
            inset = 5 if x2 > x1 else -5
            p.append(f'<line x1="{x1}" y1="{y}" x2="{x2 - inset}" y2="{y}" stroke="var(--rd-fg)" '
                     f'stroke-width="1.3"{dash} marker-end="url(#arrow)"/>')
            n = m.label.count("\n")
            p.append(plate((x1 + x2) / 2, y - 7 - 13 * n, m.label, anchor="middle"))
            p.append(text_lines((x1 + x2) / 2, y - 7 - 13 * n, m.label, anchor="middle",
                                size=10.5, fill="var(--rd-fg)", font="var(--rd-font-mono)"))

    for a in ACTORS:
        cx = x_of(a.id)
        st = stencils.get(a.icon)
        if st is None or not st["svg"]:
            raise SystemExit(f"error: stencil missing or image-only: {a.icon!r}")
        w, h = float(st["w"]), float(st["h"])
        s = ICON / max(w, h)
        p.append(f'<rect x="{cx - 46}" y="{TOP - 8}" width="92" height="{ICON + 16}" rx="12" '
                 'fill="var(--rd-surface)" stroke="var(--rd-border)"/>')
        p.append(f'<g transform="translate({cx - w * s / 2:.1f},{TOP + (ICON - h * s) / 2:.1f}) '
                 f'scale({s:.4f})" color="{a.color}">{st["svg"]}</g>')
        p.append(text_lines(cx, TOP + ICON + 24, a.label, anchor="middle", size=11.5,
                            fill="var(--rd-fg)", font="var(--rd-font-body)", weight="600"))

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height:.0f}" '
        f'width="100%" role="img" aria-label="AWS credential broker sequence" '
        f'content={quoteattr(drawio)}>'
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        'markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" '
        'fill="var(--rd-fg)"/></marker></defs>'
        f"{''.join(p)}</svg>"
    )


def compose_drawio(stencils: dict) -> str:
    bands, placed, height = rows()
    width = LEFT + (len(ACTORS) - 1) * COL_W + 190
    c: list[str] = []
    for i, (ph, y0, y1) in enumerate(bands):
        c.append(f'<mxCell id="ph{i}" value={quoteattr(ph.title)} style="rounded=1;arcSize=4;'
                 'whiteSpace=wrap;html=1;fillColor=#f5f2f4;strokeColor=#d6ccd2;align=left;'
                 'verticalAlign=top;spacingLeft=10;fontStyle=1;fontColor=#57525e;" vertex="1" parent="1">'
                 f'<mxGeometry x="12" y="{y0:.0f}" width="{width - 24}" height="{y1 - y0:.0f}" as="geometry"/></mxCell>')
    for a in ACTORS:
        cx = x_of(a.id)
        color = LIGHT.get(a.color, a.color)
        b64 = stencils[a.icon]["stencil_b64"]
        c.append(f'<mxCell id="{a.id}" value={quoteattr(a.label.replace(chr(10), "<br>"))} '
                 f'style="shape=stencil({b64});html=1;aspect=fixed;fillColor={color};strokeColor=none;'
                 'verticalLabelPosition=bottom;verticalAlign=top;align=center;fontStyle=1;" '
                 f'vertex="1" parent="1"><mxGeometry x="{cx - ICON / 2}" y="{TOP}" '
                 f'width="{ICON}" height="{ICON}" as="geometry"/></mxCell>')
        c.append(f'<mxCell id="{a.id}_life" style="endArrow=none;dashed=1;html=1;strokeColor=#57525e;" '
                 f'edge="1" parent="1"><mxGeometry relative="1" as="geometry">'
                 f'<mxPoint x="{cx}" y="{HEAD_H}" as="sourcePoint"/>'
                 f'<mxPoint x="{cx}" y="{height - 10:.0f}" as="targetPoint"/></mxGeometry></mxCell>')
    for i, (m, y) in enumerate(placed):
        x1, x2 = x_of(m.src), x_of(m.dst)
        label = quoteattr(m.label.replace("\n", "<br>"))
        style = ("html=1;endArrow=block;endFill=1;fontFamily=Courier New;fontSize=10;"
                 + ("dashed=1;" if m.reply else ""))
        if m.src == m.dst:
            c.append(f'<mxCell id="m{i}" value={label} style="{style}rounded=0;align=left;'
                     'labelPosition=right;spacingLeft=6;" edge="1" parent="1">'
                     '<mxGeometry relative="1" as="geometry">'
                     f'<mxPoint x="{x1}" y="{y - 16}" as="sourcePoint"/>'
                     f'<mxPoint x="{x1 + 4}" y="{y}" as="targetPoint"/>'
                     f'<Array as="points"><mxPoint x="{x1 + SELF_W}" y="{y - 16}"/>'
                     f'<mxPoint x="{x1 + SELF_W}" y="{y}"/></Array></mxGeometry></mxCell>')
        else:
            c.append(f'<mxCell id="m{i}" value={label} style="{style}verticalAlign=bottom;" '
                     'edge="1" parent="1"><mxGeometry relative="1" as="geometry">'
                     f'<mxPoint x="{x1}" y="{y}" as="sourcePoint"/>'
                     f'<mxPoint x="{x2}" y="{y}" as="targetPoint"/></mxGeometry></mxCell>')
    return (
        '<mxfile host="app.diagrams.net"><diagram name="AWS credential broker" id="seq">'
        f'<mxGraphModel dx="1200" dy="900" grid="1" gridSize="10" page="1" '
        f'pageWidth="{width}" pageHeight="{height:.0f}" math="0" shadow="0">'
        f'<root><mxCell id="0"/><mxCell id="1" parent="0"/>{"".join(c)}</root>'
        "</mxGraphModel></diagram></mxfile>"
    )


def bake_light(svg: str) -> str:
    for var, hexv in LIGHT.items():
        svg = svg.replace(var, hexv)
    return svg.replace("<svg ", '<svg style="background:#ffffff" ', 1)


README = """# AWS credential broker for Claude cloud sessions

Cloud sessions get **short-lived** AWS credentials instead of static access keys.
A bearer token lives only in Anthropic's agent proxy as a network secret. A Lambda
broker swaps it for STS credentials that expire within the hour, so nothing needs
manual rotation inside the cloud environment.

{svg}

## Why each hop exists

| Hop | Reason |
|-----|--------|
| `credential_process` | The AWS CLI and SDKs fetch credentials on demand, at call time, after the proxy is up |
| Network secret | The proxy can only inject a fixed header, so it carries the broker token, not AWS keys |
| Lambda broker | Converts a static header into SigV4-capable credentials via `sts:AssumeRole` |
| `claude-s3-readonly` | Read-only on the source data prefix; the blast radius of a leaked session credential |
| Limited network | `*.amazonaws.com` is on the default allowlist; Full access is never needed |

## Security properties

- **Token stays outside the VM.** Claude cannot read or exfiltrate the bearer token.
- **AWS credentials expire within 1 hour.** A leak is self-healing.
- **Rotating the bearer token is rare and safe.** Update the Lambda's stored hash and the network secret together.
- **Caveat:** anyone who can start a session in this environment can mint credentials. Keep it private.

Editable sources: [broker-sequence.drawio](broker-sequence.drawio) and
[broker-sequence.svg](broker-sequence.svg) (both open in diagrams.net).
Regenerate with `uv run --no-project prototypes/aws-credential-broker/diagram/broker_sequence.py`.
"""


def main() -> None:
    stencils = load_stencils()
    drawio = compose_drawio(stencils)
    svg = compose_svg(stencils, drawio)
    (OUT / "broker-sequence.drawio").write_text(drawio + "\n", encoding="utf-8")
    (OUT / "broker-sequence.svg").write_text(bake_light(svg) + "\n", encoding="utf-8")
    (OUT / "aws-credential-broker.md").write_text(README.format(svg=svg), encoding="utf-8")
    print(f"wrote {OUT}/broker-sequence.{{svg,drawio}} and aws-credential-broker.md")


if __name__ == "__main__":
    main()
