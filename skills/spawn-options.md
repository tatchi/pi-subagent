# Spawn options

Optional `subagent spawn` flags that restrict what a subagent can do.

## Tools

`--tools` is a comma-separated allowlist across built-in, extension, and custom tools. Without it, the subagent gets Pi's defaults: `read`, `bash`, `edit`, and `write`. The built-in `grep`, `find`, and `ls` are available but off by default. `bash` can modify files, so any set that includes it is writable.

```sh
--tools read,grep,find,ls        # enforced read-only investigation
--tools read,bash,grep,find,ls   # investigation that runs tests or other commands
                                 # implementation: omit --tools
```

## Isolation

- `--no-extensions`: skip extension discovery, for an independent run that should not inherit unrelated extension behavior or extension tools. The subagent control bridge stays loaded.
- `--no-skills`: hide installed skills, for a tightly specified task that relies only on its prompt and files.
- `--no-context-files`: ignore repository instruction files such as `AGENTS.md` and `CLAUDE.md`, only when they would bias an independent investigation. Implementation work keeps them.
- `--no-prompt-templates`: disable prompt templates, for a minimal environment.
