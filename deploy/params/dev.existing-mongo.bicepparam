using '../main.bicep'

// App-only deployment: reuse an existing MongoDB / DocumentDB connection string
// (for example a free-tier cluster created in the Azure portal).
// The deploy script fills these environment variables:
//   AZURE_LOCATION, MONGODB_CONNECTION_STRING, JWT_SECRET, WECHAT_APP_ID, WECHAT_APP_SECRET
param environment = 'dev'
// Free tier is not available in every region (see README); East Asia and
// Japan East are the closest options for mainland China users.
param location = readEnvironmentVariable('AZURE_LOCATION', 'eastasia')
param appName = 'doraemon-be'

// B1/Basic by default; the deploy script can set F1/Free via -UseFreeAppServicePlan.
param appServiceSkuName = readEnvironmentVariable('APP_SERVICE_SKU', 'B1')
param appServiceSkuTier = readEnvironmentVariable('APP_SERVICE_TIER', 'Basic')

param provisionMongoCluster = false
param externalMongoConnectionString = readEnvironmentVariable('MONGODB_CONNECTION_STRING')

param jwtSecret = readEnvironmentVariable('JWT_SECRET')
param wechatAppId = readEnvironmentVariable('WECHAT_APP_ID')
param wechatAppSecret = readEnvironmentVariable('WECHAT_APP_SECRET')