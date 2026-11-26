# ADR 0024: Create the initial admin in the browser

- Status: Accepted (2026-11-02), supersedes ADR 0002's initial-admin bootstrap
- Decision: owner requested a signup page instead of generated startup credentials

## Context

Finding an initial username and password in container logs adds friction before the owner can use
BokyDo. A fresh instance should open a signup form where its owner chooses both credentials.

## Decision

Startup generates only infrastructure secrets and runs migrations. It creates no user and logs no
admin credentials. The public instance status includes `initialAdminRequired`, true only when the
users table is empty. The web app sends that state to `/setup/admin`, with username, password and
password confirmation fields.

`POST /api/v1/setup/admin` validates a strict request, the ordinary username/password policy and
Origin, and limits attempts by client IP. A transaction takes the initial-admin advisory lock and
checks for any user again before creating exactly one admin. Existing or disabled accounts close
the endpoint. Ordinary registration also requires an existing owner and checks that condition under
the same lock, so open registration or a surviving invite cannot consume the first-user slot. The chosen password is
hashed and does not require a second password change. A normal session is issued after commit.

The account's creation preserves existing instance configuration. A genuinely fresh installation
continues through the existing setup wizard; a preconfigured instance can enter the app directly.
Upgrading an instance with users never reopens initial signup.

## Consequences

The first person who submits a valid signup on an unclaimed instance becomes its administrator.
Operators should complete initial signup before inviting others to a public installation. No setup
token or log/CLI step is part of normal first-run onboarding.

Optional host-side password/MFA recovery commands remain available for an owner who loses access.
Their explicit recovery output is separate from startup, which never generates admin credentials.
