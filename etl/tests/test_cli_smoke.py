"""Smoke test: parser builds, top-level help fires when no subcommand given."""

from __future__ import annotations

import pytest

from etl.cli import build_parser


def test_parser_builds() -> None:
    parser = build_parser()
    assert parser.prog == "etl"


def test_help_default_fires_with_no_subcommand(capsys: pytest.CaptureFixture[str]) -> None:
    parser = build_parser()
    args = parser.parse_args([])
    args.func(args)
    out = capsys.readouterr().out
    assert "usage: etl" in out
    assert "extract" in out
    assert "publish" in out
    assert "status" in out


def test_subcommand_help_fires_for_partial_path(capsys: pytest.CaptureFixture[str]) -> None:
    """`etl extract` (no source) should print extract's help, not the top-level help."""
    parser = build_parser()
    args = parser.parse_args(["extract"])
    args.func(args)
    out = capsys.readouterr().out
    assert "sal" in out
