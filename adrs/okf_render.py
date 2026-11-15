#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6.0", "Jinja2>=3.1", "jsonschema>=4.0"]
# ///
"""Render an okf-yaml bundle: authored YAML records -> OKF-conformant markdown.

    <dir>/NNNN-slug.yml  ->  NNNN-slug.md   OKF-conformant record markdown
                             index.md       OKF reserved directory listing
                             graph.md       companion doc holding the graph
                             graph.json     Cytoscape elements payload

The YAML is the source of truth; every .md and .json emitted here is generated.
Validation runs first and hard: a record that fails the schema stops the build
rather than producing markdown nothing checked.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from jsonschema import Draft202012Validator, FormatChecker

# ── Configuration ───────────────────────────────────────────────────────
SCRIPT = Path(__file__)
SCRIPT_DIR = SCRIPT.parent.resolve()
TEMPLATE_DIR = SCRIPT_DIR / "templates"
DEFAULT_SCHEMA = SCRIPT_DIR.parent / "resources" / "okf_yaml" / "record.schema.json"

log = logging.getLogger(__name__)

RESERVED_WORDS = {"y", "n", "yes", "no", "true", "false", "on", "off", "null", "~"}

#: A sentence ends at a terminal followed by space, and the next opens with a capital
#: or an opening delimiter. Anything else, such as e.g. before a lower-case word, is not
#: a break. The same rule as the prose gate's sentence-one-per-line, so rendered prose passes it.
SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+(?=[A-Z`\"'(\[])")

#: An inline code span, whose terminals never end a sentence.
CODE_SPAN = re.compile(r"`[^`]*`")

#: Every relation paired with its inverse, so symmetry is checkable.
INVERSE = {
    "extends": "extended_by",
    "extended_by": "extends",
    "split_from": "split_to",
    "split_to": "split_from",
    "supersedes": "superseded_by",
    "superseded_by": "supersedes",
    "tests": "tested_by",
    "tested_by": "tests",
    "depends_on": "depended_on_by",
    "depended_on_by": "depends_on",
    "excepts": "excepted_by",
    "excepted_by": "excepts",
    "see_also": "see_also",
}

#: How each relation reads in generated prose.
PROSE = {
    "extends": "Extends",
    "extended_by": "Extended by",
    "split_from": "Split from",
    "split_to": "Split to",
    "supersedes": "Supersedes",
    "superseded_by": "Superseded by",
    "tests": "Tests",
    "tested_by": "Tested by",
    "depends_on": "Depends on",
    "depended_on_by": "Depended on by",
    "excepts": "Scoped exception to",
    "excepted_by": "Excepted by",
    "see_also": "See also",
}

#: Group colours encode data, not brand, so they stay fixed across themes.
#: Cycled by group order; extend rather than re-map if a repo needs more.
GROUP_COLOURS = [
    "#6366f1",
    "#0891b2",
    "#059669",
    "#d97706",
    "#db2777",
    "#7c3aed",
    "#0284c7",
    "#65a30d",
]
UNGROUPED_COLOUR = "#64748b"

#: Design tokens the generated graph.html writes as CSS custom properties, one
#: set per theme. A repo with its own brandpack overrides these by dropping a
#: tokens.json beside its records; the shape is {"themes": {"light": {...},
#: "dark": {...}}} and the keys are CSS custom property names without the "--".
DEFAULT_TOKENS: dict[str, Any] = {
    "themes": {
        "light": {
            "bg": "#f7f7fa",
            "panel": "#ffffff",
            "ink": "#1b1d23",
            "muted": "#5b6070",
            "line": "#e2e4ea",
            "accent": "#4f46e5",
            "good": "#047857",
            "bad": "#b91c1c",
            "code": "#f1f2f6",
        },
        "dark": {
            "bg": "#0f1117",
            "panel": "#171a23",
            "ink": "#e6e8ef",
            "muted": "#9aa0b0",
            "line": "#2a2e3a",
            "accent": "#a5b4fc",
            "good": "#34d399",
            "bad": "#f87171",
            "code": "#1f2330",
        },
    }
}

# ── Core ─────────────────────────────────────────────────────────────────


Record = dict[str, Any]


def yamlq(value: Any) -> str:
    """Quote a YAML scalar only where the plain form would be mis-read."""
    text = str(value)
    if (
        text == ""
        or text[0] in ">|*&!%@`-?{}[],#'\"' "
        or text[-1] in ": "
        or ": " in text
        or " #" in text
        or text.lower() in RESERVED_WORDS
        or re.fullmatch(r"[-+]?[\d._eE:]+", text) is not None
    ):
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def one_sentence_per_line(text: str, indent: str = "") -> str:
    """Put each sentence of a prose field on its own line, continuing at ``indent``.

    A list item passes ``indent`` so its later sentences stay inside the item.
    Code spans are masked character for character first, so offsets stay aligned.
    """
    masked = CODE_SPAN.sub(lambda m: "x" * len(m.group()), text)
    out, start = [], 0
    for match in SENTENCE_BREAK.finditer(masked):
        out.append(text[start : match.start()])
        start = match.end()
    out.append(text[start:])
    return ("\n" + indent).join(out)


def group_of(record: Record, group_by: str) -> str:
    """The cluster a record belongs to. Explicit `group` always wins."""
    if record.get("group"):
        return str(record["group"])
    if group_by == "plan_id" and record.get("plan_id"):
        return str(record["plan_id"])
    tags = record.get("tags") or []
    return str(tags[0]) if tags else "ungrouped"


def load(source_dir: Path) -> list[Record]:
    """Read every record, newest key order preserved, dates re-stringified.

    YAML resolves an unquoted 2026-08-30 to a date object; templates and the
    JSON payload both want the ISO string back.
    """
    records = []
    for path in sorted(source_dir.glob("*.yml")):
        if path.name == "index.yml":
            continue
        record = yaml.safe_load(path.read_text(encoding="utf-8"))
        for key in ("accepted_on", "last_changed_on"):
            if key in record:
                record[key] = str(record[key])
        records.append(record)
    return records


def validate(records: list[Record], schema_path: Path) -> list[str]:
    """Schema errors as flat strings. Empty means every record conforms."""
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = []
    for record in records:
        # YAML dates survive as objects; JSON Schema tools validate the JSON
        # projection, so make the same projection here.
        as_json = json.loads(json.dumps(record, default=str))
        rid = record.get("id", "<no id>")
        for err in sorted(validator.iter_errors(as_json), key=lambda e: list(e.path)):
            where = "/".join(str(p) for p in err.path) or "<root>"
            errors.append(f"{rid}: {where}: {err.message}")
    return errors


def unresolved(records: list[Record]) -> list[str]:
    """relates_to targets that name a record which does not exist."""
    known = {r["id"] for r in records}
    return [
        f"{r['id']}: relates_to target {e['target']} does not exist"
        for r in records
        for e in r.get("relates_to", [])
        if e["target"] not in known
    ]


def asymmetries(records: list[Record]) -> list[Record]:
    """Edges whose inverse is absent on the far record.

    Reported, never failed: a one-way relation is a gap in the record set, and
    whether to close it is the maintainer's call.
    """
    by_id = {r["id"]: r for r in records}
    out = []
    for record in records:
        for edge in record.get("relates_to", []):
            target = by_id.get(edge["target"])
            if target is None:
                continue
            want = INVERSE[edge["relation"]]
            back = target.get("relates_to", [])
            if not any(b["target"] == record["id"] and b["relation"] == want for b in back):
                out.append(
                    {
                        "source": record["id"],
                        "relation": edge["relation"],
                        "target": edge["target"],
                        "inverse": want,
                    }
                )
    return out


def cytoscape(records: list[Record], group_by: str) -> Record:
    """Cytoscape elements: records as child nodes inside compound group nodes."""
    groups = sorted({group_of(r, group_by) for r in records})
    colour = {
        g: (UNGROUPED_COLOUR if g == "ungrouped" else GROUP_COLOURS[i % len(GROUP_COLOURS)])
        for i, g in enumerate(groups)
    }
    elements: list[Record] = [{"data": {"id": f"group-{g}", "label": g, "colour": colour[g]}} for g in groups]
    for record in records:
        group = group_of(record, group_by)
        elements.append(
            {
                "data": {
                    "id": record["id"],
                    "label": record["id"].split("-")[-1],
                    "parent": f"group-{group}",
                    "colour": colour[group],
                    "file": f"{record['id'].split('-')[-1]}-{record['slug']}.md",
                    "title": record["title"],
                    "description": record["description"],
                    "status": record["status"],
                    "tags": ", ".join(record.get("tags", [])),
                }
            }
        )
    seen: set[str] = set()
    for record in records:
        for edge in record.get("relates_to", []):
            eid = f"{record['id']}-{edge['relation']}-{edge['target']}"
            if eid in seen:
                continue
            seen.add(eid)
            elements.append(
                {
                    "data": {
                        "id": eid,
                        "source": record["id"],
                        "target": edge["target"],
                        "label": edge["relation"].replace("_", " "),
                        "relation": edge["relation"],
                        "note": edge.get("note", ""),
                    }
                }
            )
    return {"elements": elements, "layout": {"name": "cose"}, "height": 620}


def strip_frontmatter(markdown: str) -> str:
    """Drop a leading YAML frontmatter block, returning the body.

    Markdown renderers have no concept of frontmatter: the opening "---" reads
    as a thematic break and the YAML beneath it as a setext heading, so a
    renderer shows the whole metadata block as a title. Anything that feeds a
    record to a renderer wants the body alone.
    """
    if not markdown.startswith("---\n"):
        return markdown
    closing = markdown.find("\n---\n", 3)
    if closing == -1:
        return markdown
    return markdown[closing + len("\n---\n") :].lstrip("\n")


def script_json(value: Any) -> str:
    """Serialise for embedding inside a <script> tag.

    A record whose prose contains "</script>" would otherwise close the tag and
    spill its remainder into the document. Escaping the slash keeps the JSON
    valid ("\\/" is a legal escape) while making the sequence inert to the HTML
    parser. The paragraph and line separators are escaped for the same class of
    reason: they are literal line terminators to a JavaScript parser.
    """
    text = json.dumps(value, separators=(",", ":"))
    return text.replace("</", "<\\/").replace(" ", "\\u2028").replace(" ", "\\u2029")


def environment(by_id: dict[str, Record], template_dir: Path = TEMPLATE_DIR) -> Environment:
    """Jinja environment. StrictUndefined so a missing field fails loudly."""
    env = Environment(
        loader=FileSystemLoader(template_dir),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
        trim_blocks=True,
        lstrip_blocks=True,
        autoescape=False,
    )
    env.filters["yamlq"] = yamlq
    env.filters["one_sentence_per_line"] = one_sentence_per_line
    env.filters["relation_prose"] = lambda r: PROSE[r]
    env.filters["record_link"] = lambda i: f"{i.split('-')[-1]}-{by_id[i]['slug']}.md"
    return env


def render(
    source_dir: Path,
    *,
    schema_path: Path = DEFAULT_SCHEMA,
    group_by: str = "tag",
    author: str = "human:maintainer",
) -> Record:
    """Generate the bundle and write it. Raises ValueError if any record fails validation."""
    files, summary = build(source_dir, schema_path=schema_path, group_by=group_by, author=author)
    for name, text in files.items():
        (source_dir / name).write_text(text, encoding="utf-8")
    return summary


def build(
    source_dir: Path,
    *,
    schema_path: Path = DEFAULT_SCHEMA,
    group_by: str = "tag",
    author: str = "human:maintainer",
    template_dir: Path = TEMPLATE_DIR,
) -> tuple[dict[str, str], Record]:
    """Generate the bundle in memory: each file name mapped to its text, plus a summary.

    Writes nothing, so an audit can compare a fresh build with the files on disk.
    ``template_dir`` lets a bundle that carries its own templates be built with them.
    Raises ValueError if any record fails validation.
    """
    records = load(source_dir)
    if not records:
        raise ValueError(f"no records found in {source_dir}")

    problems = validate(records, schema_path) + unresolved(records)
    if problems:
        raise ValueError("records did not validate:\n  " + "\n  ".join(problems))

    by_id = {r["id"]: r for r in records}
    env = environment(by_id, template_dir)

    # The rendered markdown is kept as it is written, so graph.html can inline it
    # and its reading pane needs no fetch. That is what makes the viewer work from
    # file:// with no server.
    #
    # The frontmatter is stripped before inlining. A markdown renderer has no
    # concept of frontmatter: it reads the leading "---" as a thematic break and
    # the YAML beneath it as a setext heading, so the pane would open with the
    # whole metadata block styled as a title. The viewer shows those fields as
    # chips instead.
    files: dict[str, str] = {}
    rendered: dict[str, Record] = {}
    for record in records:
        name = f"{record['id'].split('-')[-1]}-{record['slug']}.md"
        markdown = env.get_template("record.md.j2").render(rec=record, author=author)
        files[name] = markdown
        rendered[record["id"]] = {
            "file": name,
            "status": record["status"],
            "title": record["title"],
            "markdown": strip_frontmatter(markdown),
        }

    edges = [
        {"source": r["id"], "relation": e["relation"], "target": e["target"]}
        for r in records
        for e in r.get("relates_to", [])
    ]
    groups = [
        (g, [r for r in records if group_of(r, group_by) == g])
        for g in sorted({group_of(r, group_by) for r in records})
    ]
    files["index.md"] = env.get_template("index.md.j2").render(records=records, areas=groups, edges=edges)

    graph = cytoscape(records, group_by)
    files["graph.json"] = json.dumps(graph, indent=2) + "\n"
    skew = asymmetries(records)
    files["graph.md"] = env.get_template("graph.md.j2").render(
        node_count=len(records),
        edge_count=len(edges),
        group_count=len(groups),
        asymmetries=skew,
    )

    # graph.json is the data; graph.html is the way a human reads it. The viewer
    # is always generated, because a typed relation graph nobody can see is a
    # graph nobody checks. A repo's own tokens.json overrides the defaults.
    tokens_path = source_dir / "tokens.json"
    tokens = json.loads(tokens_path.read_text(encoding="utf-8")) if tokens_path.is_file() else DEFAULT_TOKENS
    files["graph.html"] = env.get_template("graph.html.j2").render(
        bundle_name=source_dir.name,
        node_count=len(records),
        edge_count=len(edges),
        graph_json=script_json(graph),
        records_json=script_json(rendered),
        tokens_json=script_json(tokens),
    )
    return files, {
        "records": len(records),
        "edges": len(edges),
        "groups": len(groups),
        "asymmetries": skew,
        "elements": len(graph["elements"]),
    }


# ── CLI ──────────────────────────────────────────────────────────────────


def main(args: argparse.Namespace) -> int:
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s", stream=sys.stderr
    )
    try:
        result = render(
            args.directory,
            schema_path=args.schema,
            group_by=args.group_by,
            author=args.author,
        )
    except ValueError as exc:
        log.error("%s", exc)
        return 1

    log.info(
        "rendered %d records, %d edges, %d groups (%d graph elements)",
        result["records"],
        result["edges"],
        result["groups"],
        result["elements"],
    )
    for skew in result["asymmetries"]:
        log.info(
            "  one-way: %s --%s--> %s (no '%s' back-edge)",
            skew["source"],
            skew["relation"],
            skew["target"],
            skew["inverse"],
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("directory", type=Path, help="bundle directory holding the .yml records")
    parser.add_argument(
        "--schema", type=Path, default=DEFAULT_SCHEMA, help="record schema (default: the skill's own)"
    )
    parser.add_argument(
        "--group-by",
        choices=["tag", "plan_id"],
        default="tag",
        help="graph clustering key when a record has no explicit group",
    )
    parser.add_argument(
        "--author", default="human:maintainer", help="value for the generated frontmatter's generated.by"
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main(build_parser().parse_args()))
