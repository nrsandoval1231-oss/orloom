# PR27 readiness and delivery observation adjacent review

This note records the bounded implementation-side inspection for the two reproduced P2 findings. It is not an independent review or a certification of the candidate.

Readiness now obtains one coordinator `integrationBinding()` snapshot and uses that same validated snapshot for both binding consistency and planned-check support. It checks the immutable verifier ID, image digest, policy version, lease-policy digest, a well-formed verifier policy digest, unique nonempty supported checks, and agreement with the operator's configured check list. Every check in the approved plan must be supported by both the configured policy and coordinator. Missing, throwing, malformed, or mismatched bindings leave readiness unverified. The HTTP path passes the actual coordinator. The synthetic browser fixture supplies a coordinator binding but does not execute verification.

The Loom delivery-event projection includes `observedRemoteSha` only when it is a valid 40-hex commit SHA. Pending and UNKNOWN events with a null or malformed observation add no remote-revision reference. This changes event references only and does not alter closure conditions or infer a successful delivery.

Adjacent review retained the existing configured `trustedCheckPolicyDigest` as the lease-policy digest, while treating `binding.policyDigest` as the distinct verifier-policy digest; no unsupported equality between those different policy domains was introduced. No provider, credential, runtime, schema, host, deployment, or execution authority was added. Parent-owned focused/full validation and independent exact-candidate review remain pending.
