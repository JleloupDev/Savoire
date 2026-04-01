// infra/main.bicep — Point d'entrée principal du déploiement Azure
// Généré initialement par `azd infra synth`, puis personnalisé.
// DECISION: Scale-to-zero pour coût minimal en environnement dev.

targetScope = 'resourceGroup'

param location string = resourceGroup().location
param environmentName string

// Suffixe unique basé sur le resource group ID pour éviter les collisions de noms
var uniqueSuffix = uniqueString(resourceGroup().id)

// ── Container Registry (ACR) ─────────────────────────────────────────
// DECISION: ACR Basic SKU (~5€/mois) — nécessaire pour que azd push les images.
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acr${uniqueSuffix}'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: true
  }
}

// ── Storage Account (Azure Files pour SQLite) ────────────────────────
module storage 'storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    uniqueSuffix: uniqueSuffix
  }
}

// ── Container Apps Environment ───────────────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'logs-${environmentName}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: 'cae-${environmentName}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// DECISION: Storage monté comme ressource séparée (pas inline dans managedEnvironments)
resource sqliteStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: containerAppsEnvironment
  name: 'sqlite-storage'
  properties: {
    azureFile: {
      accountName: storage.outputs.storageAccountName
      accountKey: storage.outputs.storageAccountKey
      shareName: storage.outputs.fileShareName
      accessMode: 'ReadWrite'
    }
  }
}

// ── Container App : API ──────────────────────────────────────────────
resource apiApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'api-${environmentName}'
  location: location
  tags: { 'azd-service-name': 'api' }
  dependsOn: [sqliteStorage]
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      // DECISION: admin credentials ACR pour pull d'image (plus simple que managed identity pour le POC)
      registries: [
        {
          server: acr.properties.loginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
      ]
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
      }
    }
    template: {
      scale: {
        // DECISION: minReplicas 1 pendant les tests POC pour éviter le cold-start > 60s qui cause 502 nginx.
        // Remettre à 0 après validation pour économiser (~0.50€/jour).
        minReplicas: 1
        maxReplicas: 1    // un seul replica en dev
      }
      containers: [
        {
          name: 'api'
          // DECISION: Image placeholder pour la provision initiale.
          // azd deploy remplacera par l'image buildée.
          image: 'mcr.microsoft.com/k8se/quickstart:latest'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            // DECISION: Storage__Root doit pointer vers le volume monté Azure Files.
            { name: 'Storage__Root', value: '/data' }
            { name: 'ASPNETCORE_HTTP_PORTS', value: '8080' }
            // DECISION: SQLite sur stockage éphémère — SMB (Azure Files) ne supporte pas le locking SQLite.
            { name: 'Database__Path', value: '/tmp/metadata.db' }
            // DECISION: FQDN calculé depuis defaultDomain de l'environment pour éviter la dépendance circulaire webApp→apiApp.
            { name: 'AllowedOrigins__0', value: 'https://web-${environmentName}.${containerAppsEnvironment.properties.defaultDomain}' }
          ]
          volumeMounts: [
            {
              volumeName: 'sqlite-vol'
              mountPath: '/data'
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'sqlite-vol'
          storageType: 'AzureFile'
          storageName: 'sqlite-storage'
        }
      ]
    }
  }
}

// ── Container App : Web ──────────────────────────────────────────────
resource webApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'web-${environmentName}'
  location: location
  tags: { 'azd-service-name': 'web' }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      registries: [
        {
          server: acr.properties.loginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
      ]
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
      }
    }
    template: {
      scale: {
        // DECISION: minReplicas 1 pendant les tests POC pour éviter le cold-start → 503 Envoy.
        minReplicas: 1
        maxReplicas: 1    // un seul replica en dev
      }
      containers: [
        {
          name: 'web'
          // DECISION: Image placeholder pour la provision initiale.
          image: 'mcr.microsoft.com/k8se/quickstart:latest'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            // DECISION: nginx lit API_URL au démarrage via envsubst pour
            // proxifier /api et /hubs vers l'API — pas de rebuild nécessaire.
            { name: 'API_URL', value: 'https://${apiApp.properties.configuration.ingress.fqdn}' }
          ]
        }
      ]
    }
  }
}

// ── Outputs ──────────────────────────────────────────────────────────
output apiUrl string = 'https://${apiApp.properties.configuration.ingress.fqdn}'
output webUrl string = 'https://${webApp.properties.configuration.ingress.fqdn}'
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = acr.properties.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = acr.name
