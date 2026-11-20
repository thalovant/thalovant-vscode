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
