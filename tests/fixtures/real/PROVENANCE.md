# Real fixture provenance

The accepted plan calls for a checked-in public `.fig` regression fixture and a byte-level v106 derivative. No redistributable binary was present in the task workspace, and redistribution terms for a downloaded archive are not certified. The generated v106 fixture under `generated/` is intentionally separate and does not substitute for that gate.

When a user-approved binary is available, place it outside this repository and pass its path through the opt-in external-fixture command. Record its source URL and SHA-256 values in a private validation note, then enable the real archive test only if redistribution is approved.
