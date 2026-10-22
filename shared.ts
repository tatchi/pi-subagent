import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 2;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/**
	 * Herdr terminal hosting the child, set on every launch. Unlike pane IDs, terminal IDs survive
	 * `herdr pane move`, so the current pane and tab are always resolved from it.
	 */
	herdrTerminalId?: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 2 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			(metadata.herdrTerminalId !== undefined && typeof metadata.herdrTerminalId !== "string") ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 2,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function insideHerdr(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_WORKSPACE_ID;
}

function herdr(args: string[]): Record<string, unknown> {
	const result = spawnSync("herdr", args, { encoding: "utf8" });
	if (result.error) throw new Error(`Could not run herdr: ${result.error.message}`);
	if (result.status !== 0) {
		let message = result.stderr.trim();
		try {
			message = JSON.parse(message).error.message ?? message;
		} catch {
			// Not a JSON error; keep stderr as is.
		}
		throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${message || `exit ${result.status}`}`);
	}
	// Some commands, such as `pane run`, print nothing on success.
	return result.stdout.trim() ? JSON.parse(result.stdout).result : {};
}

export interface RunPane {
	paneId: string;
	tabId: string;
}

/**
 * Resolve the pane currently hosting a run, or undefined when it is gone. Herdr closes the pane once
 * the exec'd pi process exits, so a live pane means a live child. Throws when herdr is unreachable,
 * because "unknown" must not be mistaken for "exited".
 */
export function findRunPane(metadata: RunMetadata): RunPane | undefined {
	if (!metadata.herdrTerminalId) return undefined;
	const { panes } = herdr(["pane", "list"]) as { panes: { pane_id: string; tab_id: string; terminal_id: string }[] };
	const pane = panes.find((candidate) => candidate.terminal_id === metadata.herdrTerminalId);
	return pane && { paneId: pane.pane_id, tabId: pane.tab_id };
}

export function closeRunPane(paneId: string): void {
	try {
		herdr(["pane", "close", paneId]);
	} catch {
		// Already gone.
	}
}

export function focusRunTab(pane: RunPane): void {
	herdr(["tab", "focus", pane.tabId]);
}

export function runTabLabel(metadata: RunMetadata): string {
	return `sa:${metadata.name ?? metadata.handle}`;
}

export function renameRunTab(metadata: RunMetadata): void {
	try {
		const pane = findRunPane(metadata);
		if (pane) herdr(["tab", "rename", pane.tabId, runTabLabel(metadata)]);
	} catch {
		// The label is cosmetic; the run itself is unaffected.
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Start the child pi process for a run in a new tab of the caller's herdr workspace, without taking
 * focus. `initialArgs` are only passed on first spawn.
 */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): RunMetadata {
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	if (!insideHerdr() || !workspaceId) throw new Error("Subagents require running inside a herdr pane");

	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}

	// The pane starts the user's interactive shell (fish, zsh, ...), whose quoting rules differ. Keep
	// the command in a POSIX script so the only text typed into the shell is a plain exec of its path.
	const script = join(metadata.runDir, "launch.sh");
	if (/['\\\n]/.test(script)) throw new Error(`Unsupported characters in run directory: ${metadata.runDir}`);
	const command = [
		"env",
		`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
		launcher,
		"--session",
		metadata.sessionFile,
		"--provider",
		metadata.provider,
		"--model",
		metadata.model,
		"--thinking",
		metadata.thinking,
		...(metadata.launchArgs ?? []),
		...initialArgs,
	];
	writeFileSync(script, `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")}\n`, { encoding: "utf8", mode: 0o700 });

	const { root_pane: pane } = herdr([
		"tab",
		"create",
		"--workspace",
		workspaceId,
		"--cwd",
		metadata.cwd,
		"--label",
		runTabLabel(metadata),
		"--no-focus",
	]) as { root_pane: { pane_id: string; terminal_id: string } };
	// Record the terminal before pi starts so the child's own metadata updates cannot race this write.
	const launched = updateMetadata(metadata.runDir, { herdrTerminalId: pane.terminal_id }) ?? metadata;
	try {
		// `exec` replaces the shell, so herdr closes the pane (and the tab) when pi exits.
		herdr(["pane", "run", pane.pane_id, `exec '${script}'`]);
	} catch (error) {
		closeRunPane(pane.pane_id);
		throw error;
	}
	return launched;
}

/** Like findRunPane, but treats an unreachable herdr as "still running" for best-effort display. */
export function runIsAlive(metadata: RunMetadata): boolean {
	try {
		return findRunPane(metadata) !== undefined;
	} catch {
		return true;
	}
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!runIsAlive(metadata)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
