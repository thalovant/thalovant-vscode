# Maintainer questions

**Does a publishing run rebuild the VSIX?** No. Both registries receive the existing
GitHub release package. `npm run package` in CI tests packaging but is not uploaded.

**Does Microsoft publishing need VSCE_PAT?** No. The Marketplace publisher must have
a Trusted Publishing policy for this repository and `publish.yml`; the job requests
a short-lived credential with `vsce --oidc`.

**What happens on a rerun?** A public version with matching bytes is verified and
skipped. A mismatched version or service/authentication error fails closed.

**Can I dispatch from a feature branch?** The Microsoft job runs only from `main`
or a published release event in `thalovant/thalovant-vscode`.
