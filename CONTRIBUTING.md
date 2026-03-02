# Contributing to RTPR SDK

We welcome contributions to the RTPR SDK. This document explains how to get started.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/rtpr-sdk.git`
3. Create a branch: `git checkout -b feature/your-feature`
4. Make your changes
5. Push and open a Pull Request

## Development Setup

### Python

```bash
cd python
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

### Java

```bash
cd java
mvn clean test
```

### C++

```bash
cd cpp
mkdir build && cd build
cmake ..
make
```

## Code Style

- **Python**: We use `ruff` for linting and formatting. Run `ruff check .` and `ruff format .` before committing.
- **Java**: Follow standard Java conventions. Run `mvn checkstyle:check` if available.
- **C++**: Follow the project's clang-format configuration.

## Pull Request Guidelines

- Keep PRs focused on a single change
- Add tests for new functionality
- Update documentation if you change public APIs
- Ensure CI passes before requesting review

## Reporting Issues

Open a GitHub Issue with:
- SDK language and version
- Steps to reproduce
- Expected vs actual behavior
- Any error messages or stack traces

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
