# Herdr subagent panes

This OpenCode V2 CLI plugin opens Herdr panes for child sessions and reports their
state in the Herdr agent sidebar. By default, each pane runs:

```sh
opencode2 mini --session <session-id>
```

To use a launcher, set `commandPrefix` in the plugin options below.
There is no built-in prefix. The plugin resolves a configured prefix executable
once during setup and quotes each argument before adding it to the Mini command.

The global CLI configuration can load this directory directly. No source copy
or separate plugin config file is required.

## Supported use

- The parent uses the full OpenCode V2 TUI and the local shared OpenCode service.
- The TUI runs in a Herdr pane on macOS or Linux.
- `herdr` and `ps` are available on `PATH` in the parent environment.
- If configured, the prefix executable is available on `PATH` in the parent
  environment. Without a prefix, `opencode2` must be available in the child shell.
- Herdr supports the 0.9 pane response format, including terminal IDs.
  Sidebar naming requires `pane report-metadata` with `--clear-title` support.

The plugin stays inactive outside Herdr and in generated child panes. If Herdr
variables are present, it checks that the specified pane's shell is an ancestor
of the TUI process before it enables pane operations. A stale environment cannot
select an unrelated parent pane through this check.

### Private or explicit servers

The plugin refuses launches with `--standalone` or `--server`, including the
`--server=URL` form. It shows one warning and registers no event handlers.

The V2 plugin context does not expose the connected endpoint and credentials.
Starting Mini without them could attach to the wrong server. This restriction is
intentional; private and remote server support has not been added. It does not
change or stop the parent session. The guard applies to normal CLI launches, not
custom hosts that hide their connection arguments.

## Pane lifecycle

- Only children of the current session or enabled session tabs are selected.
  Nested child sessions are included through OpenCode's session-family lookup.
- Each new pane uses the child session's current directory from OpenCode's cache.
  Missing data is synchronized. If the directory remains unknown, no pane opens.
- The first worker opens to the right of the verified primary pane. The primary
  keeps 60% of its current width by default; the worker column uses the other 40%.
  Later workers open below the bottom worker in that column. Splits do not take focus.
- Worker heights are balanced after creation and closure. The primary width is
  not changed by later workers. When all workers close, Herdr restores the area
  to the primary pane.
- Before a split or height change, the plugin checks the parent process, each
  worker's terminal identity, and the current layout. A moved or replaced worker,
  or an unrelated pane inserted into the worker column, prevents layout changes.
  Panes outside the primary-and-worker area are left unchanged.
- One queue serializes layout and state-report commands. One map tracks child
  panes and pending close requests. Idle state alone does not close a pane.
- Success closes a pane after the configured delay. Failure keeps it for at least
  five seconds. Interruption and session deletion request immediate closure.
- A restart cancels a pending close. If closure is already in progress, a new pane
  can open after it completes. A reused child session can also open a new pane.
- Duplicate creation events do not open another tracked pane or cancel its close.
- Panes waiting to close still count against the limit. At the limit, the new pane
  is skipped; the subagent itself continues. A later execution can try again.
- A failed close retains its tracking record. There are at most three close
  attempts, one second apart. Unload makes one final attempt and logs any pane
  that still requires manual closure.
- Before closure, the plugin checks the terminal ID. A missing pane is already
  closed. A pane ID that now belongs to another terminal is left unchanged.
- An unknown split result stops further pane creation for that plugin instance.
  Inspect Herdr before reloading: a split can succeed even if its response is lost.

The plugin does not submit prompts or call session interruption APIs. Mini is
interactive, not a read-only viewer. Do not type into it unless you intend to
interact with that child session.

### Stop or cancel a worker

Stopping a subagent from the main TUI or its Mini worker pane produces the shared
`session.execution.interrupted` event. The plugin closes only the worker pane
for that session, without the normal completion delay. Other workers and the
main pane stay open. The remaining worker heights are balanced after closure.

A stop also replaces a pending success or failure delay. If it arrives during
pane creation, the plugin closes the new pane and does not launch Mini afterward.
An in-flight launch or report must finish before the queued close can run.
Terminal identity checks and bounded close retries still apply.

If OpenCode starts a new execution for the same session before closure, the
plugin cancels the pending close. If closure is already in flight, it opens a
replacement pane. Cancelling a form alone is not a session stop and does not
close the worker. Stopping the main session does not close workers that OpenCode
has not interrupted.

### Pane layout

