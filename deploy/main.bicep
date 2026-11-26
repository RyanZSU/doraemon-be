targetScope = 'resourceGroup'

@description('Deployment environment name, e.g. dev / staging / prod.')
@minLength(1)
@maxLength(12)
param environment string = 'dev'

@description('Azure region for the app and database. Pick a region close to your WeChat users (e.g. eastasia or japanEast) and keep app + database in the same region.')
param location string = resourceGroup().location

@description('Base name used to derive resource names.')
@minLength(3)
@maxLength(30)
param appName string = 'doraemon-be'

@description('Globally unique App Service name (3-60 chars, lowercase letters, numbers, hyphens).')
param webAppName string = '${toLower(appName)}-${environment}-${uniqueString(resourceGroup().id)}'

@description('Globally unique DocumentDB (MongoDB vCore) cluster name (3-63 chars, lowercase letters, numbers, hyphens).')
param mongoClusterName string = '${toLower(appName)}-${environment}-${uniqueString(resourceGroup().id)}'

@description('App Service plan SKU name. B1 (Basic) is the cheapest tier that supports Always On; F1 does not.')
param appServiceSkuName string = 'B1'

@description('App Service plan SKU tier matching appServiceSkuName: Basic for B*, Standard for S*, PremiumV3 for P*v3.')
param appServiceSkuTier string = 'Basic'

@description('Create the DocumentDB cluster in this deployment. Set false when using a free-tier cluster created in the Azure portal (one per subscription, limited regions).')
param provisionMongoCluster bool = true

@description('DocumentDB compute tier, e.g. M10 (smallest paid tier) or M30. Free tier clusters are currently created from the portal.')
param mongoComputeTier string = 'M10'

@secure()
@description('Existing MongoDB connection string (e.g. from a free-tier DocumentDB cluster). Required when provisionMongoCluster is false.')
param externalMongoConnectionString string = ''

@description('DocumentDB storage size in GB (32 GB minimum).')
@minValue(32)
param mongoStorageSizeGb int = 32

@description('MongoDB wire protocol version exposed by the cluster.')
@allowed(['7.0', '8.0'])
param mongoServerVersion string = '8.0'

@description('Enable zone-redundant high availability for the database (recommended for production, costs more).')
param mongoHighAvailability bool = false

@description('Allow connections from Azure services via the cluster firewall (App Service has no fixed outbound IP on shared tiers).')
param allowAzureServices bool = true

@description('Database administrator username.')
@minLength(1)
@maxLength(63)
param administratorLogin string = 'doraemonadmin'

@secure()
@description('Database administrator password. Only used when provisionMongoCluster is true.')
param administratorPassword string = ''

@secure()
@description('JWT signing secret (at least 32 characters).')
@minLength(32)
param jwtSecret string

@description('WeChat mini program AppID.')
@minLength(1)
param wechatAppId string

@secure()
@description('WeChat mini program AppSecret.')
@minLength(1)
param wechatAppSecret string

@description('MongoDB database name used by the app.')
param mongoDatabaseName string = 'doraemon'

module mongo 'modules/mongoCluster.bicep' = if (provisionMongoCluster) {
  name: 'mongoCluster'
  params: {
    name: mongoClusterName
    location: location
    administratorLogin: administratorLogin
    administratorPassword: administratorPassword
    serverVersion: mongoServerVersion
    computeTier: mongoComputeTier
    storageSizeGb: mongoStorageSizeGb
    highAvailability: mongoHighAvailability
    allowAzureServices: allowAzureServices
  }
}

module appService 'modules/appService.bicep' = {
  name: 'appService'
  params: {
    webAppName: webAppName
    location: location
    skuName: appServiceSkuName
    skuTier: appServiceSkuTier
    environment: environment
    mongoClusterName: mongoClusterName
    mongoAdministratorLogin: administratorLogin
    mongoAdministratorPassword: administratorPassword
    mongoDatabaseName: mongoDatabaseName
    externalMongoConnectionString: externalMongoConnectionString
    jwtSecret: jwtSecret
    wechatAppId: wechatAppId
    wechatAppSecret: wechatAppSecret
  }
}

output webAppName string = webAppName
output webAppUrl string = 'https://${appService.outputs.defaultHostName}'
output healthCheckUrl string = 'https://${appService.outputs.defaultHostName}/api/health/live'
output mongoClusterName string = provisionMongoCluster ? mongoClusterName : 'external (not created by this deployment)'