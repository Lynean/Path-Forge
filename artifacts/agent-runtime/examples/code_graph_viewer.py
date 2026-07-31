"""Standalone indentation code-graph viewer.

Run:
    python code_graph_viewer.py

Uses only the Python standard library (Tkinter). Choose any UTF-8 source file,
inspect its indentation graph, click nodes to read addressed code, and export
range-only JSON.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Any


NODE_WIDTH = 232
NODE_HEIGHT = 62
X_GAP = 54
Y_GAP = 22
CANVAS_MARGIN = 36
DEPTH_COLORS = (
    "#2563eb",
    "#7c3aed",
    "#0891b2",
    "#059669",
    "#ca8a04",
    "#ea580c",
    "#dc2626",
    "#be185d",
)


def scan_delimiters(
    lines: list[str], start_line: int, end_line: int
) -> dict[str, int]:
    counts = {
        "parentheses_open": 0,
        "parentheses_close": 0,
        "braces_open": 0,
        "braces_close": 0,
        "brackets_open": 0,
        "brackets_close": 0,
        "double_quotes": 0,
        "single_quotes": 0,
    }
    quote: str | None = None
    escaped = False
    block_comment = False

    for line_number in range(start_line, end_line + 1):
        line = lines[line_number - 1] if line_number <= len(lines) else ""
        index = 0
        while index < len(line):
            character = line[index]
            following = line[index + 1] if index + 1 < len(line) else ""
            if block_comment:
                if character == "*" and following == "/":
                    block_comment = False
                    index += 2
                else:
                    index += 1
                continue
            if quote:
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == quote:
                    key = "double_quotes" if quote == '"' else "single_quotes"
                    counts[key] += 1
                    quote = None
                index += 1
                continue
            if character == "/" and following == "*":
                block_comment = True
                index += 2
                continue
            if (character == "/" and following == "/") or character == "#":
                break
            if character in ("'", '"'):
                quote = character
                key = "double_quotes" if quote == '"' else "single_quotes"
                counts[key] += 1
            elif character == "(":
                counts["parentheses_open"] += 1
            elif character == ")":
                counts["parentheses_close"] += 1
            elif character == "{":
                counts["braces_open"] += 1
            elif character == "}":
                counts["braces_close"] += 1
            elif character == "[":
                counts["brackets_open"] += 1
            elif character == "]":
                counts["brackets_close"] += 1
            index += 1
        escaped = False
    return counts


def delimiters_balanced(counts: dict[str, int]) -> bool:
    return (
        counts["parentheses_open"] == counts["parentheses_close"]
        and counts["braces_open"] == counts["braces_close"]
        and counts["brackets_open"] == counts["brackets_close"]
        and counts["double_quotes"] % 2 == 0
        and counts["single_quotes"] % 2 == 0
    )


def first_line_has_excess_closing(line: str) -> bool:
    counts = scan_delimiters([line], 1, 1)
    return (
        counts["parentheses_close"] > counts["parentheses_open"]
        or counts["braces_close"] > counts["braces_open"]
        or counts["brackets_close"] > counts["brackets_open"]
    )


def starts_with_leading_marker(line: str) -> bool:
    trimmed = line.lstrip()
    return (
        trimmed.startswith("//")
        or trimmed.startswith("#")
        or trimmed.startswith("@")
        or trimmed.startswith("!")
    )


def indentation_columns(raw: str, tab_width: int) -> int:
    columns = 0
    for character in raw:
        if character == "\t":
            columns += tab_width - (columns % tab_width)
        else:
            columns += 1
    return columns


def infer_indentation_unit(lines: list[dict[str, Any]]) -> int:
    structural = [
        line
        for line in lines
        if not re.match(r"^(?:\*|\*/)", line["content"])
    ]
    increases: dict[int, int] = {}
    for previous, current in zip(structural, structural[1:]):
        difference = current["indent_columns"] - previous["indent_columns"]
        if difference > 0:
            increases[difference] = increases.get(difference, 0) + 1
    if increases:
        return min(increases, key=lambda value: (-increases[value], value))

    positive = sorted(
        {
            line["indent_columns"]
            for line in structural
            if line["indent_columns"] > 0
        }
    )
    if not positive:
        return 1
    return math.gcd(*positive)


def detect_newline(source: str) -> str:
    crlf_count = source.count("\r\n")
    lf_count = len(re.findall(r"(?<!\r)\n", source))
    if crlf_count and lf_count:
        return "mixed"
    if crlf_count:
        return "crlf"
    if lf_count:
        return "lf"
    return "none"


def graph_code(
    source: str,
    path: str | None = None,
    tab_width: int = 4,
    max_nodes: int = 5_000,
) -> dict[str, Any]:
    if not 1 <= tab_width <= 16:
        raise ValueError("tab_width must be between 1 and 16")

    raw_lines = re.split(r"\r\n|\n|\r", source)
    source_lines: list[dict[str, Any]] = []
    for number, text in enumerate(raw_lines, start=1):
        if not text.strip():
            continue
        indent_raw = re.match(r"^[\t ]*", text).group(0)
        source_lines.append(
            {
                "number": number,
                "text": text,
                "indent_raw": indent_raw,
                "indent_columns": indentation_columns(indent_raw, tab_width),
                "content": text[len(indent_raw) :],
            }
        )

    unit_columns = infer_indentation_unit(source_lines)
    newline = detect_newline(source)
    nodes: list[dict[str, Any]] = []
    roots: list[str] = []
    diagnostics: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    own_start_lines: dict[str, int] = {}
    previous_line: dict[str, Any] | None = None
    previous_node: dict[str, Any] | None = None

    for line in source_lines:
        can_extend = (
            previous_line is not None
            and previous_node is not None
            and line["indent_columns"] == previous_line["indent_columns"]
        )
        if can_extend:
            previous_node["range"]["endLine"] = line["number"]
            previous_line = line
            continue

        while stack and stack[-1]["indent"]["columns"] > line["indent_columns"]:
            stack.pop()
        open_node_at_indent = stack[-1] if stack else None
        if (
            open_node_at_indent
            and open_node_at_indent["indent"]["columns"] == line["indent_columns"]
        ):
            open_node_at_indent["range"]["endLine"] = line["number"]
            if " " in line["indent_raw"] and "\t" in line["indent_raw"]:
                diagnostics.append(
                    {
                        "type": "mixed_indentation",
                        "line": line["number"],
                        "message": "Leading indentation mixes spaces and tabs.",
                    }
                )
            previous_line = line
            previous_node = open_node_at_indent
            continue
        if len(nodes) >= max_nodes:
            raise ValueError(f"Graph exceeds the {max_nodes:,}-node limit")
        parent = stack[-1] if stack else None
        node_id = f"n{len(nodes) + 1}"
        starts_after_indent_increase = (
            previous_line is not None
            and line["indent_columns"] > previous_line["indent_columns"]
        )
        level = (
            line["indent_columns"] // unit_columns
            if line["indent_columns"] % unit_columns == 0
            else None
        )
        node = {
            "id": node_id,
            "kind": "indentation",
            "parentId": parent["id"] if parent else None,
            "childIds": [],
            "depth": parent["depth"] + 1 if parent else 0,
            "indent": {
                "raw": line["indent_raw"],
                "columns": line["indent_columns"],
                "level": level,
            },
            "range": {
                "startLine": max(
                    1,
                    previous_line["number"]
                    if starts_after_indent_increase and previous_line
                    else line["number"],
                ),
                "endLine": line["number"],
            },
        }
        nodes.append(node)
        own_start_lines[node_id] = line["number"]
        if parent:
            parent["childIds"].append(node_id)
            if line["indent_columns"] - parent["indent"]["columns"] > unit_columns:
                diagnostics.append(
                    {
                        "type": "indentation_jump",
                        "line": line["number"],
                        "message": (
                            f"Indentation jumps from {parent['indent']['columns']} "
                            f"to {line['indent_columns']} columns without an "
                            "intermediate code node."
                        ),
                    }
                )
        else:
            roots.append(node_id)
        if " " in line["indent_raw"] and "\t" in line["indent_raw"]:
            diagnostics.append(
                {
                    "type": "mixed_indentation",
                    "line": line["number"],
                    "message": "Leading indentation mixes spaces and tabs.",
                }
            )
        stack.append(node)
        previous_line = line
        previous_node = node

    for node in nodes:
        candidate_line = node["range"]["startLine"] - 1
        while candidate_line >= 1:
            while candidate_line >= 1 and not raw_lines[candidate_line - 1].strip():
                candidate_line -= 1
            if (
                candidate_line < 1
                or not starts_with_leading_marker(raw_lines[candidate_line - 1])
            ):
                break
            node["range"]["startLine"] = min(
                node["range"]["startLine"], candidate_line
            )
            candidate_line -= 1

    for node in nodes:
        while (
            node["range"]["startLine"] < node["range"]["endLine"]
            and first_line_has_excess_closing(
                raw_lines[node["range"]["startLine"] - 1]
            )
        ):
            node["range"]["startLine"] += 1
        while (
            node["range"]["endLine"] < len(raw_lines)
            and not delimiters_balanced(
                scan_delimiters(
                    raw_lines,
                    node["range"]["startLine"],
                    node["range"]["endLine"],
                )
            )
        ):
            node["range"]["endLine"] += 1
        if not delimiters_balanced(
            scan_delimiters(
                raw_lines,
                node["range"]["startLine"],
                node["range"]["endLine"],
            )
        ):
            diagnostics.append(
                {
                    "type": "unbalanced_delimiters",
                    "line": node["range"]["startLine"],
                    "message": (
                        f"Node {node['id']} remains delimiter-unbalanced "
                        "at end of file."
                    ),
                }
            )

    nodes_by_id = {node["id"]: node for node in nodes}
    for node in reversed(nodes):
        parent_id = node["parentId"]
        if not parent_id:
            continue
        parent = nodes_by_id[parent_id]
        parent["range"]["startLine"] = min(
            parent["range"]["startLine"], node["range"]["startLine"]
        )
        parent["range"]["endLine"] = max(
            parent["range"]["endLine"], node["range"]["endLine"]
        )
    indentation_nodes = list(nodes)
    for parent in indentation_nodes:
        indentation_children = sorted(
            (
                nodes_by_id[child_id]
                for child_id in parent["childIds"]
                if child_id in nodes_by_id
            ),
            key=lambda child: child["range"]["startLine"],
        )
        if not indentation_children:
            continue

        parent_own_start = own_start_lines.get(
            parent["id"], parent["range"]["startLine"]
        )
        cursor = parent_own_start

        def add_remainder(start_line: int, end_line: int) -> None:
            while start_line <= end_line and not raw_lines[start_line - 1].strip():
                start_line += 1
            while end_line >= start_line and not raw_lines[end_line - 1].strip():
                end_line -= 1
            while (
                start_line < end_line
                and first_line_has_excess_closing(raw_lines[start_line - 1])
            ):
                start_line += 1
            if start_line > end_line:
                return
            if not delimiters_balanced(
                scan_delimiters(raw_lines, start_line, end_line)
            ):
                diagnostics.append(
                    {
                        "type": "unbalanced_remainder_skipped",
                        "line": start_line,
                        "message": (
                            f"Skipped delimiter-unbalanced remainder "
                            f"{start_line}-{end_line} inside {parent['id']}."
                        ),
                    }
                )
                return
            if len(nodes) >= max_nodes:
                raise ValueError(f"Graph exceeds the {max_nodes:,}-node limit")
            remainder_id = f"n{len(nodes) + 1}"
            remainder = {
                "id": remainder_id,
                "kind": "parent-remainder",
                "parentId": parent["id"],
                "childIds": [],
                "depth": parent["depth"] + 1,
                "indent": dict(parent["indent"]),
                "range": {"startLine": start_line, "endLine": end_line},
            }
            nodes.append(remainder)
            nodes_by_id[remainder_id] = remainder
            parent["childIds"].append(remainder_id)

        for child in indentation_children:
            if cursor < child["range"]["startLine"]:
                add_remainder(cursor, child["range"]["startLine"] - 1)
            cursor = max(cursor, child["range"]["endLine"] + 1)
        if cursor <= parent["range"]["endLine"]:
            add_remainder(cursor, parent["range"]["endLine"])
    for node in nodes:
        node["childIds"].sort(
            key=lambda child_id: (
                nodes_by_id[child_id]["range"]["startLine"],
                nodes_by_id[child_id]["range"]["endLine"],
            )
        )
    return {
        "version": 1,
        "kind": "indentation-code-graph",
        "source": {
            "path": path,
            "sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
            "lineCount": len(raw_lines),
            "newline": newline,
            "hasFinalNewline": bool(re.search(r"(?:\r\n|\n|\r)$", source)),
        },
        "indentation": {"unitColumns": unit_columns, "tabWidth": tab_width},
        "rangeContext": {
            "startLine": "previous-line-on-indent-increase",
            "endLine": "exact",
        },
        "delimiterPolicy": {
            "pairs": ["()", "{}", "[]"],
            "quotes": "even-unescaped-single-and-double",
            "leadingExcessClosing": "trim",
            "unbalancedRemainders": "skip",
        },
        "leadingLinePolicy": {
            "markers": ["//", "#", "@", "!"],
            "skipBlankLines": True,
            "overlapAllowed": True,
        },
        "rootIds": roots,
        "nodes": nodes,
        "diagnostics": diagnostics,
    }


class CodeGraphViewer(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Indentation Code Graph")
        self.geometry("1320x820")
        self.minsize(900, 600)
        self.configure(bg="#090d16")
        self.graph: dict[str, Any] | None = None
        self.current_path: Path | None = None
        self.current_source_lines: list[str] = []
        self.node_items: dict[str, tuple[int, int]] = {}
        self._configure_styles()
        self._build_ui()

    def _configure_styles(self) -> None:
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Toolbar.TFrame", background="#111827")
        style.configure(
            "Toolbar.TButton",
            background="#1d4ed8",
            foreground="#ffffff",
            borderwidth=0,
            padding=(14, 8),
            font=("Segoe UI", 10, "bold"),
        )
        style.map("Toolbar.TButton", background=[("active", "#2563eb")])
        style.configure(
            "Secondary.TButton",
            background="#273244",
            foreground="#e5e7eb",
            borderwidth=0,
            padding=(12, 8),
        )
        style.map("Secondary.TButton", background=[("active", "#374151")])

    def _build_ui(self) -> None:
        toolbar = ttk.Frame(self, style="Toolbar.TFrame", padding=(14, 12))
        toolbar.pack(fill="x")
        ttk.Button(
            toolbar,
            text="Choose code file",
            style="Toolbar.TButton",
            command=self.choose_file,
        ).pack(side="left")
        self.export_button = ttk.Button(
            toolbar,
            text="Export JSON",
            style="Secondary.TButton",
            command=self.export_json,
            state="disabled",
        )
        self.export_button.pack(side="left", padx=(10, 0))
        self.file_label = tk.Label(
            toolbar,
            text="No file selected",
            bg="#111827",
            fg="#9ca3af",
            font=("Segoe UI", 10),
            anchor="w",
        )
        self.file_label.pack(side="left", fill="x", expand=True, padx=18)

        body = tk.PanedWindow(
            self,
            orient="horizontal",
            bg="#090d16",
            sashwidth=6,
            sashrelief="flat",
            bd=0,
        )
        body.pack(fill="both", expand=True)

        graph_frame = tk.Frame(body, bg="#090d16")
        body.add(graph_frame, stretch="always", minsize=580)
        self.canvas = tk.Canvas(
            graph_frame,
            bg="#090d16",
            highlightthickness=0,
            xscrollincrement=20,
            yscrollincrement=20,
        )
        x_scroll = ttk.Scrollbar(
            graph_frame, orient="horizontal", command=self.canvas.xview
        )
        y_scroll = ttk.Scrollbar(
            graph_frame, orient="vertical", command=self.canvas.yview
        )
        self.canvas.configure(
            xscrollcommand=x_scroll.set,
            yscrollcommand=y_scroll.set,
        )
        self.canvas.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")
        graph_frame.rowconfigure(0, weight=1)
        graph_frame.columnconfigure(0, weight=1)
        self.canvas.bind("<MouseWheel>", self._mouse_wheel)
        self.canvas.bind("<Shift-MouseWheel>", self._shift_mouse_wheel)

        detail = tk.Frame(body, bg="#111827", width=390)
        body.add(detail, minsize=320)
        tk.Label(
            detail,
            text="NODE INSPECTOR",
            bg="#111827",
            fg="#60a5fa",
            font=("Segoe UI", 9, "bold"),
            anchor="w",
        ).pack(fill="x", padx=18, pady=(18, 6))
        self.detail_title = tk.Label(
            detail,
            text="Choose a file to begin",
            bg="#111827",
            fg="#f9fafb",
            font=("Segoe UI", 15, "bold"),
            anchor="w",
            justify="left",
        )
        self.detail_title.pack(fill="x", padx=18)
        self.detail_meta = tk.Label(
            detail,
            text="The graph is generated entirely on this device.",
            bg="#111827",
            fg="#9ca3af",
            font=("Segoe UI", 9),
            anchor="w",
            justify="left",
            wraplength=340,
        )
        self.detail_meta.pack(fill="x", padx=18, pady=(5, 12))
        self.code = tk.Text(
            detail,
            bg="#080c14",
            fg="#dbeafe",
            insertbackground="#ffffff",
            selectbackground="#1d4ed8",
            relief="flat",
            padx=14,
            pady=14,
            font=("Consolas", 10),
            wrap="none",
            state="disabled",
        )
        code_y_scroll = ttk.Scrollbar(detail, orient="vertical", command=self.code.yview)
        code_x_scroll = ttk.Scrollbar(
            detail, orient="horizontal", command=self.code.xview
        )
        self.code.configure(
            yscrollcommand=code_y_scroll.set,
            xscrollcommand=code_x_scroll.set,
        )
        self.code.pack(fill="both", expand=True, padx=(18, 0), pady=(0, 0))
        code_y_scroll.place(relx=1, rely=0.17, relheight=0.79, anchor="ne")
        code_x_scroll.pack(fill="x", padx=(18, 14), pady=(0, 14))

        self.status = tk.Label(
            self,
            text="Ready",
            bg="#060910",
            fg="#94a3b8",
            font=("Segoe UI", 9),
            anchor="w",
            padx=14,
            pady=7,
        )
        self.status.pack(fill="x")

        self._draw_empty_state()

    def _draw_empty_state(self) -> None:
        self.canvas.delete("all")
        self.canvas.create_text(
            50,
            55,
            anchor="nw",
            text="Choose a source file",
            fill="#f8fafc",
            font=("Segoe UI", 24, "bold"),
        )
        self.canvas.create_text(
            52,
            100,
            anchor="nw",
            width=520,
            text=(
                "Python, TypeScript, JavaScript, Java, C, and other text-based "
                "languages work. Nodes are connected using leading indentation."
            ),
            fill="#94a3b8",
            font=("Segoe UI", 11),
        )

    def choose_file(self) -> None:
        path = filedialog.askopenfilename(
            title="Choose a code file",
            filetypes=[
                ("Code files", "*.py *.ts *.tsx *.js *.jsx *.java *.c *.cpp *.go *.rs"),
                ("All files", "*.*"),
            ],
        )
        if not path:
            return
        try:
            source = Path(path).read_text(encoding="utf-8")
            graph = graph_code(source, path=str(Path(path).resolve()))
        except UnicodeDecodeError:
            messagebox.showerror(
                "Cannot read file", "The selected file is not valid UTF-8 text."
            )
            return
        except (OSError, ValueError) as error:
            messagebox.showerror("Cannot graph file", str(error))
            return

        self.current_path = Path(path)
        self.current_source_lines = re.split(r"\r\n|\n|\r", source)
        self.graph = graph
        self.file_label.configure(text=str(self.current_path))
        self.export_button.configure(state="normal")
        self._render_graph()

    def _render_graph(self) -> None:
        assert self.graph is not None
        self.canvas.delete("all")
        self.node_items.clear()
        nodes = sorted(
            self.graph["nodes"],
            key=lambda node: (
                node["range"]["startLine"],
                node["depth"],
                node["range"]["endLine"],
            ),
        )
        coordinates: dict[str, tuple[float, float]] = {}

        for index, node in enumerate(nodes):
            x = CANVAS_MARGIN + node["depth"] * (NODE_WIDTH + X_GAP)
            y = CANVAS_MARGIN + index * (NODE_HEIGHT + Y_GAP)
            coordinates[node["id"]] = (x, y)

        for node in nodes:
            parent_id = node["parentId"]
            if not parent_id:
                continue
            parent_x, parent_y = coordinates[parent_id]
            child_x, child_y = coordinates[node["id"]]
            self.canvas.create_line(
                parent_x + NODE_WIDTH,
                parent_y + NODE_HEIGHT / 2,
                child_x - 14,
                child_y + NODE_HEIGHT / 2,
                fill="#334155",
                width=2,
                smooth=True,
                arrow="last",
                arrowshape=(8, 10, 4),
            )

        for node in nodes:
            x, y = coordinates[node["id"]]
            color = DEPTH_COLORS[node["depth"] % len(DEPTH_COLORS)]
            tag = f"node:{node['id']}"
            rectangle = self.canvas.create_rectangle(
                x,
                y,
                x + NODE_WIDTH,
                y + NODE_HEIGHT,
                fill="#111827",
                outline=color,
                width=2,
                tags=(tag, "node"),
            )
            line_range = node["range"]
            node_kind = "remainder" if node.get("kind") == "parent-remainder" else "indent"
            title = (
                f"{node['id']} · {node_kind} · lines "
                f"{line_range['startLine']}–{line_range['endLine']}"
            )
            self.canvas.create_text(
                x + 12,
                y + 10,
                anchor="nw",
                text=title,
                fill=color,
                font=("Segoe UI", 9, "bold"),
                tags=(tag, "node"),
            )
            line_range = node["range"]
            preview = self.current_source_lines[line_range["startLine"] - 1].strip()
            if len(preview) > 32:
                preview = preview[:31] + "…"
            text_item = self.canvas.create_text(
                x + 12,
                y + 34,
                anchor="nw",
                text=preview or "(blank)",
                fill="#e5e7eb",
                font=("Consolas", 9),
                tags=(tag, "node"),
            )
            self.node_items[node["id"]] = (rectangle, text_item)
            self.canvas.tag_bind(
                tag,
                "<Button-1>",
                lambda _event, node_id=node["id"]: self.select_node(node_id),
            )
            self.canvas.tag_bind(
                tag, "<Enter>", lambda _event: self.canvas.configure(cursor="hand2")
            )
            self.canvas.tag_bind(
                tag, "<Leave>", lambda _event: self.canvas.configure(cursor="")
            )

        max_depth = max((node["depth"] for node in nodes), default=0)
        width = CANVAS_MARGIN * 2 + (max_depth + 1) * (NODE_WIDTH + X_GAP)
        height = CANVAS_MARGIN * 2 + max(1, len(nodes)) * (NODE_HEIGHT + Y_GAP)
        self.canvas.configure(scrollregion=(0, 0, width, height))
        self.canvas.xview_moveto(0)
        self.canvas.yview_moveto(0)

        diagnostics = len(self.graph["diagnostics"])
        self.status.configure(
            text=(
                f"{len(nodes)} nodes  •  {len(self.graph['rootIds'])} roots  •  "
                f"indent unit {self.graph['indentation']['unitColumns']} columns  •  "
                f"{diagnostics} diagnostic{'s' if diagnostics != 1 else ''}"
            )
        )
        if nodes:
            self.select_node(nodes[0]["id"])
        else:
            self.detail_title.configure(text="Empty file")
            self.detail_meta.configure(text="No nonblank code lines were found.")
            self._set_code("")

    def select_node(self, node_id: str) -> None:
        assert self.graph is not None
        node = next(node for node in self.graph["nodes"] if node["id"] == node_id)
        for candidate_id, (rectangle, _text) in self.node_items.items():
            candidate = next(
                item for item in self.graph["nodes"] if item["id"] == candidate_id
            )
            color = DEPTH_COLORS[candidate["depth"] % len(DEPTH_COLORS)]
            self.canvas.itemconfigure(
                rectangle,
                fill="#172554" if candidate_id == node_id else "#111827",
                width=4 if candidate_id == node_id else 2,
                outline="#93c5fd" if candidate_id == node_id else color,
            )

        line_range = node["range"]
        self.detail_title.configure(
            text=f"{node['id']} · {node.get('kind', 'indentation')} · depth {node['depth']}"
        )
        self.detail_meta.configure(
            text=(
                f"Lines {line_range['startLine']}–{line_range['endLine']}  •  "
                f"indent {node['indent']['columns']} columns  •  "
                f"parent {node['parentId'] or 'none'}  •  "
                f"{len(node['childIds'])} children"
            )
        )
        start_line = line_range["startLine"]
        end_line = line_range["endLine"]
        addressed_code = "\n".join(
            self.current_source_lines[start_line - 1 : end_line]
        )
        self._set_code(addressed_code)

    def _set_code(self, content: str) -> None:
        self.code.configure(state="normal")
        self.code.delete("1.0", "end")
        self.code.insert("1.0", content)
        self.code.configure(state="disabled")

    def export_json(self) -> None:
        if self.graph is None:
            return
        default_name = (
            f"{self.current_path.stem}.code-graph.json"
            if self.current_path
            else "code-graph.json"
        )
        path = filedialog.asksaveasfilename(
            title="Export graph JSON",
            defaultextension=".json",
            initialfile=default_name,
            filetypes=[("JSON files", "*.json")],
        )
        if not path:
            return
        try:
            Path(path).write_text(
                json.dumps(self.graph, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        except OSError as error:
            messagebox.showerror("Cannot export JSON", str(error))
            return
        self.status.configure(text=f"Exported graph to {path}")

    def _mouse_wheel(self, event: tk.Event) -> str:
        self.canvas.yview_scroll(-1 * int(event.delta / 120), "units")
        return "break"

    def _shift_mouse_wheel(self, event: tk.Event) -> str:
        self.canvas.xview_scroll(-1 * int(event.delta / 120), "units")
        return "break"


if __name__ == "__main__":
    CodeGraphViewer().mainloop()
