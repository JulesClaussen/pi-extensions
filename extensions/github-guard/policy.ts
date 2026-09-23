/**
 * Turns a bash `tool_call` event into a guard decision. Kept out of index.ts
 * so it can be unit tested with a fabricated event and branch resolver.
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { checkCommand, type Decision, type RuleContext } from "./rules.ts";

export async function evaluateBashCall(event: ToolCallEvent, ctx: RuleContext): Promise<Decision | undefined> {
	if (!isToolCallEventType("bash", event)) return undefined;
	const command = event.input.command;
	if (typeof command !== "string") return undefined;
	return checkCommand(command, ctx);
}

export function describeDecision(decision: Decision): string {
	return decision.findings.map((finding) => `${finding.reason} (${finding.fragment})`).join("; ");
}
