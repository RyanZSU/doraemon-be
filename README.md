# doraemon-be

微信小程序「家用百宝箱」的后端服务。首批功能是**微信登录 + 用户资料**，后续以模块方式陆续加入打卡、日记等小工具。

- **技术栈**：NestJS 12（TypeScript，ESM）+ Mongoose 9 + JWT
- **数据库**：Azure DocumentDB（MongoDB vCore，原 Azure Cosmos DB for MongoDB vCore）
- **部署**：Azure App Service（Linux，Node 24 LTS）+ Bicep + GitHub Actions（OIDC）
- **本地**：Node.js 24 LTS（≥ 22.22.3，见 `.nvmrc`）、npm；可选 Docker（本地 MongoDB）

## 架构

```
微信小程序
  │  wx.login() -> code
  ▼
POST /api/auth/wechat-login         ← 默认：静默登录，个人主体小程序可用
  │
  ├─ jscode2session(code)           -> openid / unionid
  ├─ users 集合按 openid find-or-create（无需手机号）
  └─ 签发 JWT (7d)
  ▼
NestJS on Azure App Service ──► Azure DocumentDB (MongoDB vCore)
                                mongodb+srv://...mongocluster.cosmos.azure.com

可选：POST /api/auth/login（组织主体 + 已开通「获取手机号」权限）
  code + phoneCode -> stable_token + getuserphonenumber -> 服务端换取真实手机号
                    -> 按手机号 find-or-create 并绑定 openid
```

**为什么默认走 openid 静默登录**：微信的 `getPhoneNumber` 能力只对完成认证的组织主体开放，个人主体小程序无法调用。个人自用场景下 openid 已足够作为账号标识。手机号登录接口保留给后续升级为企业主体时使用。

**为什么手机号必须由服务端获取**：小程序前端能拿到用户输入的任意内容，只有 `phoneCode` + 后端调用微信 `getuserphonenumber` 才能得到微信验证过的手机号。本项目不接受前端直接上传的手机号。

## 目录结构

```
src/
  main.ts                      启动、全局前缀、Swagger、trust proxy
  app.module.ts                全局守卫 / 响应包装 / 异常过滤器
  config/env.validation.ts     环境变量校验（Joi，启动即失败）
  database/database.module.ts  MongoDB 连接（全局）
  common/
    decorators/                @Public()、@CurrentUser()
    guards/jwt-auth.guard.ts   全局 JWT 守卫
    interceptors/              统一响应 { code, message, data, requestId }
    filters/                   统一异常响应
    middleware/request-id      X-Request-Id 透传/生成
  modules/
    auth/                      微信登录、access_token 缓存、JWT 策略
    users/                     用户资料、User Schema
    health/                    /api/health（含 Mongo ping）、/api/health/live
deploy/
  main.bicep                   资源组级入口
  modules/                     App Service、DocumentDB 集群
  params/dev.bicepparam        从环境变量读取密钥
  scripts/deploy.ps1           一键创建资源 + 可选部署代码
  scripts/create-free-mongo.ps1 创建 DocumentDB Free Tier 集群并保存连接串
  scripts/install-bicep.ps1    从 NuGet 安装 Bicep CLI（GitHub 不可达时可用）
  scripts/setup-oidc.ps1       配置 GitHub Actions OIDC
.github/workflows/             CI（lint/test/build）与部署
```

## 本地开发

```powershell
# 1. 依赖
npm ci

# 2. 配置环境变量
Copy-Item .env.example .env
# 编辑 .env：JWT_SECRET（≥32 字符）、WECHAT_APP_ID、WECHAT_APP_SECRET
# 本地无 Azure 数据库时，启动 MongoDB：
docker compose up -d

# 3. 启动
npm run start:dev
```

