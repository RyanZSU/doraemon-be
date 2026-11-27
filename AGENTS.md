# AGENTS.md

Guidance for coding agents working in this repository. Setup, API contract and
deployment instructions live in [README.md](README.md); this file records the
rules, invariants and environment traps that are easy to get wrong.

## Project

- NestJS 12 backend for a WeChat mini program ("家用百宝箱"), TypeScript (ESM),
  Mongoose 9, JWT auth.
- Users log in with WeChat. **Silent login (`/auth/wechat-login`) is the
  default**: the openid from `jscode2session` is the account identity, which
  works for personal-subject mini programs. The phone-based `/auth/login`
  remains available for certified organisation subjects. Each future tool
  (check-in, diary, …) is added as a module.
- Because the mini program is not published yet, Android (and a future iOS app)
  use **invite-gated phone + password accounts** (`/auth/register`,
  `/auth/password-login`). Phone + password is the client-agnostic account
  path; WeChat openid stays an optional future binding.
- Production runs on Azure App Service (Linux, Node 24 LTS) and connects to
  Azure DocumentDB (MongoDB vCore). Infrastructure is Bicep, CI/CD is GitHub
  Actions with OIDC.

## Commands

```powershell
npm ci
npm run start:dev        # watch mode + Swagger (SWAGGER_ENABLED=true)
npm run build            # tsc -> dist/
npm start                # node --enable-source-maps dist/main.js
npm test                 # Vitest unit tests, no database needed
npm run test:e2e         # skipped automatically unless MONGODB_URI is set
npm run lint             # oxlint --type-aware
npm run format
npm run invite:create -- --count 3 --note "family"  # needs npm run build first

# Deployment dry run against Azure (no resources deployed; needs az login).
# It may create the resource group if it does not exist yet.
.\deploy\scripts\deploy.ps1 -ValidateOnly -UseFreeAppServicePlan -Location eastasia

# Bicep compile check (Bicep CLI installed by install-bicep.ps1)
$bicep = "$env:LOCALAPPDATA\doraemon-be\bicep.exe"
& $bicep build deploy/main.bicep --stdout > $null
```

Before finishing a task, run `npm run lint`, `npm test` and `npm run build`.
For Bicep changes, also compile with `deploy.ps1 -ValidateOnly`.

## Code map

```
src/main.ts                     bootstrap: /api prefix, global pipe, Swagger, trust proxy
src/app.module.ts               global JWT guard, response interceptor, exception filter
src/config/env.validation.ts    Joi validation; startup fails on bad env
src/database/database.module.ts global Mongoose connection
src/common/                     @Public(), @CurrentUser(), guards, filters, interceptor
src/modules/auth/               WeChat + password login, access_token cache, JWT strategy
src/modules/invites/            single-use invite codes for password registration
src/modules/users/              user profile + User schema
src/modules/health/             /api/health (Mongo ping), /api/health/live
src/scripts/create-invites.ts   local-only invite generator (never an HTTP route)
deploy/                         Bicep, parameter files, deploy/OIDC scripts
```

## Invariants

**Identity and auth**

- Silent login (`/auth/wechat-login`) is the default. It needs only the
  `wx.login()` code; `jscode2session` supplies the openid used as the account
  key. Phone login (`/auth/login`) is opt-in for certified organisation
  subjects, since personal subjects cannot use `getPhoneNumber`.
- **WeChat login** never accepts a phone number from the client. The phone must
  come from `phoneCode` → WeChat `getuserphonenumber` on the server.
  `AuthService.login` already enforces this.
- **Invite-gated phone + password accounts are the deliberate exception**:
  `POST /auth/register` does accept a self-asserted phone as an account
  identifier because there is no SMS/WeChat verification. It must require a
  valid, unused, unexpired invite; never treat that phone as verified and never
  use it as proof of identity.
- Password accounts store only `passwordHash` (Node `crypto.scrypt`,
  `select: false`). Never return it, log it, or add it to `UserProfile`.
  `passwordLogin` returns a generic 401 for unknown phone/wrong password, and
  counts attempts before the DB/password work (429 after the limit).
- Invites are single-use and expiring; consumption is atomic
  (`findOneAndUpdate` with `usedAt: null`). Registration must release the invite
  when account creation fails. Invite issuance is CLI-only
  (`src/scripts/create-invites.ts`), never an HTTP endpoint.
- Never store or return `session_key`; it is not needed.
- `phone` is optional with a sparse unique index (`phone_sparse_unique`);
  `openid` is unique + sparse too. Keep both sparse — openid-only accounts have
  no phone. `UserIndexService.syncIndexes()` migrates the legacy non-sparse
  `phone_1` index on startup; do not remove it.
- For phone login, when the same openid uses a different phone, the openid is
  detached from the old account before being bound to the new one.
- `wechatId` is self-reported; it is not an identity and cannot be verified.
- All routes require a Bearer JWT unless explicitly marked `@Public()`. Add
  `@Public()` only for endpoints that genuinely need anonymous access.
