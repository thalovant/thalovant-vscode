# Thalovant Skills maintenance

The extension's user guide is in the [README](../README.md). This page covers
publishing the existing GitHub release package to both extension registries.

## Publishing

`.github/workflows/publish.yml` runs when a GitHub release is published, or when a
maintainer dispatches it from `main` with a stable tag such as `v0.1.0`. It downloads
the release's VSIX; it does not rebuild the extension or increment its version.

Open VSX keeps its existing token/trusted-publisher behavior. Microsoft Marketplace
publishing waits for that job to pass and uses `@vscode/vsce` 4.1.1 with `--oidc`.
Create a Marketplace Trusted Publishing policy for:

| Field | Value |
| --- | --- |
| Publisher | `thalovant` |
| GitHub owner | `thalovant` |
| Repository | `thalovant-vscode` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty; this job does not use one |

No Microsoft publishing PAT is needed. Publisher/policy setup is an account action,
separate from merging the workflow. See Microsoft's [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing).

`tools/publish_release.py:verify_release` requires exactly one correctly named VSIX,
a stable published release, the GitHub asset SHA-256, and matching JSON/XML extension
identities. `marketplace_matches` accepts an existing version only when the public
VSIX has the exact same bytes. Only HTTP404 means missing; authorization failures,
rate limits, service errors and different bytes stop the job. It never overwrites
or silently skips a different existing release.

After publishing, the workflow waits up to six minutes for public download
availability. If Marketplace processing takes longer, rerun the workflow after
processing completes. The comparison will verify an already-published identical
package instead of publishing it again. A digest mismatch needs investigation;
do not remove the check or delete a published version to force the run through.

## Validation

- `python3 -m pytest -q test/python` includes release guard and runner tests.
- `python3 -m ruff check --line-length 110 python test/python tools/publish_release.py`
- `npm run typecheck`
- `npm run test:unit`
- `npm run package` checks packaging compatibility. This locally built test package
  is not the artifact used by the release publishing workflow.
