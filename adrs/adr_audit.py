#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6.0", "Jinja2>=3.1", "jsonschema>=4.0"]
# ///
"""Audit a repo's ADR surface for compliance, and exit non-zero on a violation.

Every check is structural. A record's reasoning is never judged, only whether the
surface holds together: records parse, ids are stable, accepted records keep their
argument, relations resolve, supersession is marked both ways, the agent file wires
the surface in, and an index covers every scoped log.

    adr_audit.py [repo] [--surface PATH ...] [--json]

Exit codes: 0 when no 🔴 finding, 1 when any 🔴 finding, 2 on a usage error.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml

import okf_render

# ── Configuration ───────────────────────────────────────────────────────
SCRIPT = Path(__file__)
SCRIPT_DIR = SCRIPT.parent.resolve()

log = logging.getLogger(__name__)

RED = "🔴"
YELLOW = "🟡"

#: Directory names that hold one record per file, and file names that hold a whole log.
SURFACE_DIRS = {"adrs", "adr", "decisions"}
SURFACE_LOGS = {"ADRs.md", "DECISIONS.md"}

#: Never descended into while discovering surfaces: vendored, generated, tool state, or test
#: fixtures. A directory holding its own `.git` is another repo or worktree and is skipped too.
SKIP_DIRS = {"node_modules", "vendor", "plugins", "tmp", "__pycache__", "dist", "build", "fixtures"}

#: The lens fields of an okf-yaml decision. A key the schema dropped (ADR-16 removed
#: `in_practice`) may be deleted from an accepted record without changing its argument.
LENS = ("given", "we_prefer", "because", "unless")

AGENT_FILES = ("AGENTS.md", "CLAUDE.md", "AGENT.md")

#: A record file in a file-per-decision surface: a number, a dash, a slug.
RECORD_FILE = re.compile(r"^(\d+)-[^/]+\.(md|yml)$")

#: A record section in a single-file log: `## ADR-12: ...`, `## ADR-0012 ...`.
LOG_HEADING = re.compile(r"^##\s+(([A-Za-z]+)-?(\d+))\b", re.MULTILINE)

#: The title heading of a file-per-decision record, used only to learn the id prefix.
FILE_TITLE = re.compile(r"^#\s+(([A-Za-z]+)-?(\d+))\b", re.MULTILINE)

#: Housekeeping markdown an okf-yaml bundle may hold without a .yml source
#: (resources/learned/adjudications.md, 2026-09-20).
BUNDLE_HOUSEKEEPING = {"README.md", "CLAUDE.md", "AGENTS.md", "log.md"}

STATUS_LINE = re.compile(r"(?i)\bstatus\b[*:|\s]*([^\n]*)")
HAS_DECISION = re.compile(r"(?im)^#+\s*decision\b|\*\*decision\b|\bwe prefer\b")
HAS_REASONING = re.compile(r"(?i)\b(because|rationale|context)\b")

#: Lines that supersession is allowed to change on an accepted record.
MUTABLE_LINE = re.compile(r"(?i)\b(status|relates to|superseded)\b")

#: A partial-supersession marker added to a clause, which the template permits.
SUPERSESSION_MARKER = re.compile(r"\s*\((?:partly |partially )?superseded[^)]*\)", re.IGNORECASE)

CHECK_BEFORE_ASK = re.compile(
    r"(?i)\b(check|read|consult)\b[^.\n]*\bbefore\b[^.\n]*\b(ask|asking|question|questions|raising)\b"
)


@dataclass(frozen=True)
class Finding:
    check: str
    severity: str
    where: str
    finding: str
    operation: str


@dataclass(frozen=True)
class Surface:
    path: Path  # relative to the repo root
    layout: str  # "log" | "files" | "okf-yaml"


@dataclass
class Record:
    id: str
    number: int
    status: str
    argument: str
    text: str
    where: str
    prefix: str = ""
    relations: list[dict[str, str]] = field(default_factory=list)


# ── Discovery ────────────────────────────────────────────────────────────


def layout_of(path: Path) -> str | None:
    """The layout a candidate path follows, or None when it holds no records."""
    if path.is_file():
        return "log" if path.name in SURFACE_LOGS else None
    names = [p.name for p in path.iterdir() if p.is_file()]
    if any(n.endswith(".yml") and RECORD_FILE.match(n) for n in names):
        return "okf-yaml"
    if any(n.endswith(".md") and RECORD_FILE.match(n) for n in names):
        return "files"
    return None


def discover(repo: Path) -> list[Surface]:
    """Every ADR surface in the repo, the shallowest first."""
    found: list[Surface] = []
    for here, dirnames, filenames in repo.walk():
        dirnames[:] = sorted(
            d
            for d in dirnames
            if d not in SKIP_DIRS and not d.startswith(".") and not (here / d / ".git").exists()
        )
        candidates = [here / d for d in dirnames if d.lower() in SURFACE_DIRS]
        candidates += [here / f for f in sorted(filenames) if f in SURFACE_LOGS]
        for candidate in candidates:
            layout = layout_of(candidate)
            if layout:
                found.append(Surface(candidate.relative_to(repo), layout))
    return sorted(found, key=lambda s: (len(s.path.parts), str(s.path)))


def surfaces_from(repo: Path, given: list[str]) -> list[Surface]:
    """Surfaces named on the command line, each with its layout detected."""
    out = []
    for rel in given:
        layout = layout_of(repo / rel) if (repo / rel).exists() else None
        if layout is None:
            raise ValueError(f"{rel} holds no decision records")
        out.append(Surface(Path(rel), layout))
    return out


# ── Parsing ──────────────────────────────────────────────────────────────


def normalise(text: str) -> str:
    return " ".join(text.split())


def markdown_argument(text: str) -> str:
    """The part of a record supersession may not change: every line but status and relations."""
    lines = (SUPERSESSION_MARKER.sub("", line) for line in text.splitlines())
    return normalise("\n".join(line for line in lines if not MUTABLE_LINE.search(line)))


def status_of(text: str) -> str:
    match = STATUS_LINE.search(text)
    return normalise(match[1]).lower() if match else ""


def parse_log(text: str, where: str) -> list[Record]:
    """One record per `## ID` section; other sections (a template, an intro) are not records."""
    heads = list(LOG_HEADING.finditer(text))
    records = []
    for i, head in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        nxt = re.search(r"^## ", text[head.end() : end], re.MULTILINE)
        body = text[head.start() : head.end() + nxt.start() if nxt else end]
        records.append(
            Record(
                id=head[1],
                number=int(head[3]),
                status=status_of(body),
                argument=markdown_argument(body),
                text=body,
                where=f"{where}#{head[1]}",
                prefix=head[2],
            )
        )
    return records


def parse_markdown_file(name: str, text: str, where: str) -> Record:
    match = RECORD_FILE.match(name)
    assert match is not None
    title = FILE_TITLE.search(text)
    return Record(
        id=title[1] if title else Path(name).stem,
        number=int(match[1]),
        status=status_of(text),
        argument=markdown_argument(text),
        text=text,
        where=where,
        prefix=title[2] if title else "",
    )


def parse_okf(name: str, text: str, where: str) -> Record:
    data = yaml.safe_load(text) or {}
    rid = str(data.get("id", Path(name).stem))
    digits = re.search(r"(\d+)$", rid)
    decision = data.get("decision") or {}
    argument = {
        "title": data.get("title"),
        "decision": {k: decision.get(k) for k in LENS},
        "consequences": data.get("consequences"),
    }
    return Record(
        id=rid,
        number=int(digits[1]) if digits else -1,
        status=str(data.get("status", "")).lower(),
        argument=json.dumps(argument, sort_keys=True, default=str),
        text=text,
        where=where,
        prefix=rid.split("-")[0] if "-" in rid else "",
        relations=[{"relation": e["relation"], "target": e["target"]} for e in data.get("relates_to") or []],
    )


def parse(surface: Surface, files: dict[str, str]) -> list[Record]:
    """Records from a surface's files, given as {name relative to the surface: text}."""
    if surface.layout == "log":
        return parse_log(files.get("", ""), str(surface.path))
    out = []
    for name in sorted(files):
        if not RECORD_FILE.match(name):
            continue
        where = str(surface.path / name)
        if surface.layout == "okf-yaml" and name.endswith(".yml"):
            out.append(parse_okf(name, files[name], where))
        elif surface.layout == "files" and name.endswith(".md"):
            out.append(parse_markdown_file(name, files[name], where))
    return out


