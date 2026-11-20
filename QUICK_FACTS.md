# Quick facts

| Item | Value |
| --- | --- |
| Extension | `thalovant.thalovant-skills` |
| Current version | `0.1.0` |
| Runtime entry | `dist/extension.js` |
| Release artifact | `thalovant-skills-<version>.vsix` attached to the GitHub release |
| Microsoft publishing | Locked `@vscode/vsce` 4.1.1, `--oidc --packagePath` |
| Workflow | `.github/workflows/publish.yml` |
| Verification | `tools/publish_release.py:verify_release`, `marketplace_matches` |
| Setup | [Publishing guide](docs/index.md) |
