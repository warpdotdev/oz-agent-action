# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Code Architecture

This repository contains a GitHub Action that runs the Oz Agent.

- **Type**: Node.js action (targeting `node24` runtime).
- **Entry Point**: `src/index.js`.
- **Distribution**: The code is bundled using Rollup into `dist/index.js`.
- **Logic**:
- 1.  Parses inputs from `action.yml`.
- 2.  Installs the `oz` package (supports Linux/Ubuntu via `.deb`).
- 3.  Executes `oz agent run` with the provided prompt/parameters.
- 4.  Sets the `agent_output` output.

## Development

- **Install Dependencies**: `npm install`
- **Build Action Bundle**: `npm run build`
  - This runs the `bundle` script, which formats the code and runs Rollup to produce
    `dist/index.js`.
  - **Important**: You must run the bundle command and commit the changes in `dist/` for them to
    take effect in the action.
- **Lint and Format**:
  - `npm run lint` to run ESLint over the repo.
  - `npm run format:check` / `npm run format:write` to check or apply Prettier formatting.
- **Generate Scenario Workflows**: `npm run build:workflows`
  - Reads the full example workflows in `examples/` and generates:
    - Scenario-specific reusable workflows in `.github/workflows/` (for `workflow_call`
      consumption).
    - Lightweight consumer templates in `consumer-workflows/` that call those reusable workflows.
  - Do **not** edit files under `.github/workflows/` or `consumer-workflows/` directly; edit the
    corresponding file in `examples/` and re-run `npm run build:workflows` instead.

## Testing

To test locally, use the `act` command:

```sh
act --container-architecture linux/amd64 -j run_oz_test -s OZ_API_KEY
```

This runs the e2e test workflow in `./.github/workflows/test_e2e.yaml`.