def read_current(repo: Path, surface: Surface) -> dict[str, str]:
    path = repo / surface.path
    if surface.layout == "log":
        return {"": path.read_text(encoding="utf-8")}
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(path.iterdir()) if p.is_file()}


# ── Git history ──────────────────────────────────────────────────────────


def git(repo: Path, *args: str) -> str | None:
    """Stdout of a git command, or None when it fails (not a repo, path never committed)."""
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=False)
    return proc.stdout if proc.returncode == 0 else None


def read_at(repo: Path, commit: str, surface: Surface) -> dict[str, str]:
    rel = surface.path.as_posix()
    if surface.layout == "log":
        text = git(repo, "show", f"{commit}:{rel}")
        return {"": text} if text is not None else {}
    listing = git(repo, "ls-tree", "--name-only", f"{commit}:{rel}") or ""
    files = {}
    for name in listing.split():
        text = git(repo, "show", f"{commit}:{rel}/{name}")
        if text is not None:
            files[name] = text
    return files


def first_accepted(repo: Path, surface: Surface) -> dict[str, tuple[str, Record]] | None:
    """Each record's argument as it stood in the first commit that showed it accepted."""
    commits = git(repo, "log", "--reverse", "--format=%H", "--", surface.path.as_posix())
    if commits is None:
        return None
    seen: dict[str, tuple[str, Record]] = {}
    for commit in commits.split():
        for record in parse(surface, read_at(repo, commit, surface)):
            if record.id not in seen and "accepted" in record.status:
                seen[record.id] = (commit[:7], record)
    return seen


