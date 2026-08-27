import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	type TUI,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

export const MAX_FILE_BYTES = 256 * 1024;
const OVERLAY_HEIGHT_RATIO = 0.96;
const OVERLAY_BORDER_ROWS = 2;
const BODY_CHROME_ROWS = 2;
const NARROW_SEPARATOR_ROWS = 1;
const EDITOR_CHROME_ROWS = 2;
const STATUS_ROWS = 1;
const MIN_SOURCE_ROWS = 5;
const MIN_COMMENT_ROWS = 4;

const annotateFileSchema = Type.Object({
	path: Type.String({ description: "Path to one text file, relative to the active working directory or absolute" }),
	comments: Type.Array(
		Type.Object({
			startLine: Type.Integer({ minimum: 1, description: "One-based first line for the agent comment" }),
			endLine: Type.Integer({ minimum: 1, description: "One-based last line for the agent comment" }),
			text: Type.String({ description: "The agent-authored comment" }),
		}),
		{ description: "Agent comments anchored to one-based source line ranges" },
	),
});

type AnnotateFileInput = Static<typeof annotateFileSchema>;
export type Range = { startLine: number; endLine: number };
export type AgentComment = Range & { id: string; text: string };
export type UserComment = Range & { id: string; text: string; parentId?: string };
type ReviewResult = { cancelled: true } | { cancelled: false; comments: UserComment[] };

type ReviewComment = AgentComment | UserComment;

export function commentSort(left: ReviewComment, right: ReviewComment): number {
	return left.startLine - right.startLine || left.endLine - right.endLine || left.id.localeCompare(right.id);
}

