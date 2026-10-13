# Jev / TypeSafe JavaScript SDK research

Checked 2026-10-13. Research only; no repository implementation edits, credentials, provider calls, or live account/model discovery.

## Identity and version

The official Jev JavaScript SDK is published as `@typesafe-ai/sdk`, not a `jev-*` package. Official quickstart says Node.js 20+ and imports `TypeSafeClient` plus `choice` from that package: <https://docs.typesafe.ai/sdk/javascript>. The docs link to the official GitHub repository: <https://github.com/typesafe-ai/typesafe-sdk-js>.

`npm view @typesafe-ai/sdk@0.6.0 version dist.tarball dist.integrity --json` returned version `0.6.0`, tarball `https://registry.npmjs.org/@typesafe-ai/sdk/-/sdk-0.6.0.tgz`, integrity `sha512-IddX+Q0XM+VagOUZFeP7wZjaO4SHMdvnh2zEBdrZZnXedWI3BNK1lKhMx3ayrkFWvVLbVcUHJy6AVZlY+e6Jaw==`. Official GitHub release page calls v0.6.0 latest, dated 2026-09-15: <https://github.com/typesafe-ai/typesafe-sdk-js/releases/tag/v0.6.0>. The package was fetched via `npm pack --ignore-scripts`; no package scripts ran. Type declarations and runtime bundle are retained locally in this scratch.

Package facts from v0.6.0 metadata: ESM and CommonJS exports; declarations for both; Node `>=20`; MIT; homepage is the official docs URL; repository is `typesafe-ai/typesafe-sdk-js`.

## Stable API shape (0.6.0)

There is no exported `decide()` method. The model call is `client.systemOne(request, options)`; implementation posts to `/v1/systemone`. The request shape is `{ state, questions, model? }`. `state` is JSON-like data/string/null. Questions are a nonempty object keyed by answer name. `choice(prompt, criteria)` creates a typed categorical question; its result is `{type:"choice", choice:<criteria key>, confidence:number, probabilities:{...}}`. The generic result carries `{model:string, answers:{...}, usage:{input_tokens:number, output_tokens:number}}`.

The available model listing is `client.models.list()` (`GET /v1/models`) returning `ModelCard[]` with only `name`, `description`, and `release_date`. This is availability metadata; docs and types do not state that a name is immutable/version-pinned or that it implies tool/function-call capability. `jev-latest` is the SDK default model alias, not a safe immutable pin. No tools/function-calling API is exposed by this SDK; `choice` describes an answer schema, not a tool call.

`TypeSafeClient` constructor accepts `apiKey`, `baseURL`, `defaultModel`, `timeout`, `retry`, `logLevel`, `fetch`, etc. Defaults are `https://api.typesafe.ai`, `jev-latest`, 10,000 ms per attempt, and 2 retries. Default retries cover HTTP 408/429/5xx and connection/timeout errors, with backoff and Retry-After. Per-call `RequestOptions` supports `signal`, `timeout`, `retry`. Timeout is per attempt, not total; response bodies are buffered before handoff. For paid POSTs that must never repeat after ambiguous effects, set `maxRetries: 0` at client and call level and retain UNKNOWN on transport/timeouts after dispatch.

## Security/operational limitations

- SDK 0.6.0 allows explicit empty/whitespace values to bypass environment fallback because it uses nullish fallback. Validate API key, base URL and model before client construction; set a fixed base URL explicitly. Do not pass a key from user content or to a browser (`dangerouslyAllowBrowser` would expose it).
- SDK 0.6.0 emits `fetch` without `redirect:"error"`; add a guarded `Fetch` wrapper that permits only the exact `https://api.typesafe.ai` origin and expected paths and forces redirect rejection. Keep the API key out of request state, errors, logs, and evidence.
- It defaults to `warn`; `debug` logs request/response bodies. Do not enable debug for production requests. Sanitize SDK exception text and store only allowlisted error class/status/digest data. Open issue #14 documents API-key leakage through malformed-key `APIConnectionError` messages and empty-key submission in v0.6.0: <https://github.com/typesafe-ai/typesafe-sdk-js/issues/14>. Validate key chars before construction and never copy raw exception messages into logs/evidence.
- Type declarations do not validate response `model` identity, usage correctness, confidence/probability values, or decision truth. After a dispatched POST, malformed/mismatched results are UNKNOWN; never retry them or treat confidence as trusted verification.
- `models.list()` only returns name/description/release date. It cannot prove immutable model version, tool support, pricing, quota, output semantics, or live spend. Any model and pricing policy must be operator-snapshotted/configured and locally enforced. No API call was made during this research.

## Typechecked integration sketch

The file `integration-snippet.ts` is an illustrative minimal categorical-decision adapter. It requires an operator-allowlisted exact model ID, blocks the default moving alias, fixes the origin and endpoint paths, rejects redirects, disables automatic retries, bounds each attempt and exposes cancellation. It was typechecked without network/API credentials using TypeScript 5.9.3 and the downloaded SDK 0.6.0 declarations:

`npm exec --prefix work/jev-sdk-research -- tsc --project work/jev-sdk-research/tsconfig.json` → exit 0.

The allowed model set in a real service must come from trusted operator configuration; this research did not invent or verify a model ID. Caller must classify post-dispatch transport failure, returned model mismatch, or malformed usage as UNKNOWN.
