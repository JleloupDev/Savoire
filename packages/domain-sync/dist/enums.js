export var ReplicationMode;
(function (ReplicationMode) {
    ReplicationMode["LocalOnly"] = "local_only";
    ReplicationMode["RemoteOnly"] = "remote_only";
    ReplicationMode["Bidirectional"] = "bidirectional";
})(ReplicationMode || (ReplicationMode = {}));
export var ConnectivityState;
(function (ConnectivityState) {
    ConnectivityState["Offline"] = "offline";
    ConnectivityState["Connecting"] = "connecting";
    ConnectivityState["Online"] = "online";
})(ConnectivityState || (ConnectivityState = {}));
export var SyncState;
(function (SyncState) {
    SyncState["NotInitialized"] = "not_initialized";
    SyncState["InSync"] = "in_sync";
    SyncState["LocalPending"] = "local_pending";
    SyncState["Conflict"] = "conflict";
    SyncState["Error"] = "error";
})(SyncState || (SyncState = {}));
export var UpdateSource;
(function (UpdateSource) {
    UpdateSource["Local"] = "local";
    UpdateSource["Remote"] = "remote";
})(UpdateSource || (UpdateSource = {}));
//# sourceMappingURL=enums.js.map