function hashContent(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function normalizePathInput(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function formatRange(range: Range): string {
	return range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`;
}

export function validateRange(range: Range, lineCount: number, label: string): Range {
	if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine)) {
		throw new Error(`${label} must use integer line numbers`);
	}
	if (range.startLine < 1 || range.endLine < range.startLine || range.endLine > lineCount) {
		throw new Error(`${label} has invalid line range ${range.startLine}-${range.endLine} for ${lineCount} lines`);
	}
	return range;
}

export function sourceExcerpt(lines: string[], range: Range): string {
	return lines.slice(range.startLine - 1, range.endLine).join("\n");
}

function commentMatchesLine(comment: ReviewComment, line: number): boolean {
	return line >= comment.startLine && line <= comment.endLine;
}

export function rangesIntersect(left: Range, right: Range): boolean {
	return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

export function wrapSourceLine(line: string, width: number, enabled = true): string[] {
	if (!enabled) return [line];
	const wrapped = wrapTextWithAnsi(line, Math.max(1, width));
	return wrapped.length > 0 ? wrapped : [""];
}

export function commentFocusOffset(startLine: number, sourceVisualOffsets: number[], sourceRows: number, totalLines: number): number {
	const contextLine = Math.max(1, startLine - 2);
	const visualStart = sourceVisualOffsets[Math.max(0, contextLine - 1)] ?? 0;
	const totalVisualRows = sourceVisualOffsets[totalLines] ?? totalLines;
	return Math.max(0, Math.min(Math.max(0, totalVisualRows - sourceRows), visualStart));
}

function commentLabel(comment: ReviewComment): string {
	if (!isUserComment(comment)) return "PI";
	return comment.parentId ? "YOU reply" : "YOU";
}

function isUserComment(comment: ReviewComment): comment is UserComment {
	return comment.id.startsWith("user-");
}

export function expandVisibleTabs(text: string): string {
	return text.replaceAll("\t", "   ");
}

const editorTheme = (theme: Theme): EditorTheme => ({
	borderColor: (text) => theme.fg("accent", text),
	selectList: {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	},
});

export class FileReviewComponent {
	private cursorLine = 1;
	private rangeAnchor: number | null = null;
	private scrollOffset = 0;
	private sourceRows = MIN_SOURCE_ROWS;
	private commentRows = MIN_COMMENT_ROWS;
	private commentIndex: number | null = null;
	private commentScrollOffset = 0;
	private wrapEnabled = true;
	private sourceContentWidth = 1;
	private sourceVisualOffsets: number[] = [];
	private pendingCommentFocus: number | null = null;
	private commentNavigationStarted = false;
	private editing:
		| { kind: "annotation"; startLine: number; endLine: number; commentId?: undefined }
		| { kind: "reply"; startLine: number; endLine: number; parentId: string; commentId?: undefined }
		| { kind: "edit"; startLine: number; endLine: number; commentId: string }
		| null = null;
	private editor: Editor;
	private status = "";
	private submitting = false;
	private nextUserId = 1;
	private readonly comments: ReviewComment[];
	private completed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly path: string,
		private readonly lines: string[],
		private readonly highlightedLines: string[],
		agentComments: AgentComment[],
		private readonly initialHash: string,
		private readonly readCurrent: () => Promise<Buffer>,
		private readonly done: (result: ReviewResult) => void,
	) {
		this.comments = [...agentComments];
		const firstLineComment = this.allComments().findIndex((comment) => commentMatchesLine(comment, 1));
		this.commentIndex = firstLineComment >= 0 ? firstLineComment : null;
		this.editor = new Editor(tui, editorTheme(theme));
		this.editor.disableSubmit = false;
		this.editor.onSubmit = (text) => this.saveEditorText(text);
	}

	isCompleted(): boolean {
		return this.completed;
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private allComments(): ReviewComment[] {
		const agents = this.comments.filter((comment): comment is AgentComment => !isUserComment(comment));
		const agentIds = new Set(agents.map((comment) => comment.id));
		const roots = this.comments
			.filter((comment) => !isUserComment(comment) || !comment.parentId || !agentIds.has(comment.parentId))
			.sort(commentSort);
		const replies = new Map<string, UserComment[]>();
		for (const comment of this.comments) {
			if (!isUserComment(comment) || !comment.parentId || !agentIds.has(comment.parentId)) continue;
			const siblings = replies.get(comment.parentId) ?? [];
			siblings.push(comment);
			replies.set(comment.parentId, siblings);
		}
		for (const siblings of replies.values()) siblings.sort(commentSort);
		return roots.flatMap((comment) => [comment, ...(replies.get(comment.id) ?? [])]);
	}

	private commentDepth(comment: ReviewComment): number {
		return isUserComment(comment) && comment.parentId && this.comments.some((candidate) => candidate.id === comment.parentId && !isUserComment(candidate)) ? 1 : 0;
	}

	private selectedComment(): ReviewComment | undefined {
		return this.commentIndex === null ? undefined : this.allComments()[this.commentIndex];
	}

	private selectCommentById(id: string): void {
		const index = this.allComments().findIndex((comment) => comment.id === id);
		this.commentIndex = index >= 0 ? index : null;
	}

	private setStatus(text: string): void {
		this.status = text;
		this.refresh();
	}

	private selectedRange(): Range {
		const other = this.rangeAnchor ?? this.cursorLine;
		return {
			startLine: Math.min(other, this.cursorLine),
			endLine: Math.max(other, this.cursorLine),
		};
	}

	private syncCommentSelectionToRange(): void {
		const comments = this.allComments();
		const range = this.selectedRange();
		const selected = this.commentIndex === null ? undefined : comments[this.commentIndex];
		if (selected && rangesIntersect(selected, range)) return;
		const intersecting = comments.findIndex((comment) => rangesIntersect(comment, range));
		this.commentIndex = intersecting >= 0 ? intersecting : null;
	}

	private commentIsHighlighted(comment: ReviewComment): boolean {
		return rangesIntersect(comment, this.selectedRange());
	}

	private moveCursor(delta: number, extend = false): void {
		if (!extend) this.rangeAnchor = null;
		if (extend && this.rangeAnchor === null) this.rangeAnchor = this.cursorLine;
		if (extend && this.rangeAnchor !== null && this.cursorLine > this.rangeAnchor && delta < 0) {
			const previousAnchor = this.rangeAnchor;
			this.rangeAnchor = this.cursorLine;
			this.cursorLine = Math.max(1, previousAnchor + delta);
		} else {
			this.cursorLine = Math.max(1, Math.min(this.lines.length, this.cursorLine + delta));
		}
		this.syncCommentSelectionToRange();
		this.commentNavigationStarted = false;
		this.keepCursorVisible();
		this.refresh();
	}

	private beginEditor(editing: FileReviewComponent["editing"], text: string): void {
		this.editing = editing;
		this.editor.setText(text);
		this.status = "Enter save • Shift+Enter newline • Esc cancel";
		this.refresh();
	}

	private saveEditorText(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || !this.editing) {
			this.setStatus("Comment text cannot be empty");
			return;
		}
		const editing = this.editing;
		if (editing.kind === "edit") {
			const existing = this.comments.find((comment): comment is UserComment => isUserComment(comment) && comment.id === editing.commentId);
			if (existing) {
				existing.startLine = editing.startLine;
				existing.endLine = editing.endLine;
				existing.text = trimmed;
				this.selectCommentById(existing.id);
			}
		} else {
			const comment: UserComment = {
				id: `user-${this.nextUserId++}`,
				startLine: editing.startLine,
				endLine: editing.endLine,
				text: trimmed,
			};
			if (editing.kind === "reply") comment.parentId = editing.parentId;
			this.comments.push(comment);
			this.selectCommentById(comment.id);
		}
		this.editing = null;
		this.editor.setText("");
		this.status = "Comment saved";
		this.refresh();
	}

	private deleteSelectedUserComment(): void {
		const selected = this.selectedComment();
		if (!selected || !isUserComment(selected)) {
			this.setStatus("Select one of your comments first");
			return;
		}
		const index = this.comments.indexOf(selected);
		this.comments.splice(index, 1);
		const ordered = this.allComments();
		this.commentIndex = ordered.length > 0 ? Math.min(this.commentIndex ?? 0, ordered.length - 1) : null;
		this.setStatus("Comment deleted");
	}

	private commentIndexFromSource(delta: number, comments: ReviewComment[]): number {
		const range = this.selectedRange();
		const selected = this.commentIndex === null ? undefined : comments[this.commentIndex];
		if (selected) {
			const peers = comments
				.map((comment, index) => ({ comment, index }))
				.filter(({ comment }) => comment.startLine === selected.startLine && comment.endLine === selected.endLine);
			const peerIndex = peers.findIndex(({ index }) => index === this.commentIndex);
			const nextPeer = peers[peerIndex + (delta > 0 ? 1 : -1)];
			if (nextPeer) return nextPeer.index;
		}
		if (delta > 0) {
			const next = comments.findIndex((comment) => comment.startLine > this.cursorLine);
			if (next >= 0) return next;
		} else {
			for (let index = comments.length - 1; index >= 0; index--) {
				if (comments[index]!.endLine < this.cursorLine) return index;
			}
		}
		if (!this.commentNavigationStarted) {
			if (selected && rangesIntersect(selected, range)) return this.commentIndex!;
			const intersecting = comments.findIndex((comment) => rangesIntersect(comment, range));
			if (intersecting >= 0) return intersecting;
		}
		return delta > 0 ? 0 : comments.length - 1;
	}

	private cycleComment(delta: number): void {
		if (this.comments.length === 0) {
			this.setStatus("No comments to select");
			return;
		}
		const comments = this.allComments();
		this.commentIndex = this.commentIndexFromSource(delta, comments);
		this.commentNavigationStarted = true;
		const comment = this.selectedComment()!;
		this.cursorLine = comment.endLine;
		this.rangeAnchor = comment.endLine === comment.startLine ? null : comment.startLine;
		this.pendingCommentFocus = comment.startLine;
		this.refresh();
	}

	private sourcePanelWidth(width: number): number {
		return width >= 100 ? Math.floor(width * 0.62) : width;
	}

	private sourceVisualRowsForLine(line: string): string[] {
		return wrapSourceLine(line, this.sourceContentWidth, this.wrapEnabled);
	}

	private rebuildSourceLayout(width: number): void {
		const lineNumberWidth = Math.max(2, String(this.lines.length).length);
		this.sourceContentWidth = Math.max(1, this.sourcePanelWidth(width) - lineNumberWidth - 3);
		this.sourceVisualOffsets = [0];
		for (let index = 0; index < this.lines.length; index++) {
			const line = this.highlightedLines[index] ?? this.lines[index] ?? "";
			this.sourceVisualOffsets.push(this.sourceVisualOffsets[this.sourceVisualOffsets.length - 1] + this.sourceVisualRowsForLine(line).length);
		}
	}

	private visualLineStart(line: number): number {
		return this.sourceVisualOffsets[Math.max(0, line - 1)] ?? 0;
	}

	private keepCursorVisible(): void {
		const cursorStart = this.visualLineStart(this.cursorLine);
		const cursorEnd = Math.max(cursorStart, (this.sourceVisualOffsets[this.cursorLine] ?? cursorStart + 1) - 1);
		if (cursorStart < this.scrollOffset) this.scrollOffset = cursorStart;
		if (cursorEnd >= this.scrollOffset + this.sourceRows) this.scrollOffset = cursorEnd - this.sourceRows + 1;
		const max = Math.max(0, (this.sourceVisualOffsets[this.lines.length] ?? this.lines.length) - this.sourceRows);
		this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset));
	}

	private updateLayout(width: number): void {
		const wide = width >= 100;
		const terminalRows = Math.max(1, this.tui.terminal.rows);
		const overlayRows = Math.max(1, Math.min(terminalRows, Math.floor(terminalRows * OVERLAY_HEIGHT_RATIO)));
		const bodyRows = Math.max(1, overlayRows - OVERLAY_BORDER_ROWS);
		const editorRows = this.editing ? EDITOR_CHROME_ROWS + this.editor.render(Math.max(1, width)).length : 0;
		const statusRows = this.status ? STATUS_ROWS : 0;
		const layoutRows = Math.max(1, bodyRows - BODY_CHROME_ROWS - editorRows - statusRows);

		if (wide) {
			this.sourceRows = layoutRows;
			this.commentRows = layoutRows;
		} else {
			const availableRows = Math.max(2, layoutRows - NARROW_SEPARATOR_ROWS);
			const minimumSourceRows = Math.min(MIN_SOURCE_ROWS, Math.max(1, availableRows - 1));
			const minimumCommentRows = Math.min(MIN_COMMENT_ROWS, Math.max(1, availableRows - minimumSourceRows));
			this.commentRows = Math.max(minimumCommentRows, Math.floor(availableRows * 0.3));
			this.commentRows = Math.min(this.commentRows, Math.max(1, availableRows - minimumSourceRows));
			this.sourceRows = Math.max(1, availableRows - this.commentRows);
		}

		this.rebuildSourceLayout(width);
		if (this.pendingCommentFocus !== null) {
			this.scrollOffset = commentFocusOffset(
				this.pendingCommentFocus,
				this.sourceVisualOffsets,
				this.sourceRows,
				this.lines.length,
			);
			this.pendingCommentFocus = null;
		}
		this.keepCursorVisible();
	}

	private submit(): void {
		if (this.submitting) return;
		this.submitting = true;
		this.status = "Checking that the source file is unchanged...";
		this.refresh();
		this.readCurrent()
			.then((current) => {
				if (hashContent(current) !== this.initialHash) {
					this.submitting = false;
					this.status = "Source changed. Review was not submitted. Cancel and reopen the file.";
					this.refresh();
					return;
				}
				this.completed = true;
				this.done({
					cancelled: false,
					comments: this.comments.filter((comment): comment is UserComment => isUserComment(comment)).sort(commentSort),
				});
			})
			.catch((error: unknown) => {
				this.submitting = false;
				this.status = `Could not verify source: ${error instanceof Error ? error.message : String(error)}`;
				this.refresh();
			});
	}

	handleInput(data: string): void {
		if (this.submitting) return;
		if (this.editing) {
			if (matchesKey(data, Key.escape)) {
				this.editing = null;
				this.editor.setText("");
				this.status = "Comment editing cancelled";
				this.refresh();
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.completed = true;
			this.done({ cancelled: true });
			return;
		}
		if (matchesKey(data, Key.shift("up")) || matchesKey(data, Key.shift("k")) || data === "K") {
			this.moveCursor(-1, true);
			return;
		}
		if (matchesKey(data, Key.shift("down")) || matchesKey(data, Key.shift("j")) || data === "J") {
			this.moveCursor(1, true);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.moveCursor(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.moveCursor(1);
			return;
		}
		if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.pageUp)) {
			this.moveCursor(-Math.max(1, Math.floor(this.sourceRows / 2)));
			return;
		}
		if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.pageDown)) {
			this.moveCursor(Math.max(1, Math.floor(this.sourceRows / 2)));
			return;
		}
		if (data === "w") {
			this.wrapEnabled = !this.wrapEnabled;
			this.scrollOffset = 0;
			this.status = `Source wrapping ${this.wrapEnabled ? "enabled" : "disabled"}`;
			this.refresh();
			return;
		}
		if (data === "g" || matchesKey(data, Key.home)) {
			this.rangeAnchor = null;
			this.cursorLine = 1;
			this.syncCommentSelectionToRange();
			this.commentNavigationStarted = false;
			this.keepCursorVisible();
			this.refresh();
			return;
		}
		if (data === "G" || matchesKey(data, Key.end)) {
			this.rangeAnchor = null;
			this.cursorLine = this.lines.length;
			this.syncCommentSelectionToRange();
			this.commentNavigationStarted = false;
			this.keepCursorVisible();
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.rangeAnchor = this.rangeAnchor === null ? this.cursorLine : null;
			this.syncCommentSelectionToRange();
			this.commentNavigationStarted = false;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.cycleComment(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.cycleComment(-1);
			return;
		}
		if (data === "a") {
			const range = this.selectedRange();
			this.beginEditor({ kind: "annotation", ...range }, "");
			return;
		}
		if (data === "r") {
			const selected = this.selectedComment();
			if (!selected || !("id" in selected) || isUserComment(selected)) {
				this.setStatus("Select a PI comment before replying");
				return;
			}
			this.beginEditor({ kind: "reply", startLine: selected.startLine, endLine: selected.endLine, parentId: selected.id }, "");
			return;
		}
		if (data === "e") {
			const selected = this.selectedComment();
			if (!selected || !isUserComment(selected)) {
				this.setStatus("Select one of your comments before editing");
				return;
			}
			this.beginEditor(
				{ kind: "edit", startLine: selected.startLine, endLine: selected.endLine, commentId: selected.id },
				selected.text,
			);
			return;
		}
		if (data === "d" || data === "x") {
			this.deleteSelectedUserComment();
			return;
		}
		if (data === "s" || matchesKey(data, Key.enter)) {
			this.submit();
		}
	}

	private renderSource(width: number): string[] {
		const lineNumberWidth = Math.max(2, String(this.lines.length).length);
		const output: string[] = [];
		const selected = this.selectedRange();
		const firstLogicalLine = this.sourceVisualOffsets.findIndex((offset, index) => index > 0 && offset > this.scrollOffset);
		let line = Math.max(1, firstLogicalLine < 0 ? this.lines.length : firstLogicalLine);
		while (line > 1 && this.visualLineStart(line) > this.scrollOffset) line -= 1;
		let visualOffset = this.visualLineStart(line);
		while (output.length < this.sourceRows && line <= this.lines.length) {
			const wrapped = this.sourceVisualRowsForLine(this.highlightedLines[line - 1] ?? this.lines[line - 1] ?? "");
			const firstRow = Math.max(0, this.scrollOffset - visualOffset);
			const comments = this.comments.filter((comment) => commentMatchesLine(comment, line));
			const marker = comments.some((comment) => !isUserComment(comment))
				? this.theme.fg("accent", "◆")
				: comments.length > 0
					? this.theme.fg("success", "●")
					: " ";
			for (let row = firstRow; row < wrapped.length && output.length < this.sourceRows; row++) {
				const prefix = row === 0
					? `${marker} ${String(line).padStart(lineNumberWidth, " ")} `
					: `${" ".repeat(lineNumberWidth + 1)}↳ `;
				const rendered = truncateToWidth(`${prefix}${wrapped[row] ?? ""}`, width, "", true);
				const isSelected = line >= selected.startLine && line <= selected.endLine;
				output.push(isSelected ? this.theme.bg("selectedBg", rendered) : rendered);
			}
			visualOffset += wrapped.length;
			line += 1;
		}
		while (output.length < this.sourceRows) output.push("");
		return output;
	}

	private renderComments(width: number, rows: number): string[] {
		const comments = this.allComments();
		if (comments.length === 0) {
			return [this.theme.fg("dim", "No comments yet. Select lines and press a."), ...Array(Math.max(0, rows - 1)).fill("")];
		}

		const blocks = comments.map((comment, index) => {
			const depth = this.commentDepth(comment);
			const next = comments[index + 1];
			const nextParentId = next && isUserComment(next) ? next.parentId : undefined;
			const parentId = isUserComment(comment) ? comment.parentId : undefined;
			const branch = depth > 0 ? `${"  ".repeat(depth - 1)}${index === comments.length - 1 || nextParentId !== parentId ? "└─" : "├─"} ` : "";
			const prefix = `${index === this.commentIndex ? "▶" : " "} ${branch}${commentLabel(comment)}:${formatRange(comment)} `;
			const continuation = `${"  ".repeat(depth)}  `;
			const continuationWidth = Math.max(1, width - visibleWidth(continuation));
			const displayPrefix = truncateToWidth(prefix, Math.max(1, width), "", false);
			const firstWidth = width > visibleWidth(displayPrefix) ? width - visibleWidth(displayPrefix) : 0;
			const textLines = wrapTextWithAnsi(comment.text, Math.max(1, firstWidth || continuationWidth));
			const wrapped =
				firstWidth > 0
					? [`${displayPrefix}${textLines[0] ?? ""}`, ...textLines.slice(1).map((line) => `${continuation}${line}`)]
					: [displayPrefix, ...wrapTextWithAnsi(comment.text, continuationWidth).map((line) => `${continuation}${line}`)];
			const color = isUserComment(comment) ? "success" : "accent";
			const active = this.commentIsHighlighted(comment);
			return wrapped.map((line) => {
				if (active) return this.theme.bg("selectedBg", line);
				return index === this.commentIndex ? this.theme.fg("accent", line) : this.theme.fg(color, line);
			});
		});
		const totalRows = blocks.reduce((total, block) => total + block.length, 0);
		const selectedStart = this.commentIndex === null ? 0 : blocks.slice(0, this.commentIndex).reduce((total, block) => total + block.length, 0);
		const selectedEnd = this.commentIndex === null ? -1 : selectedStart + blocks[this.commentIndex]!.length - 1;
		const maxScrollOffset = Math.max(0, totalRows - rows);
		if (this.commentIndex !== null) {
			if (selectedStart < this.commentScrollOffset) this.commentScrollOffset = selectedStart;
			if (selectedEnd >= this.commentScrollOffset + rows) this.commentScrollOffset = selectedEnd - rows + 1;
		}
		this.commentScrollOffset = Math.max(0, Math.min(maxScrollOffset, this.commentScrollOffset));

		const output = blocks.flat();
		return [...output.slice(this.commentScrollOffset, this.commentScrollOffset + rows), ...Array(Math.max(0, rows - output.length + this.commentScrollOffset)).fill("")];
	}

	private renderBody(width: number): string[] {
		const wide = width >= 100;
		this.updateLayout(width);
		const output: string[] = [];
		const title = ` annotate_file · ${this.path} · ${this.lines.length} lines `;
		output.push(this.theme.fg("accent", truncateToWidth(title, width, "…", true)));
		output.push(this.theme.fg("dim", truncateToWidth(`Line ${formatRange(this.selectedRange())} · wrap ${this.wrapEnabled ? "on" : "off"} (w) · Shift+↑↓/J/K extend · Tab comments · a add · r reply · e edit · d delete · s submit · Esc cancel`, width, "…", true)));
		if (wide) {
			const sourceWidth = this.sourcePanelWidth(width);
			const commentWidth = Math.max(1, width - sourceWidth - 3);
			const source = this.renderSource(sourceWidth);
			const comments = this.renderComments(commentWidth, this.commentRows);
			for (let index = 0; index < this.sourceRows; index++) {
				const leftText = truncateToWidth(source[index] ?? "", sourceWidth, "", false);
				const rightText = truncateToWidth(comments[index] ?? "", commentWidth, "", false);
				const left = leftText + " ".repeat(Math.max(0, sourceWidth - visibleWidth(leftText)));
				const right = rightText + " ".repeat(Math.max(0, commentWidth - visibleWidth(rightText)));
				output.push(`${left} ${this.theme.fg("border", "│")} ${right}`);
			}
		} else {
			output.push(...this.renderSource(width));
			output.push(this.theme.fg("border", "─".repeat(Math.max(1, width))));
			output.push(...this.renderComments(width, this.commentRows));
		}
		if (this.editing) {
			output.push(this.theme.fg("border", "─".repeat(Math.max(1, width))));
			const editLabel = this.editing.kind === "reply" ? "Reply" : this.editing.kind === "edit" ? "Edit comment" : "New comment";
			output.push(this.theme.fg("accent", `${editLabel} on lines ${formatRange(this.editing)}`));
			output.push(...this.editor.render(Math.max(1, width)));
		}
		if (this.status) output.push(this.theme.fg("warning", truncateToWidth(this.status, width, "", false)));
		return output.map((line) => truncateToWidth(expandVisibleTabs(line), Math.max(1, width), "", false));
	}

	render(width: number): string[] {
		const maxRows = Math.max(1, Math.min(this.tui.terminal.rows, Math.floor(this.tui.terminal.rows * OVERLAY_HEIGHT_RATIO)));
		if (width < 3) return this.renderBody(Math.max(1, width)).slice(-maxRows);
		const innerWidth = width - 2;
		const border = (text: string) => this.theme.fg("border", text);
		const pad = (line: string) => {
			const fitted = truncateToWidth(line, innerWidth, "", false);
			return fitted + " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
		};
		const output = [
			border(`╭${"─".repeat(innerWidth)}╮`),
			...this.renderBody(innerWidth).map((line) => `${border("│")}${pad(line)}${border("│")}`),
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
		return output.length <= maxRows ? output : output.slice(-maxRows);
	}

	invalidate(): void {}
	dispose(): void {}
}

export function formatReviewFeedback(path: string, lines: string[], agentComments: AgentComment[], userComments: UserComment[]): string {
	const parentById = new Map(agentComments.map((comment) => [comment.id, comment]));
	const feedback = [...userComments].sort(commentSort).map((comment) => {
		const parent = comment.parentId ? parentById.get(comment.parentId) : undefined;
		const location = `Lines ${formatRange(comment)}`;
		const heading = parent ? `Reply to PI comment on ${location}` : `Annotation on ${location}`;
		const context = parent ? `\nPI comment: ${parent.text}` : `\nSource:\n${sourceExcerpt(lines, comment)}`;
		return `${heading}:${context}\nUser feedback: ${comment.text}`;
	});
	return [
		`Review feedback for ${path}`,
		"",
		feedback.length > 0 ? feedback.join("\n\n") : "No additional feedback.",
	].join("\n");
}

export async function loadSource(pathInput: string, cwd: string): Promise<{
	absolutePath: string;
	content: Buffer;
	text: string;
	lines: string[];
	highlightedLines: string[];
	hash: string;
}> {
	const input = normalizePathInput(pathInput);
	if (!input) throw new Error("path must not be empty");
	const absolutePath = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
	const metadata = await stat(absolutePath);
	if (!metadata.isFile()) throw new Error(`Path is not a regular file: ${pathInput}`);
	if (metadata.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} byte limit: ${pathInput}`);
	const content = await readFile(absolutePath);
	if (content.length > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} byte limit: ${pathInput}`);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		throw new Error(`File is not valid UTF-8 text: ${pathInput}`);
	}
	const controlBytes = [...content].filter(
		(byte) => (byte < 7 || (byte > 13 && byte < 32)) && byte !== 9,
	).length;
	if (content.includes(0) || (content.length > 0 && controlBytes / content.length > 0.01)) {
		throw new Error(`File appears to be binary: ${pathInput}`);
	}
	const lines = text.split("\n");
	const language = getLanguageFromPath(absolutePath);
	const highlightedLines = language ? highlightCode(text, language) : lines;
	return { absolutePath, content, text, lines, highlightedLines, hash: hashContent(content) };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "annotate_file",
		label: "Annotate file",
		description:
			"Open one read-only source file in a centered floating TUI overlay. Seed it with agent comments. On submit, stage the user's replies and annotations in Pi's composer for manual sending and end the active turn.",
		promptSnippet: "Open a file for user annotation and stage the review in the composer",
		promptGuidelines: [
			"Use annotate_file when you want the user to inspect and comment on a specific source file. The tool stages their review in the composer and ends your turn, so do not expect immediate feedback.",
		],
		parameters: annotateFileSchema,
		async execute(_toolCallId, params: AnnotateFileInput, signal?: AbortSignal, _onUpdate?, ctx?) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (!ctx || ctx.mode !== "tui") throw new Error("annotate_file requires Pi TUI mode");
			const source = await loadSource(params.path, ctx.cwd);
			const agentComments: AgentComment[] = params.comments.map((comment, index) => {
				validateRange(comment, source.lines.length, `Agent comment ${index + 1}`);
				if (!comment.text.trim()) throw new Error(`Agent comment ${index + 1} is empty`);
				return { ...comment, id: `agent-${index + 1}` };
			});
			if (signal?.aborted) throw new Error("Operation aborted");
			const result = await ctx.ui.custom<ReviewResult>((tui, theme, _keybindings, done) => {
				const component = new FileReviewComponent(
					tui,
					theme,
					source.absolutePath,
					source.lines,
					source.highlightedLines,
					agentComments,
					source.hash,
					() => readFile(source.absolutePath),
					done,
				);
				const abort = () => {
					if (!component.isCompleted()) done({ cancelled: true });
				};
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
				return {
					render: (width: number) => component.render(width),
					handleInput: (data: string) => component.handleInput(data),
					invalidate: () => component.invalidate(),
					dispose: () => signal?.removeEventListener("abort", abort),
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "94%",
					minWidth: 1,
					maxHeight: "96%",
					margin: 1,
				},
			},
			);
			if (result.cancelled === true) {
				ctx.abort();
				return {
					content: [{ type: "text", text: `Annotation cancelled for ${source.absolutePath}.` }],
					details: { path: source.absolutePath, cancelled: true },
				};
			}
			const reviewText = formatReviewFeedback(source.absolutePath, source.lines, agentComments, result.comments);
			ctx.ui.setEditorText(reviewText);
			ctx.abort();
			return {
				content: [{ type: "text", text: `Review staged in the composer for ${source.absolutePath}.` }],
				details: { path: source.absolutePath, staged: true, feedbackCount: result.comments.length },
			};
		},
	});
}
