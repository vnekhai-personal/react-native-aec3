# Contributing

## Development

To contribute by resolving an open issue:

1. Fork the repository.
2. Create a branch for your fix or feature.
3. Commit your changes, following the [Conventional Commit Specification](https://www.conventionalcommits.org/en/v1.0.0/).
4. Open a pull request. Enable "Allow edits from maintainers" so changes can be suggested on it.

A change under `cpp/`, `ios/` or `android/` is reviewed with the example's self-test: say in the pull request
which iOS Simulator and Android emulator ran it and what it reported. `vendor/` is never edited by hand; a fix
of ours goes in `cpp/`. Everything else the code keeps, the commands and the vendoring procedure are in
[CLAUDE.md](./CLAUDE.md).

Implementing a feature of your own should be preceded by a design note: any document describing the API and
the implementation.

## Reporting issues and feature requests

Open an issue for a bug, with the `diagnostics()` output of a session that shows it. For a feature request,
open an issue or start a discussion first to talk the idea through.
