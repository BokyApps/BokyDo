# Recovering a BokyDo instance

Break-glass procedures for an instance you can reach over SSH. `docker compose exec` already means
full trust over the stack (see threat-model trust boundary 4), so nothing here widens access — it
just spells out what to type.

Every command below assumes you are in the repository root and that the stack uses the default
project name from `compose.yml` (`bokydo`). Add `-p <project>` if you started it differently, and
adjust the volume names (`<project>_app-data`, `<project>_db-secret`) to match.

## Sign-in problems

| Symptom                          | Command                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| Lost the admin passphrase        | `docker compose exec app bokydo admin reset-password admin` |
| Lost the phone _and_ the codes   | `docker compose exec app bokydo admin reset-mfa <username>` |
| A wrong public URL blocks logins | `docker compose exec app bokydo admin clear-public-url`     |

`reset-password` prints a new one-time passphrase and revokes that user's sessions; they must change
it at the next sign-in.

## Both copies of the database password are gone

### What the two copies are

The app generates the database password on first boot and keeps two copies:

- `/data/secrets/db_password` in the **`app-data`** volume (the app's own copy), and
- `password` in the **`db-secret`** volume, which the app publishes for Postgres.

Postgres copies the shared file into an in-memory tmpfs at start-up and never mounts `app-data`. If
either copy is still present, **do nothing** — the app adopts the survivor and rewrites the other one
on the next boot. If they disagree, the app refuses to start with an explicit error.

### What losing both looks like

- The app container runs but never becomes healthy; `curl -fsS http://localhost:8080/readyz` fails.
- Its logs stay quiet: it is waiting for a database that rejects the password it just generated.
- **Your data is not lost.** Postgres still holds the old password hash and all the data; only the
  plaintext the app needs to authenticate was lost.

If you are in this state, it is usually because `app-data`'s `secrets/db_password` and the
`db-secret` volume were both removed or restored from different backups. Taking the stack down
resets nothing by itself.

> Do **not** delete the `pg-data` volume to "fix" this. That volume is the database.

### Recovery

On start-up with both copies missing, the app generates a fresh password and writes it to _both_
copies. Postgres does not know it yet, so the fix is simply to tell Postgres the new value.

1. Bring the stack up so the app creates the new pair (skip if it is already running):

   ```bash
   docker compose up -d
   ```

2. Read the password from the shared volume. This uses the same pinned BusyBox image as
   `docker/smoke-test.sh`:

   ```bash
   BB=busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
   NEW=$(docker run --rm -v bokydo_db-secret:/v:ro "$BB" cat /v/password)
   ```

   Keep it in the variable rather than echoing it, so it does not land in your shell history.

3. Apply it to the Postgres role. Connecting through the container's Unix socket needs no password
   (the image trusts local connections), so this works while the app is locked out:

   ```bash
   printf "%s\n" "ALTER ROLE bokydo WITH PASSWORD :'pw';" \
     | docker compose exec -T db psql -U bokydo -d bokydo -v pw="$NEW"
   ```

   Feed the statement through standard input rather than `psql -c`: `-c` does not expand `:'pw'`,
   and it fails with a syntax error at the placeholder.

4. Confirm recovery. The app retries for up to two minutes without a restart, so it should recover
   on its own:

   ```bash
   docker compose ps                                   # app: healthy
   curl -fsS http://localhost:8080/readyz              # {"status":"ok"}
   docker compose logs --tail 20 app                   # "BokyDo started"
   ```

If the app has already given up on this attempt it restarts (the service is `restart:
unless-stopped`) and comes up against the corrected password. Restarting never changes the password
again, because both copies now agree.

## The whole `app-data` volume is gone

`app-data/secrets/` also holds `master.key`, `session.key` and `vapid.key`. Losing them is a
different, worse case: every encrypted value in the database (SMTP password, AI provider keys, TOTP
secrets) is unrecoverable, because the data encryption key only ever existed in that volume. Restore
`secrets/` from a backup; there is no way to regenerate it. Postgres data alone is not a complete
backup.

## Readiness checks used by this document

`docker compose ps` shows the container health (`/healthz` for liveness, `/readyz` for database
reachability). A stack that is `running` but never `healthy` is the signature of a database the app
cannot authenticate to.
