Prisma migration history notes

The migration chain in this repo includes two repair points that were added so `prisma migrate dev` can replay the schema cleanly from an empty shadow database:

- `202605070001_initial_schema`
  Recreates the missing baseline schema that existed before the tracked auth, event-indexer, and anti-abuse migrations.

- `202605130001_reconcile_schema_with_current_models`
  Reconciles the older event-indexer/manual SQL era with the current Prisma models for the real-time indexing tables.

Why this exists:

- The database schema already existed locally, but `_prisma_migrations` did not contain a valid baseline.
- Prisma shadow-database validation failed because later migrations referenced tables that were never created by tracked migrations.

Guidance:

- For an existing local database that already has the full schema, use `prisma migrate resolve --applied ...` to baseline it instead of replaying the entire history destructively.
- For new databases, normal `prisma migrate dev` and `prisma migrate deploy` should work from this repaired migration chain.
