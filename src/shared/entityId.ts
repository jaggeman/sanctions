// Every real sanctions-record id looks like "EU-1234", "US-SDN-999",
// "CUSTOM-1" — letters, digits, hyphens, underscores. Firestore's own
// auto-generated document ids are also plain alphanumeric. Nothing
// legitimate needs "/", ".", whitespace, or any other character: a "/" in
// particular is Firestore's own path separator, so an id containing one
// doesn't error against `.doc(id)` — it silently addresses a different,
// unintended document nested in the collection hierarchy (CLAUDE.md §6).
const VALID_ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Firestore reserves any document/field id matching this shape (e.g.
// "__proto__") for its own internal use and rejects it outright — with a
// raw driver error that echoes the real project id and internal document
// path straight back to the caller (issue #93's live pen-test reproduction).
// "__proto__" is plain alphanumeric/underscore, so it passes the charset
// check above; this is the only way to actually stop it before it reaches
// Firestore.
const FIRESTORE_RESERVED_PATTERN = /^__.*__$/;

export function isValidEntityId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    VALID_ENTITY_ID_PATTERN.test(value) &&
    !FIRESTORE_RESERVED_PATTERN.test(value)
  );
}