- Swagger：<http://localhost:3000/docs>（需 `SWAGGER_ENABLED=true`）
- 健康检查：`GET /api/health/live`、`GET /api/health`

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run start:dev` | 开发模式（watch） |
| `npm run build` | 编译到 `dist/` |
| `npm start` | 运行编译产物（App Service 使用） |
| `npm test` | 单元测试（Vitest，不需要数据库） |
| `npm run test:e2e` | e2e（需要 `MONGODB_URI`，否则自动跳过） |
| `npm run lint` | oxlint（类型感知） |

## API

所有响应统一包装：

```json
// 成功
{ "code": 0, "message": "ok", "data": { }, "requestId": "...", "timestamp": "..." }
// 失败：code 等于 HTTP 状态码
{ "code": 401, "message": "Unauthorized", "data": null, "requestId": "...", "timestamp": "..." }
```

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api` | 否 | 服务信息 |
| POST | `/api/auth/wechat-login` | 否 | **默认**：openid 静默登录/注册，返回 JWT |
| POST | `/api/auth/login` | 否 | 可选：手机号登录/注册（需组织主体 + 手机号权限） |
| GET | `/api/users/me` | Bearer | 当前用户资料 |
| PATCH | `/api/users/me` | Bearer | 更新昵称、头像、自填微信号 |
| GET | `/api/health/live` | 否 | 存活检查（不查库） |
| GET | `/api/health` | 否 | 就绪检查（Mongo ping，失败返回 503） |

### 登录请求（默认：静默登录）

```json
POST /api/auth/wechat-login
{
  "code": "wx.login() 返回的 code",
  "nickname": "可选",
  "avatarUrl": "可选",
  "wechatId": "可选，用户自填"
}
```

后端用 `jscode2session` 换取 openid，按 openid find-or-create，不依赖任何手机号能力，个人主体小程序可用。

### 登录请求（可选：手机号登录）

```json
POST /api/auth/login
{
  "code": "wx.login() 返回的 code",
  "phoneCode": "getPhoneNumber 回调返回的 code",
  "nickname": "可选",
  "avatarUrl": "可选，微信返回的是临时链接，建议前端及时转存",
  "wechatId": "可选，用户自填；微信接口不提供微信号"
}
```

两个接口响应 `data` 一致：`accessToken`、`tokenType`、`expiresIn`、`isNewUser`、`user`（`user.phone` 与 `user.openid` 都可能为 `null`）。后续请求带上 `Authorization: Bearer <accessToken>`。

### 账号规则

- 默认账号标识是 **openid**（sparse unique），来自服务端 `jscode2session`，前端无法伪造。
- `phone` 可选（sparse unique，索引名 `phone_sparse_unique`），仅手机号登录时由微信 `getuserphonenumber` 验证后写入。启动时 `UserIndexService.syncIndexes()` 会把旧版本非 sparse 的 `phone_1` 索引迁移掉，避免多个无手机号账号互相冲突。
- 同一 openid 静默登录始终命中同一账号；手机号登录时，openid 会从旧手机号账号解绑并绑到新账号。
- 微信号（WeChat ID）微信官方接口不返回，只能由用户自填，不能作为身份依据。
- 手机号属于个人敏感信息，生产环境建议评估加密存储、日志脱敏与合规要求。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | 否 | `development` | `development` / `test` / `production` |
| `PORT` | 否 | `3000` | App Service 会自动注入 |
| `MONGODB_URI` | 是 | – | `mongodb://` 或 `mongodb+srv://` |
| `MONGO_DB_NAME` | 否 | `doraemon` | 数据库名 |
| `JWT_SECRET` | 是 | – | ≥ 32 字符，`openssl rand -base64 48` |
| `JWT_EXPIRES_IN_SECONDS` | 否 | `604800` | JWT 有效期 |
| `WECHAT_APP_ID` | 是 | – | 小程序 AppID |
| `WECHAT_APP_SECRET` | 是 | – | 小程序 AppSecret |
| `WECHAT_API_TIMEOUT_MS` | 否 | `5000` | 微信接口超时 |
| `SWAGGER_ENABLED` | 否 | `false` | 生产务必关闭 |

