# pi-extensions

Personal pi extensions. Each extension lives in `extensions/<name>/index.ts` and is discovered through the `pi.extensions` glob in `package.json`.

`command-guard` is structured as `shell.ts` (parser) → `rules/<tool>.ts` (one pure classifier per tool, each with `<tool>.test.ts`) → `policy.ts` (segment walk + aggregation) → `index.ts` (hooks, prompt, `/command-guard`). `env.ts` owns the identity layer. Add a tool by adding a rule file, wiring it in `policy.ts` and writing its test table.

`subagent` is `rules.ts` (defaults, worker prompt, args, JSON event folding, summaries) → `runner.ts` (spawns a JSONL child, no pi imports) → `index.ts` (tool schema, fan-out, rendering). Workers must stay full `pi` processes so they inherit every extension; never add `--no-extensions` or a `--tools` allowlist.

## Conventions

- Keep decision logic in pure modules (`rules.ts`) with no pi imports so it is unit-testable; `index.ts` only wires hooks, UI and commands.
- Every extension ships `*.test.ts` next to its sources, run with `npm test` (node test runner + tsx).
- `npm run lint` (biome) and `npm run typecheck` (tsgo) must pass before committing. CI runs all three.
- Prefer false positives over false negatives in guards: a spurious prompt is cheap, a silent mutation is not.
- Import local files with explicit `.ts` extensions.
