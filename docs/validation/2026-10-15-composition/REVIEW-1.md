# Independent source review, first pass

Reviewer: independent Sol context, 2026-10-15. Verdict: FIX before claiming reliable cancellation.

Raw report:

> The source preserves UNKNOWN quarantine and reserved spend, but three cancellation paths can leave a mission permanently cancelling: after candidate submission, requestCancel retains awaiting_verification while settlement excludes it; cancellation before runtime intent has no binding; separate SQL/file writes can leave evidence settlement cannot use. The composition API also permits a runtime factory to ignore the trusted journal; both fixtures do so. It therefore does not establish cancellation binding for every execution. No concrete defect was found in migration repeat execution or the verifier partial-configuration check. Tests were not run while the controller's Linux suite was running.

Controller response: add regression-backed settlement after candidate submission, atomic never-started settlement with registration fence, a concrete Docker runtime composition wrapper, authenticated persisted-lease preflight, and retry of the file-created/SQL-bind gap from retained trusted journal entries. A SQL intent whose journal write fails remains UNKNOWN and explicitly requires operator reconciliation; no absence proof or refund is fabricated. Final independent review must inspect the repaired exact candidate separately.
