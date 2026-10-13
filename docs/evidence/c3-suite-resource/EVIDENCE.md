# 2 GiB resource trial: UNKNOWN at the suite deadline

Source617c378148df741de05c9e030950841bfd3cb70e passed76 local tests and independent source review. Helper v1 was rejected before host execution because it confused the image source label with a controlled fixture commit; corrected v2 db12a335f4a16a5a5eaae5809eaff4914f6228a5a54d101c170de8cd308d01b5 passed pre-execution review. Both retained.

The real existing-host run was admitted after PostgreSQL started with3,406,979,072 available bytes, exceeding the reviewed2GiB+768MiB reserve floor. Exact container HostConfig matched the trusted2GiB profile. Attempt770b1ae5-84cf-4c33-962b-dbfc701f056a ended UNKNOWN184,619ms with zero certificates. Ten test files completed; verification-certification.test.js ordinal11 was interrupted at the180s suite deadline. Recovery-learning alone consumed74,320ms. The remaining tests/check stages and negative scenarios were not run.

596 exact-CID samples peaked at1,278,328,832 bytes; no OOM event was observed in the retained samples. This supports that the prior1GiB limit was insufficient for this measured execution, not a claim that all future inputs fit2GiB or that performance improved. The actual suite deadline, resource cap and incomplete check set remained enforced.

Image sha256:a0b779d075c95fba63d4fb365935be8d498c56025e8547d4243e80b2484ba319; source manifest09f99677a6dfbf7f060a65180671cadf243182c62b1bf372e547d544c1fbceeb. After-cleanup archive SHA256 ea34545c94284618cd348496f77c6a410fa142bab4689ce5c888945293c6d88d. Exact disposable PostgreSQL resources/credentials were removed; shared slot/state were free and protected host identity unchanged. No provider calls, paid infrastructure, deployment or PR2 changes.

Next correction requires a measured finite execution-time budget and a new independently reviewed candidate. No blind redispatch, automatic memory increase, certificate, operational full CI or learning-gain claim is allowed from this evidence.
