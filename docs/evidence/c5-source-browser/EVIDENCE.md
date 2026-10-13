# Living Loom source and controlled browser acceptance

Exact source: `bd2bb5e34cee8562f40d4be2949c82030a7b20d2`. Source manifest: `e7b3220750208601fa9090b2fe8c8b589eccca54e65e86a0ff544cb874345b60` (131 files).

Final controller gates passed: typecheck, clean build, all **110 tests**, foundation validation, verifier JavaScript and shell syntax, and diff checks. Independent review returned `PASS_SOURCE_BROWSER_BOUNDED`; its exact scope and open gates are retained in `c5-source-review-bd2bb5e.json`.

The controlled browser run `2026-10-13T22-49-02-392Z` passed owner-session protection, visible WebGL weave, keyboard access, mobile layout, offline/reconnect display, forced visible SVG fallback, mobile Enter selection, and desktop click selection after resizing. Screenshots use a deliberately labeled memory-store mission with no builders running. Browser requests do not contain credentials in retained evidence.

Earlier attempts remain intact: 19abb354 needed visual, pagination and closure repairs despite passing tests; 0c8c85d's follow-up helper did not expand the mobile inspector; df72574 exposed a genuinely hidden SVG fallback; 8d6dda1 exposed duplicate visible inspectors after resizing. The successor fixes these rather than suppressing the assertions. V1–V4 archived prototypes remain unchanged.

This is not PostgreSQL-backed browser proof, cloud deployment, real builder/provider execution or certification of an engineering outcome. The underlying C4 source 078ed12 later failed an actual PostgreSQL concurrent replay scenario; that separate repair is required before broader acceptance. The latest full repository cloud verification remains FAIL with zero certificates on prior source 8f271de. No learning improvement is claimed.
