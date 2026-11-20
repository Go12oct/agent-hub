# Windows code signing

Agent Hub uses optional free [SignPath Foundation](https://signpath.org/) signing.
The certificate publisher is **SignPath Foundation**. Every release needs manual
approval. Until onboarding is complete, releases remain unsigned with a warning.

## Setup

1. Review the [Foundation conditions](https://signpath.org/terms) and apply via
   [OSS support](https://about.signpath.io/product/open-source). Explain the Node
   SEA packaging and obtain approval: replacing Node's version metadata does not
   itself satisfy the prohibition on signing upstream binaries. Acceptance is
   discretionary; do not enable signing until this is resolved with SignPath.
2. Create a project linked to `Go12oct/agent-hub`, configure GitHub.com as its
   trusted build system, and install the SignPath GitHub App as instructed in the
   [integration guide](https://docs.signpath.io/trusted-build-systems/github).
   All jobs leading to signing must use GitHub-hosted runners.
3. Create an artifact configuration with a ZIP root containing `agent-hub.exe`.
   `actions/upload-artifact@v4` archives the single EXE at the root. Configure
   Authenticode signing with a timestamp, enforce ProductName **Agent Hub**, and
   require the release version from root `package.json`. The SEA builder sets
   the application's version resources before injecting its code.
4. Create a release signing policy with the Foundation certificate, restrict
   permitted release refs/build origins, and require manual approval by Go12oct.
   Enable MFA for GitHub and SignPath. Give the token's user submitter access,
   not permission to bypass approval.
5. Under repository **Settings > Secrets and variables > Actions**, add secret
   `SIGNPATH_API_TOKEN` and variables `SIGNPATH_ORGANIZATION_ID`,
   `SIGNPATH_PROJECT_SLUG`, and `SIGNPATH_SIGNING_POLICY_SLUG`. Optionally add
   `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`; otherwise the project default is used.
   Never commit or log the API token.
6. Push a version tag (`v*`) whose commit is on `main`. Open the signing request
   linked in workflow output and approve it in SignPath within two hours. Link
   the README's [Code signing policy](../README.md#code-signing-policy) from
   release/download pages, as required by the Foundation.

The release job uploads the unsigned executable, waits up to 7,200 seconds for
signing, and extracts the returned archive into a separate directory. It requires
exactly one `agent-hub.exe` (including nested paths), copies it into `daemon/dist`,
and requires a `Valid` Authenticode signature and timestamp before ZIP assembly.
`actions: read` lets the connector inspect artifacts; `contents: write` permits
release uploads. The action is pinned to a reviewed v3.2 commit.

Missing EXE, token, or required variables produces a warning and preserves the
existing unsigned-release behavior. Configured signing failures, approval
timeouts, missing outputs, or invalid signatures fail the Windows job instead
of publishing an unsigned substitute. Scripts and the release ZIP are not signed
by this step.

Signing establishes publisher identity and integrity, but SmartScreen reputation
still builds over time. Initial “Windows protected your PC” warnings may remain.
[Microsoft says](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
the immediate EV SmartScreen bypass was removed in 2024.