```text
┌──────────────────┬────────────┐
│                  │  Worker 1  │
│                  ├────────────┤
│     Primary      │  Worker 2  │
│                  ├────────────┤
│                  │  Worker 3  │
└──────────────────┴────────────┘
        60%             40%
```

Workers stay in creation order from top to bottom. A restarted worker whose pane
has already closed is added at the bottom. Existing panes are not moved or
recreated to balance their heights.

Heights can differ by a terminal row because of rounding. Very small terminals
or more than ten workers can also reach Herdr's split-size limits. A failed
resize leaves the workers running; the next creation or closure tries again.
The default limit remains six workers.

`layout.js` uses Herdr's socket API to inspect the split tree and set worker
height ratios. It does not apply a replacement layout or create a new tab.

## Agent sidebar status

The parent TUI reports directly to Herdr for each pane that this plugin creates.
It uses the native child session ID and the returned pane ID. Mini does not need
to load a reporting plugin. There is no child launch wrapper.

| OpenCode state or event | Herdr state |
| --- | --- |
| Created session | Cached execution state, or `idle` until execution starts |
| Execution started | `working` |
| Pending permission or form | `blocked` |
| All pending requests resolved or cancelled | Current execution state |
| Execution succeeded | `idle`, then the pane closes after its delay |
| Execution interrupted | `idle`, then the pane closes without the completion delay |
| Execution failed | `blocked`, then the pane closes after its error delay |

- Multiple requests are tracked separately. Resolving one does not clear another.
- Pending requests are read after launch. Event changes are kept until the cache
  agrees, so a late cache update cannot immediately undo a request or reply.
- Reports are sent in order with increasing sequence numbers. Failed reports retry
  after 500 ms while the child is tracked. Closure and unload stop the retries.
- The plugin checks terminal identity before a state report or release. It releases
  only its own reporting source before closing a pane.
- Generated panes receive `HERDR_AGENT=opencode` and
  `OPENCODE_HERDR_SUBAGENT_PANE=1`. The latter prevents recursive pane creation.

The primary Herdr OpenCode V2 integration owns primary lifecycle reports and
session identity. This plugin adds only primary display metadata. Do not run the
old child-state wrapper at the same time.

### Sidebar names and space title

Child sidebar entries use `Subagent - <OpenCode agent name>`, for example
`Subagent - explorer`. Child task and session titles are not used. The child pane
label uses the same name. Child metadata uses `herdr:opencode-subagent-metadata`
and applies only to `herdr:opencode-subagent-panes`.

The main sidebar entry uses `Agent - <root OpenCode session title>`. Its metadata
uses `herdr:opencode-primary-metadata` and applies only to the `opencode:tui`
source. Primary labels require the primary integration to use that source. This
plugin does not install or change the primary integration. If the source does not
match, Herdr does not apply this metadata.

Both metadata reporters clear the separate title field to remove old task titles
and prevent duplicate titles. Each metadata source has its own sequence. The
lifecycle agent remains `opencode`; status, native session IDs, and closure rules
do not change.

The Herdr space name uses the full selected root session title, without a prefix
or length limit. Selecting a child uses its root title for both the space and the
main sidebar entry. The plugin reads the workspace ID from the verified parent
pane; it never selects the focused workspace. Empty or unavailable titles leave
the existing name unchanged. Tabs are not renamed. Sidebar and child pane labels
are limited to 80 Unicode code points, including the prefix. Emoji are not split.
Control characters are replaced with spaces, and outer spaces are removed.

The plugin checks the route and cache every 100 ms. It checks the parent shell
and terminal before primary naming, and the worker terminal before child
metadata. Child metadata follows the initial lifecycle report and is sent once
more at startup. Primary metadata is also sent once more after root selection,
in case the primary lifecycle source was not ready for the first report.
After these startup checks, unchanged names cause no Herdr commands. Session
update events take priority until the cache agrees.

Space naming and primary metadata have separate retry and duplicate checks.
Naming failures do not close workers. Failed names have at most three attempts;
metadata retries wait 500 ms and space-title retries wait one second. Unload
clears the naming timers and event handlers.

No new options are required. After existing workers finish, close and reopen the
full OpenCode TUI inside Herdr to load the changed plugin. Do not restart Herdr or
the OpenCode service for this change. The exact prefixed labels have automated
test coverage only; this revision has not been checked in a live Herdr session.

