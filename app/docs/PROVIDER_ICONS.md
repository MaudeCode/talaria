# Provider icon registry

`Talaria/Models/ProviderIconRegistry.swift` is the single source of truth for
mapping provider IDs and aliases to bundled vector assets. Unknown and custom
providers receive a deterministic two-letter monogram.

The Provider Icons setting chooses whether SwiftUI renders the original brand
colors or a tintable silhouette. Providers normally reuse one SVG for both;
Hugging Face uses its matching monochrome SVG because the color artwork's
underlying face circle would otherwise fill its facial and hand cutouts.

The registry covers the combined provider identities exposed by the adopted
Hermes WebUI contract and Hermes Agent's canonical/plugin provider catalog.
Alternate authentication and regional IDs reuse their provider's mark—for
example, `copilot-acp`, `kimi-coding-cn`, `meta-ai`, `minimax-oauth`, and
`qwen-oauth`.

Asset sources, pinned collection revisions, licenses, and trademark notes live
under `Talaria/Resources/ThirdPartyNotices/`.
