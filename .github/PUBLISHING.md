# Publishing

## Prerequisites

1. A Visual Studio Marketplace publisher whose ID exactly matches `publisher` in `package.json`.
2. An Azure DevOps personal access token with **Marketplace → Manage** scope.
3. Node.js 20 or later and Python 3.9 or later.

GitHub credentials cannot publish a VS Code Marketplace extension. Never place either credential in this repository, a command-line argument, an npm script, or a remote URL.

## Release checklist

```bash
npm ci
npm --prefix webview-ui ci
npm run check
npm run vscode:prepublish
npm run package
```

Before publishing:

- Confirm the publisher ID and version in `package.json`.
- Inspect the VSIX file list and run the repository secret scan.
- Install the generated VSIX in a clean Extension Development Host.
- Verify hook installation with both existing third-party hooks and empty settings files.
- Verify concurrent Copilot/Claude main agents and subagents.
- Update `CHANGELOG.md` using an exact release date.

## Publish

Run `npm run publish` and enter the Marketplace token only in the interactive prompt. Do not save the token in shell history or an environment file inside the repository.
