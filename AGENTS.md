# pi-extensions

Personal pi extensions. Each extension lives in `extensions/<name>/index.ts` and is discovered through the `pi.extensions` glob in `package.json`.

## Conventions

- Keep decision logic in pure modules (`rules.ts`) with no pi imports so it is unit-testable; `index.ts` only wires hooks, UI and commands.
- Every extension ships `*.test.ts` next to its sources, run with `npm test` (node test runner + tsx).
- `npm run lint` (biome) and `npm run typecheck` (tsgo) must pass before committing. CI runs all three.
- Prefer false positives over false negatives in guards: a spurious prompt is cheap, a silent mutation is not.
- Import local files with explicit `.ts` extensions.
