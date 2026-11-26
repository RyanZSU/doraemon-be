# doraemon-be

微信小程序「家用百宝箱」的后端服务。首批功能是**微信登录 + 用户资料**，后续以模块方式陆续加入打卡、日记等小工具。

- **技术栈**：NestJS 12（TypeScript，ESM）+ Mongoose 9 + JWT
- **数据库**：Azure DocumentDB（MongoDB vCore，原 Azure Cosmos DB for MongoDB vCore）
- **部署**：Azure App Service（Linux，Node 24 LTS）+ Bicep + GitHub Actions（OIDC）
- **本地**：Node.js ≥ 22.22.3、npm；可选 Docker（本地 MongoDB）

## 架构

```
微信小程序
  │  wx.login() -> code
  │  open-type="getPhoneNumber" -> phoneCode
  ▼
POST /api/auth/login
  │
  ├─ jscode2session(code)               -> openid / unionid
  ├─ stable_token + getuserphonenumber(phoneCode) -> 真实手机号（服务端换取）
  ├─ users 集合按手机号 find-or-create，绑定 openid
  └─ 签发 JWT (7d)
  ▼
NestJS on Azure App Service ──► Azure DocumentDB (MongoDB vCore)
                                mongodb+srv://...mongocluster.cosmos.azure.com
```

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
| POST | `/api/auth/login` | 否 | 微信登录/注册，返回 JWT |
| GET | `/api/users/me` | Bearer | 当前用户资料 |
| PATCH | `/api/users/me` | Bearer | 更新昵称、头像、自填微信号 |
| GET | `/api/health/live` | 否 | 存活检查（不查库） |
| GET | `/api/health` | 否 | 就绪检查（Mongo ping，失败返回 503） |

### 登录请求

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

响应 `data`：`accessToken`、`tokenType`、`expiresIn`、`isNewUser`、`user`。后续请求带上 `Authorization: Bearer <accessToken>`。

### 账号规则

- 用户标识是**手机号**，手机号由微信服务端接口验证。
- `openid` 全局唯一（sparse unique）。同一微信用户换手机号登录时，`openid` 会从旧账号解绑并绑到新手机号账号。
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
- 安装 Azure CLI（可选 Bicep CLI 用于本地校验）：

```powershell
winget install --id Microsoft.AzureCLI -e
```

- 准备微信小程序 `AppID` / `AppSecret`。
- **区域选择**：应用和数据库放在同一区域。面向中国大陆用户的微信接口，`eastasia`（香港）或 `japaneast` 延迟通常更低。Azure 全球版到 `api.weixin.qq.com` 可直连；Azure 中国区是独立订阅/云环境，需单独评估。
- **Free Tier 区域限制**：DocumentDB 免费层目前仅支持部分区域，亚太区为 **East Asia、Japan East、Japan West**（另有澳洲、印度等）。**Southeast Asia 不在免费层支持列表中**；如果坚持部署到 Southeast Asia，数据库必须使用付费档。

### 1. 部署（二选一）

#### 方式 A：复用 DocumentDB Free Tier 连接串（当前推荐）

1. 在 Azure 门户创建 **Azure DocumentDB Free Tier** 集群（每订阅一个，32 GB；选择 East Asia 或 Japan East），在 Networking 中允许 Azure 服务访问（`0.0.0.0` 防火墙规则），从「连接字符串」页复制完整 `mongodb+srv://...` 串。免费层 60 天无活动会自动暂停。
2. 运行：

```powershell
# 默认：应用 + 复用已有数据库；MONGODB_CONNECTION_STRING 会被隐藏输入
.\deploy\scripts\deploy.ps1 -DeployCode -Location eastasia
```

脚本会：
1. 创建资源组（默认 `rg-doraemon-be-dev`）
2. 部署 Bicep：App Service Plan（B1）、Web App（Node 24 LTS），不创建数据库
3. 把外部连接串、JWT 密钥、微信凭据写入 App Service 配置
4. `-DeployCode` 时打包并通过 Zip 部署；App Service 的 Oryx 构建会执行 `npm install && npm run build`，然后用 `npm start` 启动 `dist/main.js`

#### 方式 B：Bicep 创建付费 DocumentDB 集群

```powershell
# 创建 M10 / 32GB 付费集群（可加 -Location southeastasia）
.\deploy\scripts\deploy.ps1 -CreateMongoCluster -DeployCode -Location eastasia
```

`JWT_SECRET` 与 `MONGO_ADMIN_PASSWORD` 未设置时会自动生成并打印一次；微信凭据未设置时会交互式询问（AppSecret 隐藏输入）。也可以提前设置同名环境变量，或直接传 `-MongoConnectionString '<url>'`（会进入命令行历史，不推荐）。

资源命名默认 `<appName>-<env>-<hash>`；可用参数文件覆盖。费用参考：B1 App Service + M10 DocumentDB 是最低成本组合。

### 2. 验证

```powershell
curl https://<app>.azurewebsites.net/api/health/live
curl https://<app>.azurewebsites.net/api/health
```

App Service 已设置健康检查路径 `/api/health`，数据库不可用时返回 503。

### 3. 配置 GitHub Actions（OIDC，无长期密钥）

先把代码推到 GitHub 仓库，然后：

```powershell
.\deploy\scripts\setup-oidc.ps1 -GitHubRepository <owner/repo> -ResourceGroup rg-doraemon-be-dev
```

脚本创建 Entra 应用 + 服务主体 + 联合凭据（分支 `main` 与环境 `production`），并授予资源组级 **Website Contributor**。然后按输出设置 GitHub：

- Secrets：`AZURE_CLIENT_ID`、`AZURE_TENANT_ID`、`AZURE_SUBSCRIPTION_ID`
- Variable：`AZURE_WEBAPP_NAME`（deploy.ps1 输出）

之后推送 `main` 会触发 `.github/workflows/deploy.yml`：CI 校验 → 上传构建产物 → OIDC 登录 → Zip 部署。

### 4. 小程序侧配置

- `wx.request` 的合法域名必须是 **HTTPS**，不能带端口；把它指向 App Service 的域名或绑定到 App Service 的自定义域名。
- 若使用默认的 `*.azurewebsites.net` 域名，中国大陆主体的小程序域名备案通常无法通过；建议在 App Service 绑定自有域名并完成备案。
- 登录页同时调用 `wx.login()` 与 `<button open-type="getPhoneNumber">`，把两个 code 发给 `/api/auth/login`。

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