## 部署到 Azure

### 0. 前置

- Azure 订阅；`az login` 已登录。
- 安装 Azure CLI：

```powershell
winget install --id Microsoft.AzureCLI -e
```

- 安装 Bicep CLI（部署脚本在本地编译 Bicep，不依赖 `az bicep`）：

```powershell
.\deploy\scripts\install-bicep.ps1
```

- 准备微信小程序 `AppID` / `AppSecret`。可以写入 `.secrets/weixin.txt`（已 gitignore，支持 `KEY: VALUE`、`KEY=VALUE` 或 JSON 对象）：

  ```
  WECHAT_APP_ID: wx...
  WECHAT_APP_SECRET: ...
  ```

  部署脚本的读取优先级：环境变量 > `.secrets/weixin.txt` > 交互输入（AppSecret 隐藏）。
- **区域选择**：应用和数据库放在同一区域。面向中国大陆用户的微信接口，`eastasia`（香港）或 `japaneast` 延迟通常更低。Azure 全球版到 `api.weixin.qq.com` 可直连；Azure 中国区是独立订阅/云环境，需单独评估。
- **Free Tier 区域限制**：DocumentDB 免费层目前仅支持部分区域，亚太区为 **East Asia、Japan East、Japan West**（另有澳洲、印度等）。**Southeast Asia 不在免费层支持列表中**；如果坚持部署到 Southeast Asia，数据库必须使用付费档。

### 1. 部署（选择一种方式）

#### 方式 A：复用 DocumentDB Free Tier 连接串（当前推荐）

1. 创建免费层集群（二选一，每订阅一个，32 GB，免费层 60 天无活动会暂停）：

```powershell
# 自动创建（East Asia，禁用 HA，开放 Azure 服务防火墙）
# 需要先运行 install-bicep.ps1；连接串会写入 .secrets/mongo-connection-string.txt
.\deploy\scripts\create-free-mongo.ps1 -ResourceGroup rg-doraemon-be-dev -Location eastasia
```

也可以在 Azure 门户创建 **Azure DocumentDB Free Tier**，Networking 中允许 Azure 服务访问（`0.0.0.0` 规则），然后复制完整 `mongodb+srv://...` 串。

2. 运行：

```powershell
# 默认：应用 + 复用已有数据库。存在 .secrets/mongo-connection-string.txt 时自动使用，否则隐藏输入。
# 微信凭据优先读取 .secrets/weixin.txt，找不到才交互输入。
.\deploy\scripts\deploy.ps1 -DeployCode -Location eastasia
```

脚本会：
1. 创建资源组（默认 `rg-doraemon-be-dev`）
2. 部署 Bicep：App Service Plan（默认 B1，可用 `-UseFreeAppServicePlan` 换成 F1）、Web App（Node 24 LTS），不创建数据库
3. 把外部连接串、JWT 密钥、微信凭据写入 App Service 配置
4. `-DeployCode` 时打包并通过 Zip 部署；App Service 的 Oryx 构建会执行 `npm install && npm run build`，然后由平台默认执行 `npm start` 启动 `dist/main.js`。模板已设置 `NPM_CONFIG_PRODUCTION=false`，确保构建阶段安装 devDependencies（否则 `nest build` 会报 `nest: not found`）。

脚本先用本地 Bicep CLI 把 `.bicep`/`.bicepparam` 编译成 ARM JSON，再交给 `az`，因此不依赖 `az bicep`（后者会从 GitHub Releases 下载，某些网络下不可达）。部署前可先做一次预检（不部署资源；资源组不存在时会先创建）：

```powershell
.\deploy\scripts\deploy.ps1 -ValidateOnly -UseFreeAppServicePlan -Location eastasia
```

#### 方式 B：Bicep 创建付费 DocumentDB 集群

```powershell
# 创建 M10 / 32GB 付费集群（可加 -Location southeastasia）
.\deploy\scripts\deploy.ps1 -CreateMongoCluster -DeployCode -Location eastasia
```

