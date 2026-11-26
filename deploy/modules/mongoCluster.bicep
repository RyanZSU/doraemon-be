@description('Cluster name; used as the hostname prefix of the connection string.')
param name string

param location string

param administratorLogin string

@secure()
param administratorPassword string

@allowed(['7.0', '8.0'])
param serverVersion string = '8.0'

@description('Compute tier, e.g. M10, M20, M30, M40. See Azure DocumentDB pricing.')
param computeTier string = 'M10'

@minValue(32)
param storageSizeGb int = 32

param highAvailability bool = false

param allowAzureServices bool = true

resource cluster 'Microsoft.DocumentDB/mongoClusters@2026-06-01' = {
  name: name
  location: location
  properties: {
    administrator: {
      userName: administratorLogin
      password: administratorPassword
    }
    serverVersion: serverVersion
    storage: {
      sizeGb: storageSizeGb
    }
    compute: {
      tier: computeTier
    }
    sharding: {
      shardCount: 1
    }
    highAvailability: {
      targetMode: highAvailability ? 'ZoneRedundantPreferred' : 'Disabled'
    }
    publicNetworkAccess: 'Enabled'
  }
}

// 0.0.0.0 - 0.0.0.0 is the Azure-services firewall rule understood by
// DocumentDB. App Service shared tiers have no fixed outbound IPs, so this is
// the practical way to let the web app connect. Use Private Endpoints for a
// hardened production setup.
resource azureServicesFirewall 'Microsoft.DocumentDB/mongoClusters/firewallRules@2026-06-01' =
  if (allowAzureServices) {
    parent: cluster
    name: 'AllowAllAzureServices'
    properties: {
      startIpAddress: '0.0.0.0'
      endIpAddress: '0.0.0.0'
    }
  }

output name string = cluster.name