# ── Checks ───────────────────────────────────────────────────────────────


def check_structure(surface: Surface, records: list[Record], repo: Path) -> list[Finding]:
    if surface.layout == "okf-yaml":
        bundle = repo / surface.path
        schema = bundle / "record.schema.json"
        loaded = okf_render.load(bundle)
        errors = okf_render.validate(loaded, schema if schema.is_file() else okf_render.DEFAULT_SCHEMA)
        return [
            Finding("schema", RED, str(surface.path), e, "fix the .yml record, never the generated .md")
            for e in errors
        ]
    out = []
    for record in records:
        missing = [
            part
            for part, present in (
                ("Status", bool(record.status)),
                ("a decision statement", bool(HAS_DECISION.search(record.text))),
                ("reasoning", bool(HAS_REASONING.search(record.text))),
            )
            if not present
        ]
        if missing:
            out.append(
                Finding(
                    "schema",
                    RED,
                    record.where,
                    f"{record.id} has no {', no '.join(missing)}",
                    "add the missing part in the shape of resources/adr_template.md",
                )
            )
    return out


def check_fresh(surface: Surface, repo: Path) -> list[Finding]:
    """An okf-yaml bundle's generated files match a fresh build byte for byte."""
    bundle = repo / surface.path
    schema = bundle / "record.schema.json"
    templates = bundle / "templates"
    try:
        files, _ = okf_render.build(
            bundle,
            schema_path=schema if schema.is_file() else okf_render.DEFAULT_SCHEMA,
            template_dir=templates if templates.is_dir() else okf_render.TEMPLATE_DIR,
        )
    except ValueError:
        return []  # the schema check already reports why the bundle cannot build
    out = []
    for name, text in sorted(files.items()):
        path = bundle / name
        where = str(surface.path / name)
        if not path.is_file():
            out.append(Finding("fresh", RED, where, f"generated {name} is missing", "regenerate the bundle"))
        elif path.read_text(encoding="utf-8") != text:
            out.append(
                Finding(
                    "fresh",
                    RED,
                    where,
                    f"{name} differs from a fresh build (stale, or edited by hand)",
                    "regenerate; an edit belongs in the .yml source",
                )
            )
    for path in sorted(bundle.glob("*.md")):
        if path.name not in files and path.name not in BUNDLE_HOUSEKEEPING:
            out.append(
                Finding(
                    "fresh",
                    YELLOW,
                    str(surface.path / path.name),
                    f"{path.name} has no .yml source",
                    "migrate it into the bundle as a record, or move it out",
                )
            )
    return out


