# Vortex provider adapters (copied)

Copied from the Vortex repo (`JoshSunJ/vortex`, `origin/main` @ d18d039, `services/intelligence/{extract,retrieval,provider_common}`)
with only the import paths rewritten from `services.intelligence` to `agents.providers`.

Written by Nathan: Apify article extractor + URL guard (`extract/`), Elastic Agent Builder indexing and search
(`retrieval/`), and their shared HTTP/error helpers (`provider_common/`). Standard library only.

Run the tests from the repo root:

```bash
python -m unittest discover -s agents/providers/extract/tests -t .
python -m unittest discover -s agents/providers/retrieval/tests -t .
```

Evidence rule inherited from Vortex: these adapters are unit-tested against fake transports. Nothing here counts as
sponsor evidence until a real Apify run / Elastic search has been done with real credentials.
