# Contributing to RTPR SDK

Keep changes focused on the alert-then-fetch contract. Do not add article
parsing, structured content extraction, persistence, or unsupported language
clients.

## Python

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
ruff check .
ruff format --check .
mypy rtpr
pytest
python -m build
```

## Node.js

```bash
cd node
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

Tests should be deterministic and use mock HTTP/WebSocket services. Changes to
transport behavior should cover raw-byte parity, retries, redirects, bounded
queues, shutdown, and slow-consumer isolation as applicable.

Never include real API keys, signed URLs, article bodies, customer identity,
hostnames, or IP addresses in fixtures, snapshots, errors, or support reports.

By contributing, you agree that your contribution is licensed under the MIT
License.
