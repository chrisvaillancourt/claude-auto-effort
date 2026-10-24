# auto-effort

A Claude Code mod (function-hook plugin) that picks the reasoning effort for each prompt. Before a turn starts, a cheap Haiku call rates how open-ended the request is, and the mod sends every request of that turn at the matching effort: a rename runs at `low`, an intermittent deadlock with no reproduction at `xhigh`. It is a port of the `auto` thinking level from [oh-my-pi](https://github.com/can1357/oh-my-pi).

**Its value is unmeasured.** Nobody has yet compared it against a fixed effort on the same model for solve rate, cost and latency. The decision log and `/auto-effort stats` exist so you can.

## Behavior

- **Main conversation only.** At the start of each main-loop turn, the mod decides one effort and applies it to every model request of that turn (the first one and each tool-loop step after it). The UI keeps showing the session's effort, so the mod shows its own choice in its status line under the prompt (for example `effort low · trivial`).
- **The judge.** One `$.model.complete` call to Haiku (`claude-haiku-5-5`, effort `low`, at most 16 output tokens) with a short rubric. It rates the request by how open-ended the problem is, not by its length or the amount of work:

  | Label | Means | Default effort |
  | --- | --- | --- |
  | `trivial` | One obvious solution, mechanically applied: the target, mapping or fix is given. | `low` |
  | `routine` | A few candidates in a localized area, or one small trap. | `medium` |
  | `involved` | Several viable designs or candidate causes. | `high` |
  | `open` | Open cause of flaky, concurrent or stale behavior; easy to get subtly wrong. | `xhigh` |

  The judge reads at most the first 4,000 characters of the prompt.
- **Clamped to the model.** The effort is lowered to the highest level the step's model supports (`xhigh` runs as `high` on Opus 4.6 and Sonnet 4.6). On a model the mod doesn't recognize, or one without effort, it changes nothing.
- **Fails open.** If the judge errors, answers something other than a label, or takes longer than `timeoutMs` (4 seconds by default), the turn runs at the session's own effort. A late answer is ignored. The turn waits at most `timeoutMs` before it starts.
- **Skipped prompts.** These are not judged; the turn reuses the effort of the last judged turn (or the session's effort if there is none):
  - an empty prompt (a continuation);
  - a prompt that still starts with `/` (a slash command; a skill whose text was expanded is judged like any prompt);
  - an acknowledgement on its own: `yes`, `y`, `ok`, `okay`, `sure`, `yep`, `yeah`, `go`, `go on`, `go ahead`, `continue`, `proceed`, `do it`, `please do`, `sounds good`, `lgtm`, `thanks`, `thank you`, case and punctuation ignored. Short prompts are not skipped for being short: `fix race` is judged.
- **`ultrathink`.** A prompt containing the word `ultrathink` skips the judge and runs at the model's top level (`max`) for that turn only. Claude Code's own `ultrathink` only adds an instruction and leaves the effort sent to the API unchanged; this mod also raises the effort.
- **Your own effort setting.** A hook can't tell whether the session's effort came from `/effort`, `--effort`, `effortLevel` or the model's default, so while the mod is on it overrides all of them. Use `/auto-effort off` to go back to the session's effort, or `/auto-effort pin <level>` to fix one. The exception is `CLAUDE_CODE_EFFORT_LEVEL`: when that variable is set, the mod changes nothing (it reports itself as deferring).
- **Subagents** keep their own effort. Set `subagentCap` to lower any subagent request above a level to that level; it never raises one.
- **Log.** Each main turn adds one JSON line to `<logDir>/<session id>.jsonl` (default `~/.claude/auto-effort/`): where the decision came from, the label, the effort requested and the session's effort, the model, the judge's latency and token usage, the turn's token usage and duration, and how the turn ended. No prompt text is logged. A failed write is reported once and never interrupts a turn.

## What it costs

- One Haiku request per judged turn: about 300 input tokens of rubric plus the prompt (capped at 4,000 characters, roughly 1,000 tokens), and a few output tokens. Skipped, pinned and `ultrathink` turns make no request. Classifications don't appear in Claude Code's session cost totals; the log records their usage.
- Up to `timeoutMs` of wait before each judged turn; the live probe measured about 0.5–1.5 s.
- Changing the effort between requests keeps the prompt cache on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 (per Claude Code's docs). On other models or providers an effort change may reread the cached prefix; the mod never changes the model, system prompt or tools.
- The effort itself: turns the judge rates `open` run at `xhigh`, which costs more than a session at `medium` or `high`. Lower the last entry of `efforts` to cap that.

## Command

`/auto-effort [status|on|off|pin <level>|unpin|stats]`

- `status` (or nothing): whether it is on, any pin, and the last decision.
- `on` / `off`: turn it on or off for this session. Off takes effect on the next request.
- `pin <level>`: send every main-loop request at `low`, `medium`, `high`, `xhigh` or `max` (clamped to the model), no judge. `unpin` goes back to judging.
- `stats`: a summary of this session's log and of all logged sessions: turns by source and effort, judge latency (median, p95), failures, judge tokens and turn tokens.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the mod on for new sessions. `/auto-effort on\|off` overrides it per session. |
| `efforts` | `low,medium,high,xhigh` | The efforts for `trivial,routine,involved,open`, in that order. Each is `low`, `medium`, `high`, `xhigh` or `max`. An invalid value falls back to the default (with a log line). |
| `judgeModel` | `claude-haiku-5-5` | The model that rates prompts (a full id). |
| `timeoutMs` | `4000` | How long a turn waits for the judge before it runs at the session's effort. |
| `subagentCap` | `off` | `off`, or a level: subagent requests above it are lowered to it. |
| `logDir` | `` (empty) | Where the per-session logs go; empty means `~/.claude/auto-effort`. |

## Limitations

- Its value is unmeasured (see above).
- The mod can't see where the session's effort came from, so it overrides an explicit `/effort` or `--effort` while it is on (see "Your own effort setting").
- The status line shows the mod's choice; Claude Code's own effort display still shows the session's effort.
- The turn waits for the judge (bounded by `timeoutMs`); a timed-out request is cancelled but may still be billed.
- Judging is per prompt with no conversation history, so "now do the same for the other file" is judged on those words alone.
- Not built: judging subagent prompts, model switching, a pane, explanations of the label, and omp's judge-role chain and caching.
- Unknown model ids (other providers' naming, new models) are left alone until the capability table knows them.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-auto-effort
claude plugin install auto-effort@auto-effort --scope user
```

Or from inside Claude Code: `/plugin install auto-effort --marketplace chrisvaillancourt/claude-auto-effort`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update auto-effort
claude plugin update auto-effort@auto-effort
```

Then restart Claude Code.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