def check_ids(surface: Surface, records: list[Record]) -> list[Finding]:
    out = []
    numbers: dict[int, list[str]] = {}
    for record in records:
        numbers.setdefault(record.number, []).append(record.id)
        stem = Path(record.where).name
        digits = RECORD_FILE.match(stem)
        if surface.layout == "okf-yaml" and digits and int(digits[1]) != record.number:
            out.append(
                Finding(
                    "ids",
                    RED,
                    record.where,
                    f"{record.id} sits in a file numbered {digits[1]}",
                    "rename the file",
                )
            )
    for number, ids in sorted(numbers.items()):
        if len(ids) > 1:
            out.append(
                Finding(
                    "ids",
                    RED,
                    str(surface.path),
                    f"number {number} is used by {len(ids)} records: {', '.join(ids)}",
                    "give the newer record the next free number; never renumber an accepted one",
                )
            )
    if numbers:
        gaps = sorted(set(range(min(numbers), max(numbers) + 1)) - set(numbers))
        if gaps:
            out.append(
                Finding(
                    "ids",
                    RED,
                    str(surface.path),
                    f"numbers missing from the sequence: {', '.join(map(str, gaps))}",
                    "restore the removed record, marked retired; records are never deleted",
                )
            )
    return out


def check_immutable(surface: Surface, records: list[Record], repo: Path) -> list[Finding]:
    history = first_accepted(repo, surface)
    if history is None:
        return [
            Finding(
                "immutable",
                YELLOW,
                str(surface.path),
                "no git history, so edits to accepted records cannot be checked",
                "audit inside a git checkout",
            )
        ]
    current = {r.id: r for r in records}
    out = []
    for rid, (commit, accepted) in sorted(history.items()):
        now = current.get(rid)
        if now is None:
            out.append(
                Finding(
                    "immutable",
                    RED,
                    accepted.where,
                    f"{rid} was accepted in {commit} and has since been removed",
                    "restore it; retire or supersede instead of deleting",
                )
            )
        elif now.argument != accepted.argument:
            out.append(
                Finding(
                    "immutable",
                    RED,
                    now.where,
                    f"{rid} changed its argument after it was accepted in {commit}",
                    "revert the edit; a change of mind is a new record that supersedes this one",
                )
            )
    return out


def mentions(record: Record, prefixes: set[str]) -> set[tuple[str, int]]:
    """Every (prefix, number) id a markdown record mentions, other than itself."""
    found = set()
    for prefix in prefixes:
        for match in re.finditer(rf"\b{re.escape(prefix)}-?0*(\d+)\b", record.text):
            if int(match[1]) != record.number:
                found.add((prefix, int(match[1])))
    return found


def check_relations(surface: Surface, records: list[Record], repo: Path) -> list[Finding]:
    by_id = {r.id: r for r in records}
    out = []
    if surface.layout == "okf-yaml":
        for record in records:
            for edge in record.relations:
                if edge["target"] not in by_id:
                    out.append(
                        Finding(
                            "relations",
                            RED,
                            record.where,
                            f"{record.id} {edge['relation']} {edge['target']}, which does not exist",
                            "fix the target in the .yml record",
                        )
                    )
        return out
    numbers = {r.number for r in records}
    prefixes = {r.prefix for r in records if r.prefix}
    for record in records:
        for prefix, number in sorted(mentions(record, prefixes)):
            if number not in numbers:
                out.append(
                    Finding(
                        "relations",
                        RED,
                        record.where,
                        f"{record.id} mentions {prefix}-{number}, which does not exist",
                        "correct the reference",
                    )
                )
        if surface.layout == "files":
            for target in re.findall(r"\]\((\d+-[^)#\s]+\.md)", record.text):
                if not (repo / surface.path / target).is_file():
                    out.append(
                        Finding(
                            "relations",
                            RED,
                            record.where,
                            f"{record.id} links {target}, which does not exist",
                            "correct the link",
                        )
                    )
    return out


