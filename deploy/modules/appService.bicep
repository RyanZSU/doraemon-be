param webAppName string

param location string

param skuName string = 'B1'

param skuTier string = 'Basic'

param environment string = 'dev'

param mongoClusterName string

param mongoAdministratorLogin string

@secure()
param mongoAdministratorPassword string

param mongoDatabaseName string = 'doraemon'

@secure()
@description('Use an existing MongoDB connection string instead of building one from administratorLogin/clusterName (e.g. free-tier DocumentDB).')
param externalMongoConnectionString string = ''

@secure()
param jwtSecret string

param wechatAppId string

@secure()
param wechatAppSecret string

// Azure DocumentDB (MongoDB vCore) connection string. `retrywrites=false` is
// required by the service; TLS and SCRAM-SHA-256 are mandatory for vCore.
var mongoConnectionString = empty(externalMongoConnectionString) ? 'mongodb+srv://${mongoAdministratorLogin}:${uriComponent(mongoAdministratorPassword)}@${mongoClusterName}.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000' : externalMongoConnectionString

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${webAppName}-plan'
  location: location
  sku: {
    name: skuName
    tier: skuTier
    capacity: 1
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  tags: {
    environment: environment
    application: 'doraemon-be'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'npm start'
      // Node.js 24/26 require a 64-bit worker process.
      use32BitWorkerProcess: false
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/api/health'
      remoteDebuggingEnabled: false
      // Zip deployment with build automation runs npm install && npm run build
      // on the App Service build container (Oryx).
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'MONGODB_URI', value: mongoConnectionString }
        { name: 'MONGO_DB_NAME', value: mongoDatabaseName }
        { name: 'JWT_SECRET', value: jwtSecret }
        { name: 'JWT_EXPIRES_IN_SECONDS', value: '604800' }
        { name: 'WECHAT_APP_ID', value: wechatAppId }
        { name: 'WECHAT_APP_SECRET', value: wechatAppSecret }
        { name: 'SWAGGER_ENABLED', value: 'false' }
      ]
    }
  }
}

output defaultHostName string = webApp.properties.defaultHostName
output principalId string = webApp.identity.principalId