Each TUI instance manages its own panes. Two full TUIs with the same session in
their tabs can each open a pane for the same child. Cross-client pane selection is
not implemented; keep only one such TUI open if you want one pane per child.

## Options

Set options in the global `~/.config/opencode/cli.json`, not `opencode.json`.
For a checkout at `./plugins/herdr-subagent-panes`, use:

```json
{
  "plugins": [
    {
      "package": "./plugins/herdr-subagent-panes",
      "options": {
        "mainPaneWidthPercent": 60
      }
    }
  ]
}
```

Keep other plugins and settings when changing this entry. Remove `commandPrefix`
or set it to `[]` to launch Mini directly. Use one array item per argument, such
as `["wrapper", "--flag"]`; do not supply a shell command string. The first item
must name an executable, not a shell alias or function. Shell operators and
variable expansion are not interpreted in prefix arguments.

This option does not wait for dev-shell startup or Mini readiness. The plugin
sends one command through Herdr's `pane run` after pane creation. The close delay
starts when the child execution finishes, not when Mini becomes visible.

| Option | Default | Accepted values |
| --- | --- | --- |
| `commandPrefix` | `[]` | Executable and arguments as an array of nonempty strings, with no NUL or line breaks |
| `mainPaneWidthPercent` | `60` | Integer percentage from `10` to `90` |
| `maxPanes` | `6` | Integer from `1` to `20` |
| `autoCloseDelayMs` | `2000` | Integer from `0` to `60000` |

Invalid numeric values use the defaults. An invalid prefix or an unavailable
prefix executable disables the plugin with a warning; it does not fall back to
an unprefixed command. Limits apply to panes tracked by one plugin instance,
not all Herdr panes or all OpenCode clients.

`mainPaneWidthPercent` sets the main pane's share when the first worker opens.
The worker column uses `100 - mainPaneWidthPercent`; no separate worker-width
setting is needed. For example, `70` gives the main pane 70% and each stacked
worker 30% of the original width. Omitting the option uses 60%, not 50%.

The option is read during plugin setup. A changed value applies when the plugin
loads the new options and creates a new worker column. It does not resize an
existing column. Later workers change only the worker heights.

## Tests

Use Node.js 22 or later. No package installation is required:

```sh
node --experimental-vm-modules --test test/*.test.js
```

The tests load the actual plugin source in isolated VM contexts. Herdr commands,
OpenCode data, process information, and timers are replaced with test objects.
The tests cannot create real panes or load the plugin into your current OpenCode.
Node can print an experimental-VM warning; that warning is expected.

Coverage includes inactive setup, stale environments, server restrictions, child
directories, duplicate events, pane limits, resumed executions, close failures,
terminal replacement, and completion or unload during a split. State tests cover
three independent children, pending permissions and forms, late cache updates,
failed reports, and events received during launch or an in-flight report.

Naming tests cover exact child and primary labels, full space titles, Unicode
limits, root selection, delayed titles, nested sessions, stale caches, independent
bounded retries, replaced terminals, changes during pending commands, and cleanup.
All naming commands use fake Herdr responses.

Layout tests cover a default 60%-width primary, custom widths and invalid options,
three and six equal-height workers, closure at each position, replacement workers, concurrent creation,
manual closure, unrelated panes, moved terminals, invalid responses, and timeouts.

Stop tests cover immediate closure, matching session IDs, main-session changes,
stale pending requests, stops during creation and launch, replaced terminals,
duplicate events, close retries, and restart during closure. These are automated
event tests; they do not send keyboard input to the main TUI or Mini.

The automated suite does not check the visible sidebar in a real Herdr session.
A separate layout test uses real Herdr panes and Mini with empty OpenCode
sessions and simulated lifecycle events. It makes no model calls. To run it,
use only a disposable Herdr shell pane, from this repository directory:

```sh
node test/live-layout.mjs --disposable-pane
```

## API references

- [OpenCode V2 CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli)
- [OpenCode V2 client](https://opencode.ai/v2/docs/build/client)
- [Herdr 0.9 socket API](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.0/docs/next/website/src/content/docs/socket-api.mdx)
- [Herdr 0.9 CLI output](https://github.com/herdrdev/herdr/blob/v0.9.0/src/cli.rs)

Herdr's inspect and layout commands print one JSON document. `pane run` is silent
on success. API errors are JSON on standard error with a nonzero exit status.
The plugin parses that documented format instead of searching output lines for
an arbitrary JSON value.
