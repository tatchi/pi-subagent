---
name: subagent
description: Run Pi subagents in herdr tabs with the `subagent` bash command. Use whenever the user asks for a subagent, and for delegated implementation, independent reviews or second opinions, and parallel investigations.
---

# Subagent

The `subagent` shell command runs a task in a separate Pi process with its own context, in a new `sa:<name>` tab of the current herdr workspace. Subagents cannot spawn subagents.

## Spawn

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

- Give each subagent a short, descriptive `--name`; it labels the tab and the status widget. Keep the printed handle: every other command takes it.
- Repeat `--prompt` and `--file` as needed; the subagent receives all of them in its first turn. `--cwd` defaults to the current directory.
- The subagent inherits this session's provider, model, and thinking level. Pass `--provider`, `--model`, or `--thinking` only to choose a different configuration deliberately, such as a faster model for a simple lookup or a stronger one for a hard review. Write literal values; never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back.
- For a read-only investigation or an independent run, choose `--tools` and isolation flags from [spawn-options.md](../../spawn-options.md).

Run every `subagent` command with the bash tool, unpiped, so its output returns in the tool result. It is unrelated to any `subagent` tool another extension may provide.

## Wait for the result

```sh
subagent wait <handle>
```

`wait` blocks until the subagent is idle and prints its final response. Set the bash timeout above `wait`'s 1800-second default. The output of `wait` is the result; the text in the subagent's tab is not a completion signal.

Report the result to the user, attributed to the subagent's name. If it asks a question or needs a decision, relay it to the user and forward their answer with `subagent send`; the subagent decides with its own context.

## Follow up

```sh
subagent send <handle> "message"              # idle: starts a new turn; busy: steers the current one
subagent send <handle> --follow-up "message"  # busy: runs after the current turn
subagent rename <handle> "new name"
subagent status <handle>
subagent list                                 # rediscover handles, names, and states
```

The subagent keeps its full context between turns; after `send`, run `wait` again for its reply. Messages go through `send`, which reaches the subagent's control inbox.

## Lifetime

Subagents keep running until the user closes their tab: finishing a turn, `/reload`, and quitting this session all leave them alive. Leave finished subagents running for the user to close. Run `subagent stop <handle>` only when the user asks; it closes the tab and deletes the subagent's transcript.
