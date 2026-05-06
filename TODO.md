# TODO

Items surfaced during the Fireworks PR (#7) reviews that were intentionally
left out of that PR but worth picking up later.

## Refactors

- **Extract `CollapsibleModelGroup` in `ManageModelsBox.tsx`.** The
  hide/show + emptyState pattern is copy-pasted across Anthropic, OpenAI,
  Google, Grok, Perplexity and Fireworks (~6 × ~40 lines). A reusable
  component (or map over a providers config array) would cut a few hundred
  lines and make adding the next provider trivial.
- **`ModelGroup` heading double-flex.** Callers wrap `heading` in a
  `flex items-center justify-between w-full` div that nests inside
  `ModelGroup`'s own wrapper of the same shape. Either accept structured
  props (`{ label, actions }`) or drop the outer wrapper.

## Persistence / UX

- **Persist `hiddenProviders`.** Today it's `useState` inside
  `ManageModelsBox`, so any provider the user collapses comes back on the
  next dialog open. OpenRouter persists via app metadata; the others
  should follow the same pattern (probably a single `hiddenProviders`
  JSON column rather than one boolean per provider).
- **Re-download Fireworks/OpenRouter models on API key change.** The
  per-session promise cache (`fireworksDownloadPromise`,
  `openRouterDownloadPromise`) never clears on success, so changing the
  key only takes effect after the user clicks Refresh manually or
  restarts. Could compare the cached key with the current one and
  invalidate the promise when they differ.

## Provider transport hardening

- **`AbortSignal` / timeouts for streaming providers.** Neither
  `ProviderFireworks` nor the OpenAI-SDK-based providers thread an abort
  signal through `StreamResponseParams`. Cancelling a chat or unmounting
  mid-stream just leaves the read loop running until the server closes
  the connection. Adding it requires a small interface change touching
  every provider.
- **`SimpleCompletionProvider` should respect `customBaseUrl` and
  `additionalHeaders`.** Today only the main streaming providers honor
  them; title/summary completions silently bypass any configured proxy.
  Needs a change to `ISimpleCompletionProvider`'s parameter shape.

## DB writes

- **Bound concurrency in `download*Models`.** OpenRouter and Fireworks
  use `Promise.all` over potentially hundreds of models, hitting SQLite
  with that many concurrent writes. Either chunk the writes or batch into
  a single multi-row `INSERT OR REPLACE`. Pre-existing for OpenRouter so
  worth doing both at once.

## Migrations cleanup

- **Squash migrations 139–141** into a single migration that just inserts
  the working `deepseek-v3p1` default. Safe only as long as no installed
  build has run them against a real user DB; if any have, leave as-is.

## Cosmetic

- **Real Fireworks logo.** We swapped `BoxIcon` for `FlameIcon` so it's
  no longer identical to LMStudio, but a proper Fireworks SVG (matching
  the OpenRouter / xAI assets pattern) would be better.
