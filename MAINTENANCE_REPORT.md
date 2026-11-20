# Maintenance report

## 2026-11-20 — Microsoft Marketplace publishing

Added a Marketplace job after successful Open VSX publication, using the existing
release VSIX and short-lived OIDC authentication. Pinned the official publishing
CLI to 4.1.1 because the previous locked 3.9.2 does not support `--oidc`.

The release guard checks stable release/tag, exact asset count/name, GitHub SHA-256,
and both package.json and extension.vsixmanifest identities. Marketplace comparison
fails for mismatches and errors; identical public versions are safe to rerun.

Validation: 33 Python tests passed (27 release checks, 6 runner tests); ruff passed;
TypeScript type checking and both JavaScript unit-test files passed; local packaging
completed with 22 files. The original v0.1.0 release was independently validated
against its GitHub asset digest and identities. No application behavior changed.

### Transparency report

Codex (GPT-6) prepared the workflow, guard, tests and maintenance documentation.
Automated tests and local package validation were run. The user authorized the
Marketplace setup; production publisher configuration and publication are separate
steps and are not asserted complete by this source change.

## 2026-11-20 — Marketplace installation instructions

The first OIDC publication completed in [run 44737067684](https://github.com/thalovant/thalovant-vscode/actions/runs/44737067684).
The public Microsoft Marketplace package was independently downloaded and matched
the existing v0.1.0 GitHub release: 127,103 bytes, SHA-256
`38ead653ded9e88447b11a0c285750367cc1c9ace34c34aabc57472635b08fbc`.

The README now offers the Microsoft Marketplace listing and VS Code installation
command, retaining Open VSX and manual VSIX installation. No release artifact was
rebuilt or replaced. Validation: public package identity/digest and `git diff --check`.
Codex (GPT-6) prepared the documentation; the user authorized publication and the
publisher policy, and the completed run supplies the publication evidence.
