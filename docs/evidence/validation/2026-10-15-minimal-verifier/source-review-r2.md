# Independent source review R2

Disposition: NO MATERIAL SOURCE FINDINGS requiring repair before controller qualification. Source review only; no runtime acceptance, full-suite pass or runsc certification is asserted. Earlier source review and R1 report are preserved unchanged.

Reviewed actual uncommitted source against main 9457b1bcb10b085602f337b253580d23ad0b1d93 on 2026-10-15 UTC, including new untracked emit-result.js, both result producers, Dockerfile, policy binding, affected tests and updated packet. No source edits or Docker/host commands were performed. git diff --check passes.

The measured defect is consistent with the original immediate process.exit following an asynchronous stdout.write. New emit-result.js constructs the same one-line ORLOOM-RESULT frame and awaits its write callback. Both syntax and suite paths await it before process.exit. Dockerfile copies and chmods the new helper. Serialization, marker schema, captured log limits and launcher parser are unchanged. A callback error rejects the top-level await; stdout stream errors can also terminate the process. Neither path manufactures a successful marker after an error. The existing launcher rejects stderr, nonmatching launcher exit, missing/malformed/truncated marker, timeout or signal as UNKNOWN. An already delivered success marker followed by a stream failure likewise cannot satisfy exit/stderr agreement.

Deadline distinction: the 360-second execution checks still apply before result emission and no later check stage starts. Waiting for output transport has no new helper-local timer or post-write 360-second check; a stalled transport is bounded by unchanged Docker attach timeout 390s (plus 2s kill-after), host launcher 405s and attempt expiry 420s. This uses the existing transport envelope and does not increase any timeout. It should not be described as proof that complete result delivery always finishes within 360 seconds. No indefinitely blocked invocation can be accepted by the bounded production launcher. This review does not infer standalone helper liveness without that launcher.

The new meaningful regression exercises the shared actual emitter with 65,536 decoded bytes on each stream, produces an approximately 233 KB frame, pauses a real pipe reader, checks clean child exit and decodes/asserts both complete payloads. A 15-second test timeout bounds failure. Source assertions additionally verify both callers await the helper. The regression is not a replacement for controller full-image execution. The corrected Docker npm-path/base assertion follows the actual pinned image rather than deleting dependency-install coverage.

Policy advances to v8 and adds awaited-result-marker-v1 to the manifest. Expected digest is updated to 9d6d53f336b2719712ed6ba836b090198538ceb790c1f542b5930069353e1417; startup fixture expects v8. Finite runner version/digest/image mismatch rejection remains intact. HOME=/nonexistent and TMPDIR=/work remain equal between policy and suite stage bytes. The earlier recipe/dependency/helper, private-policy fixture, static-symlink-safe cleanup and source immutability conclusions remain applicable. Seven stages, runtime isolation, limits, log admission and UNKNOWN handling are unchanged in the inspected diff.

SHA-256 identity anchors:
- emit-result.js: cc968fd7aa17caa9636c20c44570bd7073d86ebbdb494e192a72a2af2246ec76
- run-check.js: 9b3b70f1d843c33ddece81a40c67a5a934e1680b8fa79a01a337d2485a524d56
- run-repo-suite.js: 8269628cf3965da4fa10558b736892199cdec4d41e9adaf80c005eed2987a671
- Dockerfile: 0091367dfc8ac7904c69a86fad2fb74b8c8624942e97d66cb6e8e9153c155afe
- policy.ts: 6b3b0090dc2d38209fd9580919f337977bbb7e871e6b6b0dcc31159b02855000
- verification-runner.test.ts: 1a7b3f885af0930c5dc925a24fe4e28aa48a17ced8b43d44c3cadacafdd68161

Remaining controller gates: freeze exact corrected source/input/image identities, build the R2 image, run affected behavior and full suite under the unchanged Linux nonroot/read-only-source/resource policy, preserve old RED and stale images as historical failed-candidate evidence. No result from an older image qualifies R2. No material source publication risk was found beyond these explicit pending runtime gates.
