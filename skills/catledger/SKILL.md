---
name: catledger
description: Use CatLedger API Tools script to record new transactions, query transactions, retrieve account information, retrieve categories, retrieve tags, and retrieve exchange rate data in the self hosted personal finance application CatLedger.
---

# CatLedger API Tools

## Usage

### List all supported commands

Linux / macOS

```bash
sh scripts/catledger-tools.sh list
```

Windows

```powershell
scripts\catledger-tools.ps1 list
```

### Show help for a specific command

Linux / macOS

```bash
sh scripts/catledger-tools.sh help <command>
```

Windows

```powershell
scripts\catledger-tools.ps1 help <command>
```

### Call API

Linux / macOS

```bash
sh scripts/catledger-tools.sh [global-options] <command> [command-options]
```

Windows

```powershell
scripts\catledger-tools.ps1 [global-options] <command> [command-options]
```

## Troubleshooting

If the script reports that the environment variable `CATLEDGER_TOOL_SERVER_BASEURL` or `CATLEDGER_TOOL_TOKEN` is not set, user can define them as system environment variables, or create a `.env` file in the user home directory that contains these two variables and place it there.

The meanings of these environment variables are as follows:

| Variable | Required | Description |
| --- | --- | --- |
| `CATLEDGER_TOOL_SERVER_BASEURL` | Required | CatLedger server base URL (e.g., `http://localhost:8080`) |
| `CATLEDGER_TOOL_TOKEN` | Required | CatLedger API token |

## Reference

CatLedger: [https://github.com/gaohongxiang/catledger](https://github.com/gaohongxiang/catledger)
