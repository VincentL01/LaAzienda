# Local company mail

Stalwart is the internal transport for employee coordination. Its management, SMTP, submission, and IMAPS ports are bound to `127.0.0.1`; it is not an internet-facing mail server. Employee containers reach it over the external Docker network `one-man-company` using the hostname `stalwart`.

## Start and initialize

1. Run `./infrastructure/mail/Start-Mail.ps1`. The script creates a random recovery credential in ignored `.env.local`, creates the private Docker network, and starts the pinned `stalwartlabs/stalwart:v0.16` image.
2. On the same machine, open `http://127.0.0.1:8088/admin`. Use the recovery credential from `.env.local`, set the hostname to `mail.one-man-company.test`, the domain to `one-man-company.test`, disable public ACME for this internal deployment, keep RocksDB and the internal directory, and choose console logging.
3. Restart with `docker compose --file infrastructure/mail/compose.yml restart stalwart`.
4. While the portal is running locally, run `./infrastructure/mail/Provision-Mailboxes.ps1` to reconcile requested employee mailboxes. Per-employee passwords are stored only in ignored `runtime/state/<employee-id>/mail-password` files.
5. Run `./infrastructure/mail/bridge.ps1` to deliver the durable D1 outbox through the loopback-only SMTP listener. A scheduled executor can invoke both reconciliation scripts later.

`STALWART_RECOVERY_ADMIN` is intentionally retained for this machine-local development deployment so the provisioning script can use the management API. Replace it with a scoped Stalwart API key before exposing any management surface beyond loopback.

The domain uses the reserved `.test` suffix. No public DNS or external delivery is configured.