`JWT_SECRET` 与 `MONGO_ADMIN_PASSWORD` 未设置时会自动生成并打印一次；微信凭据按「环境变量 > `.secrets/weixin.txt` > 交互输入」读取。也可以提前设置同名环境变量，或直接传 `-MongoConnectionString '<url>'`（会进入命令行历史，不推荐）。

#### 方式 C：App Service 也用 Free（F1）

```powershell
# 复用免费层数据库 + 免费层 App Service（当前阶段最省钱）
.\deploy\scripts\deploy.ps1 -DeployCode -Location eastasia -UseFreeAppServicePlan
```

F1 的关键限制：

- **60 CPU 分钟/天**，用完后当天不再提供服务；1 GB 内存，单实例，无自动伸缩。
- **不支持 Always On**：闲置约 20 分钟后应用会卸载，下一次请求触发冷启动（Nest 启动 + Mongo 连接通常数秒）。
- **自定义域名为 0**：只能访问 `*.azurewebsites.net`。小程序正式版要求已备案的合法域名，而 `azurewebsites.net` 无法完成大陆备案，所以 **上架前必须升级**（开发/调试阶段可在开发者工具里临时勾选“不校验合法域名”）。
- Health check 在 Free 档可用，但没有实例替换能力；本模板在 F1 下会自动关闭 `healthCheckPath`，避免每分钟探测反复唤醒应用、消耗 CPU 配额。
- 免费层的「WP stop requests」约为 **15 次/天**；反复部署失败或站点反复重启会触发 `QuotaExceeded`，此时可等待 UTC 零点重置，或删除重建 App Service（数据库不受影响）。
- 无备份、无部署槽位、无 VNet 集成。

适合开发、体验版调试和小流量自用。正式发布前去掉 `-UseFreeAppServicePlan` 重新执行一次部署即可原地升级到 B1，数据库连接串和代码都不用变。

资源命名默认 `<appName>-<env>-<hash>`；可用参数文件覆盖。费用参考：App Service B1（约 $13/月）+ M10 DocumentDB 是最低付费组合；F1 + DocumentDB Free Tier 可做到零费用。

### 2. 验证

```powershell
curl https://<app>.azurewebsites.net/api/health/live
curl https://<app>.azurewebsites.net/api/health
```

健康检查接口始终可用：`/api/health` 在数据库不可用时返回 503。B1 及以上档位会把 `/api/health` 配置为 App Service 健康探测；F1 下不配置，避免探测反复唤醒应用、消耗 CPU 配额。

### 3. 配置 GitHub Actions（OIDC，无长期密钥）

先把代码推到 GitHub 仓库，然后：

```powershell
.\deploy\scripts\setup-oidc.ps1 -GitHubRepository <owner/repo> -ResourceGroup rg-doraemon-be-dev
```

脚本创建 Entra 应用 + 服务主体 + 联合凭据（分支 `main` 与环境 `production`），并授予资源组级 **Website Contributor**。

> GitHub 自 2026-07-15 起对新仓库使用**不可变 OIDC subject**（`repo:OWNER@OWNER-ID/REPO@REPO-ID:...`）。脚本会通过 GitHub API 自动获取 owner/repo ID；私有仓库需先设置 `GITHUB_TOKEN`，或显式传 `-GitHubOwnerId` / `-GitHubRepositoryId`。2026-07-15 之前创建且未启用不可变 subject 的仓库，加 `-LegacySubject`。

然后按输出设置 GitHub：

- Secrets：`AZURE_CLIENT_ID`、`AZURE_TENANT_ID`、`AZURE_SUBSCRIPTION_ID`
- Variable：`AZURE_WEBAPP_NAME`（deploy.ps1 输出）

