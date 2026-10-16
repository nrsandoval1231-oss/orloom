# Bundled UI fonts

The Forest & Brass Command Center and Live Loom embed Latin WOFF2 subsets of Manrope and Cormorant Garamond as data URIs in `apps/control-plane/src/ui-theme.ts`.

- Manrope regular variable: [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/manrope), used for body and interface text.
- Cormorant Garamond medium: [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/cormorantgaramond), used for display headings and the wordmark.

Both families are distributed under the SIL Open Font License 1.1. The corresponding upstream license texts are retained in `docs/design/font-licenses/`. Fonts are embedded to keep the interface self-contained; the page CSP permits only data URI font sources.
