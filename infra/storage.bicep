// infra/storage.bicep — Azure Files pour SQLite + configuration Storage Account
// DECISION: Standard_LRS suffisant pour un environnement dev.
// Le share SQLite est limité à 1 Go (largement suffisant pour le POC).

param location string = resourceGroup().location
param uniqueSuffix string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'vltstr${uniqueSuffix}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource sqliteShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: 'sqlite-data'
  properties: {
    shareQuota: 1    // 1 Go suffisant pour SQLite en dev
  }
}

output storageAccountName string = storageAccount.name
output storageAccountKey string = storageAccount.listKeys().keys[0].value
output fileShareName string = sqliteShare.name
