# Contributing

## AI-assisted contributions

If you use AI, you remain fully responsible for the contribution.

Generative AI tends to work best on:
- small components
- standard code
- well-scoped implementation tasks
- boilerplate
- tests
- simple refactoring

Please be especially cautious when using AI for:
- architectural changes
- security-sensitive code
- authentication or authorization logic
- dependency changes
- persistence-related changes
- public API changes
- complex business logic

You must ensure that:
- you understand the code you submit
- the code matches the project architecture
- the tests pass
- the contribution does not include code with unclear licensing or provenance

The scope of a contribution may be large if needed.  
You do not need to reduce scope artificially.  
However, you must ensure that all submitted code remains understandable, reviewable, and fully aligned with the standards of the project.

## Commits and pull requests

If AI was used in a contribution, disclose it in the pull request description.

Recommended format:

- AI used: yes/no
- Scope: what AI helped with
- Human validation: how the code was reviewed and verified

Example:

- AI used: yes
- Scope: generated unit tests and a simple mapper implementation
- Human validation: reviewed manually, adjusted naming, and added edge-case tests

For AI-assisted commits, add both the human contributor and Claude as co-authors using the Git trailer format:

```
Co-Authored-By: Your Name <your@email.com>
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## License and provenance

This project uses automated license scanning tools such as ScanCode Toolkit, and may also use FOSSology in CI.

By submitting code to this repository, you confirm that, to the best of your knowledge, you have the right to contribute it under the project license.

Maintainers may reject any contribution with unclear provenance or licensing risk.