之后推送 `main` 且改动命中 `src/**`、`package*.json`、`tsconfig*.json`、`nest-cli.json` 或 `.github/workflows/deploy.yml` 时会自动部署。纯文档/部署脚本的推送只跑 CI，不会重启应用（F1 的 CPU 与停止配额有限）；需要时可在 GitHub Actions 页面手动运行 **Deploy to Azure App Service → Run workflow**。

部署流程：安装依赖 + lint + 单测 + 构建 → 上传产物 → 检查 secrets/variables → OIDC 登录 → Zip 部署 → 轮询 `/api/health`，3 分钟内未就绪则 workflow 失败。`AZURE_WEBAPP_NAME` 未配置时会在部署前给出明确报错。

### 4. 小程序侧配置

- `wx.request` 的合法域名必须是 **HTTPS**，不能带端口；把它指向 App Service 的域名或绑定到 App Service 的自定义域名。
- 若使用默认的 `*.azurewebsites.net` 域名，中国大陆主体的小程序域名备案通常无法通过；建议在 App Service 绑定自有域名并完成备案。
- 登录页调用 `wx.login()`，把 code 发给 `/api/auth/wechat-login`（静默登录）。若后续升级为组织主体并开通手机号权限，可切到 `/api/auth/login` + `getPhoneNumber`。
- 前端工程在 `doraemon-app/`，`utils/config.js` 已写入当前 App Service 域名；也可在小程序「我的 → 服务设置」里随时修改。

### 5. 常见部署问题

- **`QuotaExceeded`（F1）**：通常是「WP stop requests」超限（约 15 次/天），由反复部署失败/重启导致。等待 UTC 零点重置，或删除重建 App Service；数据库不受影响。
- **Oryx 报 `nest: not found`**：构建阶段没有安装 devDependencies。保持 App Service 配置 `NPM_CONFIG_PRODUCTION=false`（模板已设置）。
- **部署成功后短暂返回 404 / 默认欢迎页**：F1 冷启动或站点重启中，等待 10–60 秒再请求 `/api/health/live`。若持续如此，查看部署日志确认 `src/` 是否进入 wwwroot。
- **`az` 报 `Status_NoNetwork`**：本机 Azure CLI 登录态需要刷新，重新执行 `az login`；用 `curl https://management.azure.com/` 可区分网络问题。
- **小程序调用失败**：确认 App Service 的 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 是真实值（占位值会让 `/api/auth/login` 返回 502），以及 DocumentDB 防火墙允许 Azure 服务访问。

## 新增一个工具模块

以「打卡」为例：

1. `src/modules/checkin/` 下创建 `checkin.module.ts`、`checkin.controller.ts`、`checkin.service.ts`、`schemas/checkin.schema.ts`、`dto/`。
2. 在模块里 `MongooseModule.forFeature([{ name: Checkin.name, schema: CheckinSchema }])`。
3. Controller 用 `@CurrentUser()` 取当前用户 `userId`，作为所有业务数据的归属字段。
4. 在 `AppModule.imports` 注册模块。
5. 写针对 service 的 Vitest 单元测试（mock Model），不需要真实数据库。
6. 默认所有路由都需要 Bearer Token；只有明确公开的接口才加 `@Public()`。

## 已知限制 / 后续工作

- **密钥管理**：生产初期密钥存放在 App Service 配置（门户可读）。下一步建议迁到 Azure Key Vault，用系统分配托管标识访问。
- **限流**：`/api/auth/login` 未限流，上线前建议加 `@nestjs/throttler` 或 App Service 前端限制。
- **索引迁移**：当前依赖 Mongoose 启动时 `autoIndex` 建索引；数据量变大后改为迁移脚本，并关闭 `autoIndex`。
- **日志与监控**：尚未接 Application Insights；App Service 日志流可先用。
- **手机号合规**：如需加密存储/脱敏，可在 User Schema 层用字段级加密或应用层加密。
- **多实例**：微信 access_token 目前按实例内存缓存（`stable_token` 已避免互相踢掉），多实例下只是多取几次 token，可后续换 Redis/分布式缓存。