# Verified Headroom on Studio

`studio-headroom.py` uses installed Headroom 0.41.0 `densify()` and independently
decodes each candidate before accepting it. Equality preserves JSON values,
types, array order and duplicate rows. JSON whitespace and object key order
are not preserved. Duplicate object keys, fractional numeric literals,
non-finite numbers, malformed JSON and non-JSON text pass through unchanged.
Decimal amounts represented as JSON strings are eligible for compression.

Only JSON arrays in tool text are eligible. User/system messages, reasoning,
tool IDs, images, schemas and native protocol structure are not rewritten by
the verified compression stage. This does not change other provider translators
or restore content already truncated by a client/tool.

The bridge requires `verified-lossless-v1` and matching SHA-256 receipts for
original and emitted text. Verification occurs inside the trusted local adapter;
receipts bind that result to the request, not to an arbitrary remote service.
Any timeout, invalid response, failed round trip or expansion retains originals.
Both UTF-8 size and `cl100k_base` token count must shrink, including the format
legend. Counts estimate savings; provider tokenization and billing may differ.

Set `headroomVerifiedLossless: true`, `headroomEnabled: true`, and point
`headroomUrl` at the adapter. Verified mode bypasses RTK, Caveman, Ponytail,
custom prompt injection and PXPIPE, regardless of their individual switches.
The adapter never runs code or ML compression. Installed extras can remain.
Compression preserves data, not a guarantee of correct model reasoning.

Run from the source root, using the existing Headroom virtual environment:

```sh
~/.9router/headroom/bin/python scripts/studio-headroom.py --port 8788
HEADROOM_TEST_URL=http://127.0.0.1:8788 ~/.9router/headroom/bin/python -m unittest discover -s tests/python -p test_headroom_lossless.py
cd tests
HEADROOM_TEST_URL=http://127.0.0.1:8788 ./node_modules/.bin/vitest run unit/studio-headroom-lossless.test.js unit/headroom*.test.js
```

Production launchd service `com.sickmeyer.headroom` runs an immutable copy under
`~/.9router/headroom/verified/<release SHA>/server.py` on port 8787. `/health`
reports the mode and disabled ML/code transforms. Prior settings and launchd
configuration are backed up under `~/.9router/headroom/setup-backup/`.
The standard Studio build/release scripts deploy the matching 9Router bridge.