- The JWT payload is `{ sub: userId, phone, openid }`, with nullable phone and
  openid; `@CurrentUser()` exposes it.

**API shape**

- Controllers return plain data. `ResponseInterceptor` wraps every success as
  `{ code: 0, message, data, requestId, timestamp }`.
- Throw Nest `HttpException`s (or subclasses); `AllExceptionsFilter` creates the
  error envelope. Error `code` equals the HTTP status.
- Do not return Mongoose documents directly; map to explicit DTO/profile shapes
  (`toUserProfile`).

**Configuration**

- Every environment variable is validated in `src/config/env.validation.ts`.
  When adding one, update that schema, `.env.example`, the README table and the
  App Service `appSettings` in `deploy/modules/appService.bicep`.
- Swagger is off unless `SWAGGER_ENABLED=true` (default `false`).

**TypeScript / ESM**

- The project is ESM: relative imports end in `.js`, there is no `__dirname`
  (use `import.meta.dirname`), and tests run on Vitest (`vi.fn`, not `jest`).
- Strict TypeScript; keep `npm run lint` at zero warnings.

**Database**

- Azure DocumentDB requires `retryWrites: false`; keep it in
  `DatabaseModule`.
- `phone` and `openid` have unique indexes. Do not disable/remove `autoIndex`
  until index creation moves to a migration script.

**Adding a tool module**

1. Create `src/modules/<tool>/` with module/controller/service/schema/dto.
2. Register the schema with `MongooseModule.forFeature` and the module in
   `AppModule.imports`.
3. Scope every query by the authenticated `userId` from `@CurrentUser()`.
4. Add focused service unit tests with mocked models — no database in unit tests.

## Deployment rules and traps

- **App Service Free (F1)** has hard limits: 60 CPU minutes/day, no Always On,
  no custom domains, `WP stop requests` ~15/day, health probes disabled by the
  template. Keep `use32BitWorkerProcess` out of `siteConfig` (Free rejects it).
  Upgrading to B1 is required before releasing the mini program.
- **Oryx build needs devDependencies**. `NODE_ENV=production` makes npm omit
  them, so the template sets `NPM_CONFIG_PRODUCTION=false`. Without it
  `nest build` fails with `nest: not found`.
- **Do not add `appCommandLine: 'npm start'`** back. App Service already runs
  `npm start` once `package.json` exists; the explicit command makes the site
  crash before the first deployment while `wwwroot` is empty.
- **Deploy scripts compile Bicep locally.** Do not reintroduce a dependency on
  `az bicep` (it downloads from GitHub Releases, which is blocked on some
  networks). `install-bicep.ps1` installs Bicep from NuGet instead.
- **PowerShell 5.1 zip pitfall**: `Compress-Archive` writes backslash entry
  names, which Linux unpacks as flat filenames. Use `New-ZipPackage` in
  `deploy.ps1` (System.IO.Compression with `/` separators). Do not re-add
  `Set-StrictMode` to deploy scripts — it conflicts with npm stderr handling.
- **Secrets**:
  - `.secrets/weixin.txt` (WECHAT_APP_ID / WECHAT_APP_SECRET) and
    `.secrets/mongo-connection-string.txt` are auto-read by `deploy.ps1`.
  - Precedence for WeChat credentials: process env > file > interactive prompt.
  - `.secrets/` is gitignored; never print values or commit `.env`/`.secrets`.
  - App Service app settings are readable by anyone with portal read access;
    moving secrets to Key Vault is a planned follow-up.
- CI/CD targets `vars.AZURE_WEBAPP_NAME` and uses OIDC secrets
  `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID`.
- OIDC subjects depend on the repository's immutable-subject setting: repos
  created after 2026-07-15 use
  `repo:OWNER@OWNER-ID/REPO@REPO-ID:environment:ENV` (and `:ref:refs/heads/main`).
  `setup-oidc.ps1` auto-detects the IDs; don't hand-write legacy subjects.
- The deploy workflow only triggers for app-code paths (or manual
  `workflow_dispatch`), deliberately skipping docs-only pushes to save F1
  quota. It verifies `/api/health` after deploying and fails on a non-200.
- Deployment failures and quota issues are documented in the README
  troubleshooting section; add new recurring failure modes there.

## Don't

- Don't require `getPhoneNumber` for the default login path — personal-subject
  mini programs cannot use it. Keep `/auth/wechat-login` as the default.
- Don't make `phone` required again or drop the sparse index options; that
  breaks openid-only accounts.
- Don't trust client-provided phone numbers in WeChat flows or treat any phone
  as verified. The invite-gated password path may persist a self-asserted phone
  as an account identifier; WeChat IDs remain untrusted everywhere.
- Don't add broad e2e suites that require a live database; unit tests should
  stay hermetic and e2e stays opt-in via `MONGODB_URI`.
- Don't deploy with placeholder WeChat credentials or a test JWT secret.
- Don't commit build output (`dist/`), logs or local environment files.