def check_supersession(surface: Surface, records: list[Record]) -> list[Finding]:
    by_id = {r.id: r for r in records}
    by_number = {r.number: r for r in records}
    out = []

    def unmarked(old: Record, new: Record) -> Finding:
        return Finding(
            "superseded",
            RED,
            old.where,
            f"{new.id} supersedes {old.id}, but {old.id} is not marked superseded",
            f"set {old.id}'s status to superseded, pointing at {new.id}",
        )

    if surface.layout == "okf-yaml":
        for record in records:
            for edge in record.relations:
                target = by_id.get(edge["target"])
                if edge["relation"] == "supersedes" and target is not None:
                    back = {(e["relation"], e["target"]) for e in target.relations}
                    if target.status != "superseded" or ("superseded_by", record.id) not in back:
                        out.append(unmarked(target, record))
            if record.status == "superseded" and not any(
                e["relation"] == "superseded_by" for e in record.relations
            ):
                out.append(
                    Finding(
                        "superseded",
                        RED,
                        record.where,
                        f"{record.id} is superseded but names no successor",
                        "add a superseded_by relation to the record that replaced it",
                    )
                )
        return out
    prefixes = {r.prefix for r in records if r.prefix}
    for record in records:
        for match in re.finditer(r"(?i)\bsupersedes\b([^\n]*)", record.text):
            for prefix in prefixes:
                for num in re.findall(rf"\b{re.escape(prefix)}-?0*(\d+)\b", match[1]):
                    old = by_number.get(int(num))
                    if old is not None and old is not record and "superseded" not in old.status:
                        out.append(unmarked(old, record))
        if "superseded" in record.status and not any(n in by_number for _, n in mentions(record, prefixes)):
            out.append(
                Finding(
                    "superseded",
                    RED,
                    record.where,
                    f"{record.id} is superseded but names no successor",
                    "name the record that replaced it in the Status or Relates to row",
                )
            )
    return out


def check_wiring(repo: Path, root: Surface) -> list[Finding]:
    texts = {
        name: (repo / name).read_text(encoding="utf-8") for name in AGENT_FILES if (repo / name).is_file()
    }
    if not texts:
        return [
            Finding(
                "wiring",
                RED,
                ".",
                "no agent file (AGENTS.md or CLAUDE.md) at the repo root",
                "create AGENTS.md, with CLAUDE.md as the single line @AGENTS.md",
            )
        ]
    combined = "\n".join(texts.values())
    target = root.path.as_posix()
    out = []
    if target not in combined:
        out.append(
            Finding(
                "wiring",
                RED,
                " + ".join(texts),
                f"the agent file never links {target}",
                f"link {target} from AGENTS.md",
            )
        )
    if not CHECK_BEFORE_ASK.search(combined):
        out.append(
            Finding(
                "wiring",
                RED,
                " + ".join(texts),
                "no line tells the agent to check the decisions before asking",
                "add a check-before-you-ask line beside the link",
            )
        )
    return out


def index_file(repo: Path, surface: Surface) -> Path | None:
    if surface.layout == "log":
        return repo / surface.path
    for name in ("index.md", "README.md"):
        if (repo / surface.path / name).is_file():
            return repo / surface.path / name
    return None


def check_index(repo: Path, surfaces: list[Surface], records: dict[Surface, list[Record]]) -> list[Finding]:
    out = []
    root, scoped = surfaces[0], surfaces[1:]
    index = index_file(repo, root)
    if scoped:
        text = index.read_text(encoding="utf-8") if index else ""
        for surface in scoped:
            base = index.parent if index else repo / root.path
            rel = (repo / surface.path).relative_to(base, walk_up=True).as_posix()
            if rel not in text and surface.path.as_posix() not in text:
                out.append(
                    Finding(
                        "index",
                        RED,
                        str(index.relative_to(repo)) if index else str(root.path),
                        f"the root index does not cover the scoped log {surface.path}",
                        f"link {surface.path} from the root index",
                    )
                )
    for surface in surfaces:
        index = index_file(repo, surface)
        if surface.layout != "files" or index is None:
            continue
        text = index.read_text(encoding="utf-8")
        for record in records[surface]:
            name = Path(record.where).name
            if name not in text:
                out.append(
                    Finding(
                        "index",
                        RED,
                        str(index.relative_to(repo)),
                        f"the index does not list {name}",
                        f"add {name} to the index",
                    )
                )
    return out


