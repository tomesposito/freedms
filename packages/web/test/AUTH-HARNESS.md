# Offline hosted sign-in verification (#66)

From the repository root:

```sh
node packages/web/test/mock-cognito.mjs
VITE_COGNITO_DOMAIN=https://offline.auth.us-east-1.amazoncognito.com \
VITE_COGNITO_CLIENT_ID=offline VITE_COGNITO_USER_POOL_ID=us-east-1_offline \
VITE_COGNITO_ENDPOINT=http://127.0.0.1:9229 npm run dev -w @freedms/web
```

The Node server implements Cognito JSON-RPC with plausible SRP challenge values,
fake JWTs, refresh, revocation and password-reset responses. The actual Cognito
SDK performs SRP in the browser. This fixture does **not** verify SRP proofs and
is not an identity service. Any nonempty password works for success fixtures.
`wrong@…` and `unknown@…` simulate rejected credentials, `newpass@…` requests a
new password, and `totp@…` requests code `123456`. `setup@…` enrolls an authenticator,
and `newpasssetup@…` requires both a new password and enrollment. Setup verification
and reset confirmation use `123456`. `unsupported@…` requests unsupported SMS setup.
No AWS connection is made. Never configure this endpoint in a production build.

```sh
node packages/web/test/auth-tour.mjs
```

The tour starts and stops its own mock and Vite server (port 5199), uses
`playwright-core` installed at `~/workspace/tools/screenshots`, and writes
`66-login-*.png` there under `freedms/`. It copies the empty desktop login to
`docs/screenshots/login.png`. Override `PLAYWRIGHT_ROOT`, `SCREENSHOT_DIR`, and
`CHROMIUM_PATH` if needed. It prefers `/usr/bin/chromium`, with the installed
Playwright Chromium headless shell as the environment-specific fallback.

The tour covers desktop/mobile sign-in, generic rejection, password-change and
TOTP challenge completion, reset request/confirmation, and the post-login API
attempt. The API is deliberately stubbed to reject the fake identity: the tour
asserts exactly one refresh and one retry before returning to login. Screenshots
do not claim a real signed-in dealership session. `npm test` includes additional
SDK protocol tests and storage, proactive expiry, sign-out, callback, rollback,
missing-pool, and local-mode regression tests. Live verification is post-deploy.

The browser tour also verifies a successful refresh/retry into a stubbed welcome
shell, revocation on sign-out, and the `MFA_INVALID` no-refresh exception.

Implementation notes: the mandated Apache-2.0 `amazon-cognito-identity-js` package
brings transitive `tslib` (0BSD), `ieee754` (BSD-3-Clause), and
`webidl-conversions` (BSD-2-Clause). This is a conflict with a literal
MIT/Apache-only transitive dependency requirement; the required SDK was retained
without replacing its dependency tree. The existing Inter-first product font
stack is retained. The unmodified share-card JPG is cropped in CSS to its
text-free right-hand photo area.
