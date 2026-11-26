using '../main.bicep'

// Secrets are read from the environment so they never land in the repo.
// The deploy script checks/generates them before running:
//   MONGO_ADMIN_PASSWORD, JWT_SECRET, WECHAT_APP_ID, WECHAT_APP_SECRET
param environment = 'dev'
param location = readEnvironmentVariable('AZURE_LOCATION', 'eastasia')
param appName = 'doraemon-be'

// B1/Basic by default; the deploy script can set F1/Free via -UseFreeAppServicePlan.
param appServiceSkuName = readEnvironmentVariable('APP_SERVICE_SKU', 'B1')
param appServiceSkuTier = readEnvironmentVariable('APP_SERVICE_TIER', 'Basic')

// Paid mode: also creates the DocumentDB cluster.
param provisionMongoCluster = true
param mongoComputeTier = 'M10'
param mongoStorageSizeGb = 32
param mongoHighAvailability = false

param administratorLogin = 'doraemonadmin'
param administratorPassword = readEnvironmentVariable('MONGO_ADMIN_PASSWORD')
param jwtSecret = readEnvironmentVariable('JWT_SECRET')
param wechatAppId = readEnvironmentVariable('WECHAT_APP_ID')
param wechatAppSecret = readEnvironmentVariable('WECHAT_APP_SECRET')