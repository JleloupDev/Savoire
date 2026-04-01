# Tests SignalR avec différents transports

## Contexte

Les tests E2E pour SignalR utilisent `WebApplicationFactory` qui ne supporte pas WebSockets en mode in-memory. Pour éviter les problèmes de timing intermittents causés par les tentatives de connexion WebSocket qui échouent, nous testons explicitement les deux transports alternatifs supportés :

- **Server-Sent Events (SSE)** : Mode push unidirectionnel basé sur HTTP streaming
- **Long Polling** : Mode requête/réponse avec polling régulier

## Configuration

La classe `SignalRTestClient` accepte maintenant un paramètre optionnel `HttpTransportType` :

```csharp
public SignalRTestClient(
    WebApplicationFactory<Program> factory, 
    string userId,
    Microsoft.AspNetCore.Http.Connections.HttpTransportType? transport = null)
```

Par défaut, si aucun transport n'est spécifié, **Server-Sent Events** est utilisé.

## Tests paramétrés

Les tests utilisant SignalR ont été convertis en `[Theory]` avec `[InlineData]` pour tester les deux transports :

### Exemple

```csharp
[Theory]
[InlineData(Microsoft.AspNetCore.Http.Connections.HttpTransportType.ServerSentEvents)]
[InlineData(Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling)]
public async Task MultiDevice_BidirectionalSync(HttpTransportType transport)
{
    await using var hubA = new SignalRTestClient(_server, AppFactory.TestUserId, transport);
    await using var hubB = new SignalRTestClient(_server, AppFactory.OtherUserId, transport);
    // ... reste du test
}
```

## Tests concernés

Les tests suivants testent maintenant les deux transports :

1. **M1-04** : `RealtimeEdit_BothClientsConverge_Under200ms`
   - Vérifie la latence de propagation des opérations
   - Doit être < 200ms pour les deux transports

2. **M1-05** : `OfflineEdit_MergedOnReconnect_NoDataLoss`
   - Vérifie la synchronisation après une édition hors-ligne
   - Test des deux transports pour s'assurer que InitDocument fonctionne

3. **M1-12** : `MultiDevice_BidirectionalSync`
   - Vérifie la synchronisation bidirectionnelle entre deux clients
   - Test complet de push d'opérations dans les deux sens

## Exécution des tests

Chaque test sera exécuté **deux fois** automatiquement par xUnit :
- Une fois avec Server-Sent Events
- Une fois avec Long Polling

Dans l'explorateur de tests, vous verrez :
```
✓ MultiDevice_BidirectionalSync(transport: ServerSentEvents)
✓ MultiDevice_BidirectionalSync(transport: LongPolling)
```

## Pourquoi pas WebSockets ?

WebSockets ne fonctionne pas avec `WebApplicationFactory` car :
- Il nécessite une vraie socket TCP
- `WebApplicationFactory` utilise un `HttpMessageHandler` in-memory
- Les tentatives de connexion WebSocket échouent et provoquent un fallback avec délai

Pour tester WebSockets en condition réelle, il faudrait :
- Démarrer le serveur sur un vrai port (ex: `Kestrel`)
- Utiliser de vrais clients HTTP au lieu de `WebApplicationFactory`
- Ce qui rendrait les tests plus lents et plus fragiles

## Avantages de cette approche

1. **Fiabilité** : Pas de tentatives WebSocket qui échouent
2. **Rapidité** : Tests exécutés en mémoire sans sockets réelles
3. **Couverture** : Les deux transports alternatifs sont testés
4. **Déterminisme** : Pas de problèmes de timing intermittents
