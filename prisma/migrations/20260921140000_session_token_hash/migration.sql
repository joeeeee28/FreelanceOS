-- Store a one-way hash of the session bearer token instead of the token itself.
--
-- Existing rows hold raw tokens, which cannot be converted into their hashes by
-- a SQL migration (hashing here would still leave the raw values recoverable
-- from WAL/backups, and pgcrypto is not guaranteed to be installed). Existing
-- sessions are therefore deleted: users are signed out once, and no raw bearer
-- token survives the upgrade. This is an intentional, documented trade-off.

DELETE FROM "Session";

-- Rename rather than drop/add so the unique index is carried over in place.
ALTER TABLE "Session" RENAME COLUMN "token" TO "tokenHash";

ALTER INDEX "Session_token_key" RENAME TO "Session_tokenHash_key";