def check_symmetry(surface: Surface, repo: Path) -> list[Finding]:
    """One-way okf-yaml relations, reported and never failed. Supersession has its own 🔴 check."""
    if surface.layout != "okf-yaml":
        return []
    return [
        Finding(
            "relations",
            YELLOW,
            str(surface.path),
            f"{s['source']} {s['relation']} {s['target']} has no {s['inverse']} back-edge",
            "decide whether to add the inverse",
        )
        for s in okf_render.asymmetries(okf_render.load(repo / surface.path))
        if s["relation"] not in ("supersedes", "superseded_by")
    ]


# ── Audit ────────────────────────────────────────────────────────────────


def audit(repo: Path, given: list[str] | None = None) -> dict[str, Any]:
    """Every finding for the repo's ADR surfaces, 🔴 first."""
    surfaces = surfaces_from(repo, given) if given else discover(repo)
    if not surfaces:
        finding = Finding("presence", RED, ".", "no ADR surface found", "create one with /adr setup")
        return {"surfaces": [], "records": 0, "findings": [asdict(finding)]}
    findings: list[Finding] = []
    records: dict[Surface, list[Record]] = {}
    for surface in surfaces:
        recs = parse(surface, read_current(repo, surface))
        records[surface] = recs
        findings += check_structure(surface, recs, repo)
        if surface.layout == "okf-yaml":
            findings += check_fresh(surface, repo)
        findings += check_ids(surface, recs)
        findings += check_immutable(surface, recs, repo)
        findings += check_relations(surface, recs, repo)
        findings += check_supersession(surface, recs)
        findings += check_symmetry(surface, repo)
    findings += check_wiring(repo, surfaces[0])
    findings += check_index(repo, surfaces, records)
    findings.sort(key=lambda f: f.severity != RED)
    return {
        "surfaces": [{"path": s.path.as_posix(), "layout": s.layout} for s in surfaces],
        "records": sum(len(r) for r in records.values()),
        "findings": [asdict(f) for f in findings],
    }


def report(result: dict[str, Any]) -> str:
    """The findings as a markdown table, in the shape of a shelving plan."""
    findings = result["findings"]
    red = sum(f["severity"] == RED for f in findings)
    counts = f"{red} {RED} · {len(findings) - red} {YELLOW}"
    lines = [
        f"## ADR audit: {result['records']} records in {len(result['surfaces'])} surfaces · {counts}",
        "",
    ]
    lines += [f"- `{s['path']}`: {s['layout']}" for s in result["surfaces"]]
    if not findings:
        return "\n".join([*lines, "", "Compliant: no findings."])
    lines += ["", "| # | Check | Where | Finding | Operation | Severity |", "|---|---|---|---|---|---|"]
    for i, f in enumerate(findings, 1):
        lines.append(
            f"| {i} | {f['check']} | `{f['where']}` | {f['finding']} | {f['operation']} | {f['severity']} |"
        )
    return "\n".join(lines)


# ── CLI ──────────────────────────────────────────────────────────────────


def main(args: argparse.Namespace) -> int:
    # The report is the product, so it goes to stdout where a CI log or a pipe expects it.
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
        stream=sys.stdout,
        force=True,
    )
    try:
        result = audit(args.repo.resolve(), args.surface)
    except ValueError as exc:
        log.error("error: %s", exc)
        return 2
    log.info("%s", json.dumps(result, indent=2, ensure_ascii=False) if args.json else report(result))
    return 1 if any(f["severity"] == RED for f in result["findings"]) else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("repo", type=Path, nargs="?", default=Path("."), help="repo root (default: .)")
    parser.add_argument(
        "--surface",
        action="append",
        help="an ADR surface relative to the repo, root log first; repeat for scoped logs (default: discover)",
    )
    parser.add_argument("--json", action="store_true", help="emit the findings as JSON")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main(build_parser().parse_args()))
