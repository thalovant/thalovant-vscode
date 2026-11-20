# Audit notes

## 2026-11-20

- `tools/publish_release.py:verify_release` fails on an altered release asset,
  inconsistent manifests or ambiguous VSIX assets. Regression coverage is in
  `test/python/test_publish_release.py`.
- `tools/publish_release.py:marketplace_matches` treats only HTTP404 as absent.
  Authentication, throttling, server failures and differing existing bytes fail.
- `.github/workflows/publish.yml` pins actions to commits, installs dependencies
  without scripts and uses `--oidc` rather than storing Microsoft credentials.
- Microsoft may take longer than the bounded public-download verification window;
  a rerun verifies the existing version. A failed verification must not be reported
  as a confirmed public listing.
- `npm audit` reports four moderate development-tool entries: `esbuild`,
  `minimatch`, `@vscode/vsce` and `ovsx`; no high or critical advisories were
  reported. These publishing/build tools are not bundled into the extension.
  The official latest stable vsce is pinned rather than applying a forced downgrade.
- Marketplace downloads may use HTTP gzip content encoding. The verifier hashes
  the decoded VSIX bytes and rejects unsupported encodings; regression tests cover
  this transport distinction.
