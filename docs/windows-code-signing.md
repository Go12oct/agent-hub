# Windows code signing

For an individual developer based in the UAE, the recommended paid option is an
[SSL.com Individual Validation (IV) code signing certificate](https://www.ssl.com/products/software-integrity/signing-service/)
($129/year) plus [eSigner cloud signing](https://www.ssl.com/guide/esigner-pricing-for-code-signing/)
($180/year for 240 signatures), approximately **$309/year** before taxes or extras.
Confirm current prices and UAE identity-validation support with SSL.com before
purchasing. IV does not require forming a company.

## Set up release signing

1. Buy the IV certificate and eSigner cloud signing plan, and complete SSL.com's
   identity validation.
2. Enroll the certificate in eSigner and follow SSL.com's
   [automated signing setup](https://www.ssl.com/how-to/automate-esigner-ev-code-signing)
   to obtain the signing credential ID and TOTP secret. Treat the TOTP secret as
   a signing credential, not as a disposable one-time code.
3. In the repository's **Settings > Secrets and variables > Actions**, add:
   `ES_USERNAME`, `ES_PASSWORD`, `ES_CREDENTIAL_ID`, and `ES_TOTP_SECRET`.
   Never commit these values or print them in logs.
4. Cut a release by pushing a version tag (`v*`) whose commit is on `main`.
   The release workflow uses the official
   [SSLcom/esigner-codesign action](https://github.com/SSLcom/esigner-codesign)
   with `command: sign`, which signs and timestamps the final Node SEA executable
   in place, after SEA injection and before ZIP assembly.
5. Check the release workflow: signature verification must report `Valid`, with
   a timestamp present, before packaging and uploading the executable.

If any signing secret or the executable is missing, the workflow warns and keeps
the existing unsigned-release behavior. If configured signing or verification
fails, the Windows job fails rather than publishing an unsigned substitute.
Only `agent-hub.exe` is signed; the `.ps1`/`.cmd` scripts and ZIP are not signed
by this step.

Signing establishes publisher identity and integrity, but **SmartScreen reputation
still builds over time**. New signed releases can still show “Windows protected
your PC.” Microsoft says the immediate EV SmartScreen bypass was removed in
2024, so do not buy EV solely to avoid that prompt. See
[Microsoft's signing comparison](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

## Alternatives

- [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
  accepts individual developers only in the US and Canada, not the UAE.
- [Certum OSS cloud signing](https://shop.certum.eu/open-source-code-signing-on-simplysign.html)
  is listed at €49, but relies on SimplySign mobile access codes and a desktop
  application. Fully unattended GitHub Actions signing is not officially
  documented; do not assume it is CI-automatable. See the
  [official application requirements](https://support.certum.eu/en/installation-of-the-simplysign-applications/).
- [SignPath Foundation](https://signpath.org/) is a free alternative for accepted
  OSS projects. The publisher shown is **SignPath Foundation**, and every release
  requires manual approval by an authorized project member. Review its
  [eligibility and signing policy](https://signpath.org/terms) before applying;
  an MIT license alone does not guarantee acceptance.
