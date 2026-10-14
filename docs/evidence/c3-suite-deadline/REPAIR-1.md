# Deadline repair

Independent review rejected source `022e7b7207c48b84a03e69467428614ce8584954`: an awaited final callback could return after the suite deadline and still yield PASS. Its FIX record is retained unchanged. No image or cloud run used that rejected source.

The repair checks the remaining monotonic budget after every awaited stage, after admission, and before emitting the final result (including after serialization). Expired results become UNKNOWN. Diagnostic elapsed durations are integer milliseconds; deadline comparisons retain full precision. A deterministic callback regression crosses the budget during the awaited callback and verifies UNKNOWN and suppression of the next stage. The actual diagnostic emitter rejects an otherwise valid fractional-duration frame and accepts its integer counterpart.

The first repair controller gate log at 11:10 UTC passed, but was superseded by two tests-only improvements: removing host scheduling sensitivity from the callback test and isolating fractional-duration rejection from missing-field rejection. The later full controller gate log is authoritative for the final repaired source. Limits, credentials, certificate authority, previous UNKNOWN attempts and protected PR #2 remain unchanged. Actual cloud acceptance is still pending.
