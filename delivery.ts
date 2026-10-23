import { statSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	assistantText,
	hasPendingInbox,
	isFailedResponse,
	type LatestAssistant,
	listRuns,
	markDelivered,
	readDeliveredEntryId,
	readLatestAssistant,
	type RunMetadata,
	runDisplayName,
} from "./shared.ts";

const SUBAGENT_RESULT_MESSAGE_TYPE = "subagent-result";
const COLLAPSED_RESPONSE_LINES = 4;
// The prompt only tells the parent what the response answers; spawn prompts can embed whole files.
const MAX_PROMPT_CHARS = 500;

interface SubagentResultDetails {
	handle: string;
	name?: string;
	prompt?: string;
	response: string;
	failed: boolean;
}

function xml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The run's latest final response, unless `wait` or a previous push already handed it to the parent. */
export function undeliveredResponse(run: RunMetadata): LatestAssistant | undefined {
	const latest = readLatestAssistant(run.sessionFile);
	return latest && latest.entryId !== readDeliveredEntryId(run.runDir) ? latest : undefined;
}

function resultContent(details: SubagentResultDetails): string {
	const attributes = [
		`handle="${xml(details.handle)}"`,
		details.name ? `name="${xml(details.name)}"` : undefined,
		`status="${details.failed ? "failed" : "finished"}"`,
	]
		.filter(Boolean)
		.join(" ");
	const prompt = details.prompt
		? details.prompt.length > MAX_PROMPT_CHARS
			? `${details.prompt.slice(0, MAX_PROMPT_CHARS)}…`
			: details.prompt
		: undefined;
	const lines = [`<subagent_result ${attributes}>`];
	if (prompt) lines.push(`<prompt>${xml(prompt)}</prompt>`);
	lines.push(`<response>${xml(details.response)}</response>`);
	// The parent may not have loaded the subagent skill, so each result carries its own reply path.
	lines.push(
		`<reply>Report this to the user. Relay any question or decision to them, then forward their answer by running this shell command with the bash tool: subagent send ${details.handle} "&lt;answer&gt;"</reply>`,
		"</subagent_result>",
	);
	return lines.join("\n");
}

/**
 * Returns a poller that injects each new final response of this session's push runs into the
 * conversation. While the parent is busy the message waits for the current run to finish
 * (`followUp`) instead of interrupting it; while idle it starts a turn.
 */
export function createResultPusher(pi: ExtensionAPI): (ctx: ExtensionContext) => void {
	// Skip re-reading a transcript until the run's metadata or session file changes.
	const lastChecked = new Map<string, string>();
	return (ctx) => {
		for (const run of listRuns(ctx.sessionManager.getSessionId())) {
			if (run.delivery !== "push" || !run.hasStarted || run.state !== "idle") continue;
			// Queued messages mean the child is about to start another turn.
			if (hasPendingInbox(run.runDir)) continue;
			let changeKey: string;
			try {
				changeKey = `${run.updatedAt}:${statSync(run.sessionFile).mtimeMs}`;
			} catch {
				continue;
			}
			if (lastChecked.get(run.handle) === changeKey) continue;
			lastChecked.set(run.handle, changeKey);

			const latest = undeliveredResponse(run);
			if (!latest) continue;
			markDelivered(run.runDir, latest.entryId);
			const details: SubagentResultDetails = {
				handle: run.handle,
				name: run.name,
				prompt: latest.prompt,
				response: assistantText(latest.message),
				failed: isFailedResponse(latest.message),
			};
			pi.sendMessage(
				{ customType: SUBAGENT_RESULT_MESSAGE_TYPE, content: resultContent(details), display: true, details },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
	};
}

function isResultDetails(value: unknown): value is SubagentResultDetails {
	if (typeof value !== "object" || value === null) return false;
	const details = value as Record<string, unknown>;
	return typeof details.handle === "string" && typeof details.response === "string";
}

export function registerResultRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(SUBAGENT_RESULT_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const details = message.details;
		if (!isResultDetails(details)) {
			box.addChild(new Text(typeof message.content === "string" ? message.content : "Subagent result", 0, 0));
			return box;
		}

		const label = runDisplayName(details);
		box.addChild(
			new Text(
				theme.fg(details.failed ? "error" : "success", `subagent ${label} · ${details.failed ? "failed" : "finished"}`),
				0,
				0,
			),
		);
		if (expanded && details.prompt) {
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("muted", "Prompt"), 0, 0));
			box.addChild(new Markdown(details.prompt, 0, 0, getMarkdownTheme()));
		}

		const lines = details.response.split("\n");
		const collapsed = !expanded && lines.length > COLLAPSED_RESPONSE_LINES;
		box.addChild(new Spacer(1));
		box.addChild(
			new Markdown(
				collapsed ? lines.slice(0, COLLAPSED_RESPONSE_LINES).join("\n") : details.response,
				0,
				0,
				getMarkdownTheme(),
			),
		);
		if (collapsed) box.addChild(new Text(theme.fg("dim", `… ${keyHint("app.tools.expand", "expand")}`), 0, 0));
		return box;
	});
}
