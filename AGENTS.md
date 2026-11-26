# AGENTS.md

Guidance for coding agents working in this repository. Setup, API contract and
deployment instructions live in [README.md](README.md); this file records the
rules, invariants and environment traps that are easy to get wrong.

## Project

- NestJS 12 backend for a WeChat mini program ("家用百宝箱"), TypeScript (ESM),
  Mongoose 9, JWT auth.
- Users log in with WeChat; the **server-verified phone number** is the account
  identity. Each future tool (check-in, diary, …) is added as a module.
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
src/modules/auth/               WeChat login, access_token cache, JWT strategy
src/modules/users/              user profile + User schema
src/modules/health/             /api/health (Mongo ping), /api/health/live
deploy/                         Bicep, parameter files, deploy/OIDC scripts
```

## Invariants

**Identity and auth**

- Never accept a phone number from the client. The phone must come from
  `phoneCode` → WeChat `getuserphonenumber` on the server. `AuthService.login`
  already enforces this.
- Never store or return `session_key`; it is not needed.
- `openid` is unique (sparse index). When a WeChat user logs in with a different
  phone, the openid is detached from the old account before being bound to the
  new one. Keep that behaviour.
- `wechatId` is self-reported; it is not an identity and cannot be verified.
- All routes require a Bearer JWT unless explicitly marked `@Public()`. Add
  `@Public()` only for endpoints that genuinely need anonymous access.
- The JWT payload is `{ sub: userId, phone }`; `@CurrentUser()` exposes it.

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
- The deploy workflow only triggers for app-code paths (or manual
  `workflow_dispatch`), deliberately skipping docs-only pushes to save F1
  quota. It verifies `/api/health` after deploying and fails on a non-200.
- Deployment failures and quota issues are documented in the README
  troubleshooting section; add new recurring failure modes there.

## Don't

- Don't change the phone-as-identity model without an explicit product decision.
- Don't trust or persist client-provided phone numbers or WeChat IDs.
- Don't add broad e2e suites that require a live database; unit tests should
  stay hermetic and e2e stays opt-in via `MONGODB_URI`.
- Don't deploy with placeholder WeChat credentials or a test JWT secret.
- Don't commit build output (`dist/`), logs or local environment files.