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

// Free (F1) and Shared (D1) plans do not support Always On. They also have no
// custom domains, so they are suitable for development/trial only.
var supportsAlwaysOn = skuTier != 'Free' && skuTier != 'Shared'

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
      // No appCommandLine: App Service runs `npm start` automatically once
      // package.json has a start script, and serves the default page before the
      // first deployment. An explicit `npm start` fails while wwwroot is empty.
      // Do not set use32BitWorkerProcess here: Linux apps always run 64-bit, and
      // the Free plan rejects an explicit 64-bit worker setting
      // ("64 Bit worker processes cannot be used ... plan does not allow it").
      alwaysOn: supportsAlwaysOn
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      // On Free/Shared, health check probes can wake an unloaded app every
      // minute and burn the daily CPU quota, so only enable it with Always On.
      healthCheckPath: supportsAlwaysOn ? '/api/health' : null
      remoteDebuggingEnabled: false
      // Zip deployment with build automation runs npm install && npm run build
      // on the App Service build container (Oryx).
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        // NODE_ENV=production makes npm omit devDependencies, but Oryx needs
        // them to run `nest build`. Keep production mode off during the build;
        // runtime behavior is still driven by NODE_ENV=production.
        { name: 'NPM_CONFIG_PRODUCTION', value: 'false' }
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