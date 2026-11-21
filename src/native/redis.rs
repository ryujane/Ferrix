//! Native Session adapter. Connections live exclusively on the Redis workers.

use std::sync::{
    Arc, Mutex as StdMutex, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;

use nsh_core::prelude::*;
use redis::IntoConnectionInfo;
use tokio::{
    runtime::Runtime,
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, oneshot, watch},
};

mod continuation;
mod create_key;
use create_key::CreateKeyOptions;
mod scan;
use super::security::{self, RedisTlsOptions};
mod cluster;
mod proxy;
mod sentinel;
mod ssh;
mod transport;
use proxy::RedisProxyOptions;
use ssh::{RedisSshOptions, SshHostKeyOptions};
use transport::Transport;
mod json;
mod strings;
use cluster::ClusterOptions;
use json::{JsonOptions, RedisJson};
pub(crate) use scan::RedisKeyScan;
use scan::{KeyScanOptions, RedisKeyPage};
use sentinel::SentinelOptions;
use strings::{RedisStringRange, RedisWrite, SetStringOptions, StringRangeOptions};
mod hashes;
pub(crate) use hashes::RedisHashScan;
use hashes::{RedisHashField, RedisHashPage};
mod sets;
use sets::RedisSetPage;
pub(crate) use sets::RedisSetScan;
mod keys;
use keys::{KeyInfoOptions, KeyMutation, RedisKeyInfo, RedisMutation, RenameKeyOptions};
mod lists;
use lists::{ListRangeOptions, RedisListPush, RedisListRange};
mod zsets;
use zsets::{RedisZSetMember, RedisZSetRange, ZSetRangeOptions};
mod metadata;
use metadata::{KeyInfoFields, RedisKeyInfoBatch};
mod collection_insert;
use collection_insert::{CollectionRowInsertOptions, RedisCollectionRowInsert};
mod collection_row;
use collection_row::{CollectionRowTarget, RedisCollectionRow};
mod streams;
use streams::{RedisStreamAppend, RedisStreamRange, StreamAppendOptions, StreamRangeOptions};
mod databases;
use databases::RedisDatabases;
mod metrics;
use metrics::RedisServerMetrics;
mod clients;
use clients::RedisClientList;
mod slowlog;
use slowlog::RedisSlowlog;
mod console;
mod export;
pub(crate) use console::RedisConsole;
use console::catalog::RedisCommandCatalog;
mod pubsub;
pub(crate) use pubsub::RedisPubSub;
use pubsub::RedisPublish;

/// Settings for one directly addressed Redis server. Credentials are runtime inputs only.
#[derive(Clone, JsObject)]
pub struct StandaloneOptions {
    /// DNS name or IP address, without a scheme, port or credentials.
    pub host: String,
    pub port: u32,
    pub username: Option<String>,
    pub password: Option<String>,
    /// Omit for plaintext; an object enables verified TLS using system roots or a custom CA.
    pub tls: Option<RedisTlsOptions>,
    /// Optional pinned SSH gateway. The Redis hostname is resolved by the gateway.
    pub ssh: Option<RedisSshOptions>,
    /// Optional SOCKS5 or HTTP CONNECT proxy, including the SSH first hop when enabled.
    pub proxy: Option<RedisProxyOptions>,
    /// Initial logical database; defaults to zero.
    pub database: Option<u32>,
    /// Connection setup deadline in milliseconds; defaults to 3000.
    pub connect_timeout_ms: Option<u32>,
    /// Total request deadline including queueing and recovery; defaults to 5000.
    pub operation_timeout_ms: Option<u32>,
    /// Delivered binary response budget, also the per-request binary admission cap.
    /// Defaults to 262144 bytes; accepts 1 through 1048576.
    pub max_response_bytes: Option<u32>,
}

/// Local context only. This does not establish that the server is reachable.
#[derive(JsObject)]
pub struct SessionInfo {
    pub mode: String,
    pub database: u32,
    pub generation: String,
    pub closed: bool,
}

/// A successful reachability check and the context in which it completed.
#[derive(JsObject)]
pub struct RedisPing {
    pub response: String,
    pub database: u32,
    pub generation: String,
}

/// Redis connection entry points. All network work runs on dedicated workers.
#[module]
pub struct Redis;

#[module]
impl Redis {
    /// Save the monitoring report as JSON using the native Save dialog. Cancellation returns null.
    pub async fn export_metrics_report(content: String) -> Result<Option<String>, JsError> {
        export::json(content, "ferrix-health-report.json", 4 * 1024 * 1024).await
    }

    /// Export a bounded JSON log to a file chosen in the native Save dialog. Cancellation returns null.
    pub async fn export_pub_sub_logs(content: String) -> Result<Option<String>, JsError> {
        pubsub::export_logs(content).await
    }

    /// Read the SSH gateway fingerprint and end the handshake before user authentication.
    /// The caller must confirm or independently verify it before using it to connect.
    pub fn probe_ssh_host_key(options: SshHostKeyOptions) -> Result<Later<String>, JsError> {
        ssh::probe_host_key(options)
    }

    /// Open an owned Standalone Session. The Promise rejects with a stable `code`.
    pub fn connect_standalone(options: StandaloneOptions) -> Result<Later<RedisSession>, JsError> {
        options.validate()?;
        open_session(options, None, None)
    }

    /// Open a DB-zero Cluster Session using authenticated, verified seed and discovered nodes.
    pub fn connect_cluster(options: ClusterOptions) -> Result<Later<RedisSession>, JsError> {
        let common = options.validate()?;
        open_session(common, Some(options), None)
    }

    /// Discover a named primary through independently authenticated, verified Sentinels.
    pub fn connect_sentinel(options: SentinelOptions) -> Result<Later<RedisSession>, JsError> {
        let common = options.validate()?;
        open_session(common, None, Some(options))
    }
}

fn open_session(
    options: StandaloneOptions,
    cluster_options: Option<ClusterOptions>,
    sentinel_options: Option<SentinelOptions>,
) -> Result<Later<RedisSession>, JsError> {
    static SESSIONS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let permit = SESSIONS
        .get_or_init(|| Arc::new(Semaphore::new(64)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| error("BUSY", "Redis Session capacity is exhausted"))?;
    let (mut tx, rx) = oneshot::channel();
    runtime()?.spawn(async move {
        let result = tokio::select! {
            _ = tx.closed() => return,
            result = open_connection(&options, cluster_options.as_ref(), sentinel_options.as_ref()) => result,
        };
        let result = result.map(|connection| {
            let (cancel, cancellation) = watch::channel(false);
            let state = Arc::new(SessionState {
                cluster_observation: StdMutex::new(match &connection {
                    Connection::Cluster(cluster) => Some(cluster.observation()),
                    _ => None,
                }),
                cluster_refresh: Mutex::new(()),
                cluster_refresh_due: AtomicBool::new(false),
                cluster_discovery: StdMutex::new(connection.cluster_endpoints()),
                context: StdMutex::new(SessionContext {
                    database: options.database.unwrap_or(0),
                }),
                admission_gate: StdMutex::new(false),
                options,
                cluster_options,
                sentinel_options,
                interactive: Mutex::new(Lane {
                    connection: Some(connection),
                    generation: Some(1),
                }),
                background: Mutex::new(Lane {
                    connection: None,
                    generation: None,
                }),
                cancel,
                closed: AtomicBool::new(false),
                generation: AtomicU64::new(1),
                admission: Arc::new(Semaphore::new(16)),
                background_admission: Arc::new(Semaphore::new(12)),
                continuations: scan::ContinuationPool::new(),
                pubsub_admission: Arc::new(Semaphore::new(1)),
                console_admission: Arc::new(Semaphore::new(1)),
            });
            tokio::spawn(close_lanes(state.clone(), cancellation, permit));
            RedisSession { state }
        });
        let _ = tx.send(result);
    });
    Ok(Later::new(async move {
        rx.await.unwrap_or_else(|_| Err(closed()))
    }))
}

impl StandaloneOptions {
    fn validate(&self) -> Result<(), JsError> {
        if let Some(ssh) = &self.ssh {
            ssh.validate()?;
        }
        if let Some(proxy) = &self.proxy {
            proxy.validate()?;
        }
        if self.host.is_empty()
            || self.host.trim() != self.host
            || self
                .host
                .chars()
                .any(|c| c.is_whitespace() || "/@?#\0".contains(c))
            || !(1..=65535).contains(&self.port)
            || self.database.unwrap_or(0) > i32::MAX as u32
        {
            return Err(error(
                "INVALID_CONFIGURATION",
                "Expected a host, a TCP port from 1 to 65535 and a nonnegative Redis database",
            ));
        }
        if self.username.is_some() && self.password.is_none() {
            return Err(error(
                "INVALID_CONFIGURATION",
                "ACL username requires a password",
            ));
        }
        if self
            .max_response_bytes
            .is_some_and(|bytes| !(1..=1_048_576).contains(&bytes))
        {
            return Err(error(
                "INVALID_CONFIGURATION",
                "Redis payload budget must be from 1 to 1048576 bytes",
            ));
        }
        for timeout in [self.connect_timeout_ms, self.operation_timeout_ms]
            .into_iter()
            .flatten()
        {
            if !(10..=120_000).contains(&timeout) {
                return Err(error(
                    "INVALID_CONFIGURATION",
                    "Redis deadlines must be between 10 and 120000 milliseconds",
                ));
            }
        }
        Ok(())
    }
}

/// An owned Standalone, Cluster or Sentinel Session; close explicitly or dispose it.
#[class]
pub struct RedisSession {
    state: Arc<SessionState>,
}

#[class]
impl RedisSession {
    /// Local mode, database, opaque generation and closure information; performs no I/O.
    pub fn get_info(&self) -> SessionInfo {
        self.state.info()
    }

    /// Open an independent owned Session for a database, inheriting the current
    /// credentials, security, discovery, deadlines and response budget. The parent
    /// database/transports are unchanged. Close and dispose the returned Session.
    pub fn open_database_session(&self, database: u32) -> Result<Later<RedisSession>, JsError> {
        let _gate = self.state.admit()?;
        if self.state.cluster_options.is_some() && database != 0 {
            return Err(error(
                "CLUSTER_DATABASE_UNSUPPORTED",
                "Redis Cluster supports only database zero",
            ));
        }
        if database > i32::MAX as u32 {
            return Err(error("INVALID_ARGUMENT", "Redis database is out of range"));
        }
        let mut options = self.state.options.clone();
        options.database = Some(database);
        let sentinel = self.state.sentinel_options.as_ref().map(|original| {
            let mut options = original.clone();
            options.database = Some(database);
            options
        });
        open_session(options, self.state.cluster_connection_options(), sentinel)
    }

    /// Atomically replace both transports with connections to the selected database.
    /// New requests/scans reject BUSY while registered work drains. Failure retains
    /// the old context and scans. Selecting the current database is a no-op.
    pub fn select_database(&self, database: u32) -> Result<Later<SessionInfo>, JsError> {
        let mut gate = self.state.admit()?;
        if self.state.cluster_options.is_some() && database != 0 {
            return Err(error(
                "CLUSTER_DATABASE_UNSUPPORTED",
                "Redis Cluster supports only database zero",
            ));
        }
        if database > i32::MAX as u32 {
            return Err(error("INVALID_ARGUMENT", "Redis database is out of range"));
        }
        let transition_permit = capacity()
            .transitions
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("BUSY", "Database Switch capacity is exhausted"))?;
        if database == self.state.database() {
            let info = self.state.info();
            return Ok(Later::new(async move {
                let _permit = transition_permit;
                Ok::<_, JsError>(info)
            }));
        }
        *gate = true;
        drop(gate);
        let mut transition = DatabaseTransition {
            state: self.state.clone(),
            permit: Some(transition_permit),
        };
        let (mut reply, receive) = oneshot::channel();
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(
                self.state
                    .options
                    .operation_timeout_ms
                    .unwrap_or(5000)
                    .into(),
            );
        runtime()?.spawn(async move {
            let state = &transition.state;
            let result = tokio::select! {
                biased;
                _ = closed_signal(state) => Err(closed()),
                _ = reply.closed() => return,
                result = tokio::time::timeout_at(deadline, state.switch_database(database)) => {
                    result.unwrap_or_else(|_| Err(error("TIMEOUT", "Database Switch exceeded its total deadline")))
                },
            };
            // Reopen admission before delivering settlement to the native caller.
            let permit = transition.permit.take().unwrap();
            drop(transition);
            let _ = reply.send((result, permit));
        });
        Ok(Later::new(async move {
            let (result, _permit) = receive.await.map_err(|_| closed())?;
            result
        }))
    }

    /// Check server reachability. Closing or disposing rejects pending reads.
    pub fn ping(&self) -> Result<Later<RedisPing>, JsError> {
        self.state.submit(Operation::Ping, |result| match result {
            OperationResult::Ping(result) => result,
            _ => unreachable!(),
        })
    }

    /// Open one dedicated, bounded Pub/Sub receiver for this Session. Channels span databases.
    /// Requires Redis 6+ (RESP3). Database Switch does not interrupt subscriptions.
    pub fn open_pub_sub(&self) -> Result<Later<RedisPubSub>, JsError> {
        RedisPubSub::open(self.state.clone())
    }

    /// Open an isolated interactive CLI connection. SELECT, AUTH, transactions and
    /// streaming modes on this connection never change the browser's transports.
    /// Commands are sent once, without a client-side allowlist or uncertain replay.
    /// Uses the Session's database unless an initial database is supplied.
    pub fn open_console(&self, database: Option<u32>) -> Result<Later<RedisConsole>, JsError> {
        RedisConsole::open(self.state.clone(), database)
    }

    /// Read the server's command names, or documentation for one command, on the
    /// bounded background lane. Null name lists commands; names use spaces for subcommands.
    pub fn read_console_commands(
        &self,
        name: Option<String>,
    ) -> Result<Later<RedisCommandCatalog>, JsError> {
        self.state
            .submit(Operation::ConsoleCommands(name), |result| match result {
                OperationResult::ConsoleCommands(result) => result,
                _ => unreachable!(),
            })
    }

    /// Publish binary data once. The exact receiver count is node-local in Cluster mode.
    /// An unacknowledged publication reports WRITE_OUTCOME_UNKNOWN and is never replayed.
    pub fn publish(
        &self,
        channel: Vec<u8>,
        payload: Vec<u8>,
    ) -> Result<Later<RedisPublish>, JsError> {
        self.state.submit(
            Operation::Publish(channel, payload),
            |result| match result {
                OperationResult::Publish(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// List configured databases and observed key counts without changing the selected database.
    /// Counts are independent observations, not a snapshot. Missing permissions leave counts null
    /// or the list incomplete; an unavailable count is never reported as zero.
    pub fn list_databases(&self) -> Result<Later<RedisDatabases>, JsError> {
        self.state
            .submit(Operation::Databases, |result| match result {
                OperationResult::Databases(result) => result,
                _ => unreachable!(),
            })
    }

    /// Observe server metrics on the bounded background lane without changing server settings.
    /// Cluster metrics describe one observed node, identified by its address and actual role, not an aggregate.
    /// Missing optional metrics remain null.
    /// Command counters and percentiles cover the server's statistics lifetime.
    pub fn read_server_metrics(&self) -> Result<Later<RedisServerMetrics>, JsError> {
        self.state
            .submit(Operation::ServerMetrics, |result| match result {
                OperationResult::ServerMetrics(result) => result,
                _ => unreachable!(),
            })
    }

    /// Read a bounded byte range. Keys and values are Uint8Array; offsets are decimal strings.
    pub fn read_string_range(
        &self,
        key: Vec<u8>,
        range: StringRangeOptions,
    ) -> Result<Later<RedisStringRange>, JsError> {
        self.state
            .submit(Operation::ReadString(key, range), |result| match result {
                OperationResult::String(result) => result,
                _ => unreachable!(),
            })
    }

    /// Replace a String atomically, preserving its TTL by default. Uncertain writes are never replayed.
    pub fn set_string(
        &self,
        key: Vec<u8>,
        value: Vec<u8>,
        options: SetStringOptions,
    ) -> Result<Later<RedisWrite>, JsError> {
        self.state.submit(
            Operation::SetString(key, value, options),
            |result| match result {
                OperationResult::Write(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Read all client connections on the monitored server/node, across databases and client types.
    /// Uses CLIENT LIST on the background lane, with the Session response budget and no mutations.
    pub fn read_clients(&self) -> Result<Later<RedisClientList>, JsError> {
        self.state
            .submit(Operation::Clients, |result| match result {
                OperationResult::Clients(result) => result,
                _ => unreachable!(),
            })
    }

    /// Read the latest 1–200 slow-log entries on the background lane without changing logging settings.
    /// Binary arguments and exact integer timestamps/durations are retained.
    /// Cluster replies describe one identified node, not a cluster-wide aggregate.
    pub fn read_slow_log(&self, count: u32) -> Result<Later<RedisSlowlog>, JsError> {
        self.state
            .submit(Operation::Slowlog(count), |result| match result {
                OperationResult::Slowlog(result) => result,
                _ => unreachable!(),
            })
    }

    /// Read a complete RedisJSON document, or the array matched by a JSONPath.
    pub fn read_json(
        &self,
        key: Vec<u8>,
        options: JsonOptions,
    ) -> Result<Later<RedisJson>, JsError> {
        self.state
            .submit(Operation::ReadJson(key, options), |result| match result {
                OperationResult::Json(result) => result,
                _ => unreachable!(),
            })
    }

    /// Replace a RedisJSON document or set one JSON value at every matched path.
    /// The Key must already exist. Existing TTL is preserved; uncertain writes never replay.
    pub fn set_json(
        &self,
        key: Vec<u8>,
        value: String,
        options: JsonOptions,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::MutateJson(key, options, Some(value)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Delete JSONPath matches. Deleting $ removes the whole Key.
    pub fn delete_json_path(
        &self,
        key: Vec<u8>,
        path: String,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::MutateJson(key, JsonOptions { path: Some(path) }, None),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Read 1–200 ordered List items using exact nonnegative decimal offset and length.
    /// Oversized binary replies reject PAYLOAD_TOO_LARGE without truncating members.
    pub fn read_list_range(
        &self,
        key: Vec<u8>,
        range: ListRangeOptions,
    ) -> Result<Later<RedisListRange>, JsError> {
        self.state
            .submit(Operation::ReadList(key, range), |result| match result {
                OperationResult::List(result) => result,
                _ => unreachable!(),
            })
    }

    /// Read up to 200 ascending Stream entries using XRANGE and an exact exclusive ID.
    /// Preserve ordered binary field/value pairs and repeated field names. The response
    /// byte budget can shorten a page; a single oversized entry rejects PAYLOAD_TOO_LARGE.
    /// XLEN and expiration are observed atomically with the page. No messages are consumed
    /// or acknowledged, and no consumer groups are changed.
    pub fn read_stream_range(
        &self,
        key: Vec<u8>,
        options: StreamRangeOptions,
    ) -> Result<Later<RedisStreamRange>, JsError> {
        self.state
            .submit(Operation::ReadStream(key, options), |result| match result {
                OperationResult::StreamRange(result) => result,
                _ => unreachable!(),
            })
    }

    /// Append one Stream message using XADD. Ordered binary fields and duplicate names
    /// are preserved. Existing TTL is preserved; a missing Stream is created by Redis.
    /// The returned ID is exact. Uncertain writes are never replayed automatically.
    pub fn append_stream_entry(
        &self,
        key: Vec<u8>,
        options: StreamAppendOptions,
    ) -> Result<Later<RedisStreamAppend>, JsError> {
        self.state.submit(
            Operation::AppendStream(key, options),
            |result| match result {
                OperationResult::StreamAppend(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Delete one exact Stream message ID using XDEL, preserving surviving Stream TTL.
    /// Removing its last message leaves an empty Stream; missing IDs affect zero rows.
    /// Does not acknowledge messages or replay uncertain writes.
    pub fn delete_stream_entry(
        &self,
        key: Vec<u8>,
        id: String,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state
            .submit(Operation::DeleteStream(key, id), |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            })
    }

    /// Push 1–200 binary values from explicit `left` (LPUSH) or `right` (RPUSH).
    /// LPUSH reverses argument order. Returns the exact new total length; preserves TTL.
    pub fn push_list(
        &self,
        key: Vec<u8>,
        values: Vec<Vec<u8>>,
        direction: String,
    ) -> Result<Later<RedisListPush>, JsError> {
        self.state.submit(
            Operation::PushList(key, values, direction),
            |result| match result {
                OperationResult::ListPush(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Replace one binary List value in place, preserving TTL. Negative decimal indices count from the tail.
    /// Missing Keys reject KEY_NOT_FOUND; indices outside the existing List reject INDEX_OUT_OF_RANGE.
    pub fn set_list_item(
        &self,
        key: Vec<u8>,
        index: String,
        value: Vec<u8>,
    ) -> Result<Later<RedisWrite>, JsError> {
        self.state.submit(
            Operation::SetListItem(key, index, value),
            |result| match result {
                OperationResult::Write(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Remove matching binary values with an explicit signed decimal count:
    /// positive removes from the head, negative from the tail, zero removes all matches.
    /// The count magnitude must not exceed 9223372036854775807, matching Redis LREM.
    /// Returns exact actual removals; missing Lists remove zero. Preserves surviving TTL.
    pub fn remove_list_items(
        &self,
        key: Vec<u8>,
        value: Vec<u8>,
        count: String,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::RemoveListItems(key, value, count),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Read 1–200 ascending ZSet ranks with binary members and scores.
    /// Tied scores follow Redis binary lexicographic order. Offsets and counts are exact decimals.
    /// Missing Keys return exists false; wrong types reject WRONG_TYPE.
    /// Member bytes must fit maxResponseBytes. An oversized member rejects PAYLOAD_TOO_LARGE
    /// with exact itemRank/memberBytes; aggregate overflow rejects the whole range.
    pub fn read_z_set_range(
        &self,
        key: Vec<u8>,
        range: ZSetRangeOptions,
    ) -> Result<Later<RedisZSetRange>, JsError> {
        self.state
            .submit(Operation::ReadZSet(key, range), |result| match result {
                OperationResult::ZSetRange(result) => result,
                _ => unreachable!(),
            })
    }

    /// Add 1–200 binary ZSet members or update their scores, preserving existing TTL.
    /// Returns exact insertions plus changed scores (ZADD CH); unchanged scores count zero.
    /// NaN and positive/negative infinity reject INVALID_ARGUMENT before dispatch.
    pub fn add_z_set_members(
        &self,
        key: Vec<u8>,
        members: Vec<RedisZSetMember>,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::ZSetMutation(key, zsets::Mutation::Add(members)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Replace one existing binary ZSet member and its score atomically using EVAL.
    /// Preserve TTL; reject ROW_CONFLICT rather than overwrite a different member,
    /// or ROW_NOT_FOUND when the source disappeared. Uncertain writes are not replayed.
    pub fn replace_z_set_member(
        &self,
        key: Vec<u8>,
        previous: Vec<u8>,
        next: RedisZSetMember,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::ZSetMutation(key, zsets::Mutation::Replace(previous, next)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Remove 1–200 binary ZSet members, preserving surviving TTL.
    /// Returns exact actual removals; absent members and missing ZSets count zero.
    pub fn remove_z_set_members(
        &self,
        key: Vec<u8>,
        members: Vec<Vec<u8>>,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::ZSetMutation(key, zsets::Mutation::Remove(members)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Create a typed Key atomically using EVAL. Reject KEY_CONFLICT rather than replacing a value.
    /// An explicit options.database uses a dedicated connection and leaves the Session's
    /// selected database, transports and scan continuations unchanged. The result names the target database.
    pub fn create_key(
        &self,
        key: Vec<u8>,
        options: CreateKeyOptions,
    ) -> Result<Later<RedisMutation>, JsError> {
        if self.state.cluster_options.is_some()
            && options.database.is_some_and(|database| database != 0)
        {
            return Err(error(
                "CLUSTER_DATABASE_UNSUPPORTED",
                "Redis Cluster supports only database zero",
            ));
        }
        self.state
            .submit(Operation::CreateKey(key, options), |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            })
    }

    /// Insert one collection row, preserving existing TTL. Reject ROW_CONFLICT for existing
    /// Hash fields, Set members or ZSet members. Lists append at the right and return their index.
    pub fn insert_collection_row(
        &self,
        key: Vec<u8>,
        options: CollectionRowInsertOptions,
    ) -> Result<Later<RedisCollectionRowInsert>, JsError> {
        self.state.submit(
            Operation::InsertCollectionRow(key, options),
            |result| match result {
                OperationResult::CollectionInsert(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Read one collection field, List position or member without scanning the collection.
    pub fn read_collection_row(
        &self,
        key: Vec<u8>,
        target: CollectionRowTarget,
    ) -> Result<Later<RedisCollectionRow>, JsError> {
        self.state.submit(
            Operation::ReadCollectionRow(key, target),
            |result| match result {
                OperationResult::CollectionRow(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Delete one collection row. List deletion checks its expected value and removes only
    /// the indexed occurrence, preserving surviving TTL. List deletion requires Redis 6.0.6+.
    pub fn delete_collection_row(
        &self,
        key: Vec<u8>,
        target: CollectionRowTarget,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::DeleteCollectionRow(key, target),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Read Key type, exact size and expiration. Memory profiling requires explicit options.
    pub fn get_key_info(
        &self,
        key: Vec<u8>,
        options: KeyInfoOptions,
    ) -> Result<Later<RedisKeyInfo>, JsError> {
        self.state
            .submit(Operation::KeyInfo(key, options), |result| match result {
                OperationResult::KeyInfo(result) => result,
                _ => unreachable!(),
            })
    }

    /// Read selected metadata for at most 200 known binary Keys, without a snapshot guarantee.
    pub fn get_key_info_batch(
        &self,
        keys: Vec<Vec<u8>>,
        fields: KeyInfoFields,
    ) -> Result<Later<RedisKeyInfoBatch>, JsError> {
        self.state.submit(
            Operation::KeyInfoBatch(keys, fields),
            |result| match result {
                OperationResult::KeyInfoBatch(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Delete one Key. An absent Key returns affected "0".
    pub fn delete_key(&self, key: Vec<u8>) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::KeyMutation(key, KeyMutation::Delete),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Set an explicit positive signed 64-bit decimal millisecond TTL.
    pub fn set_expiry(
        &self,
        key: Vec<u8>,
        ttl_ms: String,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::KeyMutation(key, KeyMutation::Expire(ttl_ms)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Remove expiration explicitly. Missing or already persistent Keys return affected "0".
    pub fn persist_key(&self, key: Vec<u8>) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::KeyMutation(key, KeyMutation::Persist),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Rename atomically. The default rejects KEY_CONFLICT instead of replacing a destination.
    pub fn rename_key(
        &self,
        key: Vec<u8>,
        new_key: Vec<u8>,
        options: RenameKeyOptions,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::KeyMutation(key, KeyMutation::Rename(new_key, options)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Start an owned progressive scan with fixed filters; performs no network work.
    pub fn start_key_scan(&self, options: KeyScanOptions) -> Result<RedisKeyScan, JsError> {
        RedisKeyScan::start(self.state.clone(), options)
    }

    /// Start an owned binary Hash scan. No network work occurs until nextPage().
    pub fn scan_hash(&self, key: Vec<u8>) -> Result<RedisHashScan, JsError> {
        RedisHashScan::start(self.state.clone(), key)
    }

    /// Start an owned binary Set scan. No network work occurs until nextPage().
    pub fn scan_set(&self, key: Vec<u8>) -> Result<RedisSetScan, JsError> {
        RedisSetScan::start(self.state.clone(), key)
    }

    /// Add 1–200 binary members in place, preserving existing TTL.
    /// Returns exact newly added membership; uncertain writes are never replayed.
    pub fn add_set_members(
        &self,
        key: Vec<u8>,
        members: Vec<Vec<u8>>,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::SetMutation(key, sets::Mutation::Add(members)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Replace one existing Set member atomically, preserving TTL and rejecting MEMBER_CONFLICT.
    pub fn replace_set_member(
        &self,
        key: Vec<u8>,
        previous: Vec<u8>,
        next: Vec<u8>,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::SetMutation(key, sets::Mutation::Replace(previous, next)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Remove 1–200 binary members. TTL survives unless the final member removes the Key.
    /// Returns the exact removed count; absent or duplicate members contribute zero.
    pub fn remove_set_members(
        &self,
        key: Vec<u8>,
        members: Vec<Vec<u8>>,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::SetMutation(key, sets::Mutation::Remove(members)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Add or replace 1–200 binary fields in place, preserving existing TTL.
    /// Returns the exact newly added count; uncertain writes are never replayed.
    pub fn set_hash_fields(
        &self,
        key: Vec<u8>,
        fields: Vec<RedisHashField>,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::HashMutation(key, hashes::Mutation::Set(fields)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Replace one existing binary Hash field and its value atomically using EVAL.
    /// Preserve TTL; reject ROW_CONFLICT rather than overwrite a different field,
    /// or ROW_NOT_FOUND when the source disappeared. Uncertain writes are not replayed.
    pub fn replace_hash_field(
        &self,
        key: Vec<u8>,
        previous: Vec<u8>,
        next: RedisHashField,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::HashMutation(key, hashes::Mutation::Replace(previous, next)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Delete 1–200 binary fields, preserving TTL unless the last field removes the Key.
    /// Returns the exact removed count; missing fields contribute zero.
    pub fn delete_hash_fields(
        &self,
        key: Vec<u8>,
        fields: Vec<Vec<u8>>,
    ) -> Result<Later<RedisMutation>, JsError> {
        self.state.submit(
            Operation::HashMutation(key, hashes::Mutation::Delete(fields)),
            |result| match result {
                OperationResult::Mutation(result) => result,
                _ => unreachable!(),
            },
        )
    }

    /// Prevent new work and cancel pending requests; a dispatched unacknowledged write stays uncertain.
    pub fn close(&self) {
        self.state.close();
    }
}

impl Drop for RedisSession {
    fn drop(&mut self) {
        self.state.close();
    }
}

struct SessionState {
    options: StandaloneOptions,
    // This lock makes database/generation observations and commits coherent.
    context: StdMutex<SessionContext>,
    // Serializes request/continuation registration with transition and close.
    admission_gate: StdMutex<bool>,
    cluster_options: Option<ClusterOptions>,
    sentinel_options: Option<SentinelOptions>,
    cluster_discovery: StdMutex<Vec<cluster::RedisEndpoint>>,
    cluster_observation: StdMutex<Option<cluster::Observation>>,
    cluster_refresh: Mutex<()>,
    cluster_refresh_due: AtomicBool,
    interactive: Mutex<Lane>,
    background: Mutex<Lane>,
    cancel: watch::Sender<bool>,
    closed: AtomicBool,
    generation: AtomicU64,
    admission: Arc<Semaphore>,
    background_admission: Arc<Semaphore>,
    continuations: scan::ContinuationPool,
    pubsub_admission: Arc<Semaphore>,
    console_admission: Arc<Semaphore>,
}

struct SessionContext {
    database: u32,
}

struct DatabaseTransition {
    state: Arc<SessionState>,
    permit: Option<OwnedSemaphorePermit>,
}

impl Drop for DatabaseTransition {
    fn drop(&mut self) {
        *self.state.admission_gate.lock().unwrap() = false;
    }
}

/// Each lane owns its transport. A blocked background response cannot hold the
/// interactive transport or its FIFO execution lock.
struct Lane {
    connection: Option<Connection>,
    generation: Option<u64>,
}

struct Capacity {
    transitions: Arc<Semaphore>,
    requests: Arc<Semaphore>,
    background_requests: Arc<Semaphore>,
    executing: Semaphore,
    background_executing: Semaphore,
}

fn capacity() -> &'static Capacity {
    static CAPACITY: OnceLock<Capacity> = OnceLock::new();
    CAPACITY.get_or_init(|| Capacity {
        transitions: Arc::new(Semaphore::new(8)),
        requests: Arc::new(Semaphore::new(64)),
        background_requests: Arc::new(Semaphore::new(48)),
        executing: Semaphore::new(16),
        background_executing: Semaphore::new(8),
    })
}

impl SessionState {
    async fn connect(&self) -> Result<Connection, JsError> {
        self.connect_for_database(self.database()).await
    }

    fn cluster_connection_options(&self) -> Option<ClusterOptions> {
        self.cluster_options.as_ref().map(|options| {
            let mut options = options.clone();
            let mut candidates = self.cluster_discovery.lock().unwrap().clone();
            for seed in &options.seeds {
                if !candidates.contains(seed) {
                    candidates.push(seed.clone());
                }
            }
            options.seeds = candidates;
            options
        })
    }

    async fn connect_for_database(&self, database: u32) -> Result<Connection, JsError> {
        let epoch = self.generation.load(Ordering::Acquire);
        let cluster_options = self.cluster_connection_options();
        let mut options = self.options.clone();
        options.database = Some(database);
        let mut connection = open_connection(
            &options,
            cluster_options.as_ref(),
            self.sentinel_options.as_ref(),
        )
        .await?;
        if let Connection::Cluster(cluster) = &mut connection {
            cluster.set_observation_epoch(epoch);
        }
        self.remember_cluster(Some(&connection));
        Ok(connection)
    }

    fn info(&self) -> SessionInfo {
        let context = self.context.lock().unwrap();
        self.info_in(&context)
    }

    fn info_in(&self, context: &SessionContext) -> SessionInfo {
        SessionInfo {
            mode: if self.cluster_options.is_some() {
                "cluster"
            } else if self.sentinel_options.is_some() {
                "sentinel"
            } else {
                "standalone"
            }
            .into(),
            database: context.database,
            generation: self.generation.load(Ordering::Acquire).to_string(),
            closed: self.closed.load(Ordering::Acquire),
        }
    }

    fn admit(&self) -> Result<std::sync::MutexGuard<'_, bool>, JsError> {
        let gate = self.admission_gate.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            Err(closed())
        } else if *gate {
            Err(error("BUSY", "Redis Session is switching databases"))
        } else {
            Ok(gate)
        }
    }

    async fn switch_database(&self, database: u32) -> Result<SessionInfo, JsError> {
        // Registrations include both queues, in-flight work and ready replies.
        let _drained = self.admission.clone().acquire_many_owned(16).await.unwrap();
        let candidate = || async {
            let _execution = capacity().executing.acquire().await.unwrap();
            self.connect_for_database(database).await
        };
        let (mut interactive_candidate, mut background_candidate) =
            tokio::try_join!(candidate(), candidate(),)?;
        let mut interactive = self.interactive.lock().await;
        let mut background = self.background.lock().await;
        let _gate = self.admission_gate.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            return Err(closed());
        }
        let mut context = self.context.lock().unwrap();
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        interactive_candidate.set_generation(generation);
        background_candidate.set_generation(generation);
        *interactive = Lane {
            connection: Some(interactive_candidate),
            generation: Some(generation),
        };
        *background = Lane {
            connection: Some(background_candidate),
            generation: Some(generation),
        };
        context.database = database;
        self.continuations.invalidate();
        Ok(self.info_in(&context))
    }

    fn remember_cluster(&self, connection: Option<&Connection>) {
        if let Some(Connection::Cluster(connection)) = connection {
            let mut remembered = self.cluster_discovery.lock().unwrap();
            let mut endpoints = connection.endpoints();
            for endpoint in remembered.iter() {
                if endpoints.len() == 256 {
                    break;
                }
                if !endpoints.contains(endpoint) {
                    endpoints.push(endpoint.clone());
                }
            }
            *remembered = endpoints;
        }
    }
    fn submit<T: JsValue + 'static>(
        self: &Arc<Self>,
        operation: Operation,
        decode: impl FnOnce(OperationResult) -> T + 'static,
    ) -> Result<Later<T>, JsError> {
        let _gate = self.admit()?;
        operation.validate(self.options.max_response_bytes.unwrap_or(262_144) as usize)?;
        let scan = operation.scan();
        let scan_page = match &operation {
            Operation::KeyScan(page, _) => Some(page.clone()),
            _ => None,
        };
        let hash_page = match &operation {
            Operation::HashScan(page) => Some(page.clone()),
            _ => None,
        };
        let background_permit = operation
            .is_background()
            .then(|| {
                self.background_admission
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| error("BUSY", "Session background request capacity is exhausted"))
            })
            .transpose()?;
        let global_background_permit = operation
            .is_background()
            .then(|| {
                capacity()
                    .background_requests
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| error("BUSY", "Global background request capacity is exhausted"))
            })
            .transpose()?;
        let global_permit = capacity()
            .requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("BUSY", "Global Redis request capacity is exhausted"))?;
        let set_page = match &operation {
            Operation::SetScan(page) => Some(page.clone()),
            _ => None,
        };
        let permit = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("BUSY", "Session request capacity is exhausted"))?;
        let mutation = operation.is_mutation();
        #[cfg(feature = "redis-observer")]
        let timing = crate::redis_observer::Span::new(match &operation {
            Operation::KeyScan(..) => "key_page",
            Operation::KeyInfoBatch(..) => "metadata",
            _ => "interactive",
        });
        let (reply, receive) = oneshot::channel();
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(self.options.operation_timeout_ms.unwrap_or(5000).into());
        runtime()?.spawn(worker(
            self.clone(),
            Request {
                #[cfg(feature = "redis-observer")]
                timing,
                operation,
                reply,
                deadline,
                _permit: permit,
                _background_permit: background_permit,
                _global_permit: global_permit,
                _global_background_permit: global_background_permit,
            },
        ));
        let state = self.clone();
        Ok(Later::new(async move {
            // Keep the per-handle page admission until the native Promise settles.
            let _scan_page = scan_page;
            let _hash_page = hash_page;
            let _set_page = set_page;
            // The reply envelope retains admission until native delivery/drop,
            // including while a completed reply waits for a slow engine.
            let envelope = receive.await.map_err(|_| closed())?;
            let result = envelope.result;
            if let Some(scan) = &scan {
                scan.validate()?;
            }
            if !mutation && state.closed.load(Ordering::Acquire) {
                Err(closed())
            } else {
                if !mutation
                    && result.is_ok()
                    && state.generation.load(Ordering::Acquire) != envelope.generation
                {
                    Err(context_changed())
                } else {
                    result.map(decode)
                }
            }
        }))
    }

    fn database(&self) -> u32 {
        self.context.lock().unwrap().database
    }
    fn advance_generation(&self) -> u64 {
        let _context = self.context.lock().unwrap();
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.continuations.invalidate();
        generation
    }
    fn advance_connection_generation(&self, connection: &mut Option<Connection>) {
        connection
            .as_mut()
            .unwrap()
            .set_generation(self.advance_generation());
    }
    fn close(&self) {
        let _gate = self.admission_gate.lock().unwrap();
        self.closed.store(true, Ordering::Release);
        self.cancel.send_replace(true);
        self.continuations.invalidate();
    }
}

enum Operation {
    Clients,
    Slowlog(u32),
    Publish(Vec<u8>, Vec<u8>),
    Ping,
    Databases,
    ServerMetrics,
    ConsoleCommands(Option<String>),
    KeyScan(scan::NextPage, usize),
    HashScan(hashes::NextPage),
    SetScan(sets::NextPage),
    SetMutation(Vec<u8>, sets::Mutation),
    HashMutation(Vec<u8>, hashes::Mutation),
    ReadString(Vec<u8>, StringRangeOptions),
    ReadJson(Vec<u8>, JsonOptions),
    MutateJson(Vec<u8>, JsonOptions, Option<String>),
    ReadList(Vec<u8>, ListRangeOptions),
    ReadStream(Vec<u8>, StreamRangeOptions),
    AppendStream(Vec<u8>, StreamAppendOptions),
    DeleteStream(Vec<u8>, String),
    ReadZSet(Vec<u8>, ZSetRangeOptions),
    ZSetMutation(Vec<u8>, zsets::Mutation),
    PushList(Vec<u8>, Vec<Vec<u8>>, String),
    SetListItem(Vec<u8>, String, Vec<u8>),
    RemoveListItems(Vec<u8>, Vec<u8>, String),
    SetString(Vec<u8>, Vec<u8>, SetStringOptions),
    CreateKey(Vec<u8>, CreateKeyOptions),
    InsertCollectionRow(Vec<u8>, CollectionRowInsertOptions),
    ReadCollectionRow(Vec<u8>, CollectionRowTarget),
    DeleteCollectionRow(Vec<u8>, CollectionRowTarget),
    KeyInfo(Vec<u8>, KeyInfoOptions),
    KeyInfoBatch(Vec<Vec<u8>>, KeyInfoFields),
    KeyMutation(Vec<u8>, KeyMutation),
}

impl Operation {
    fn uses_dedicated_connection(&self) -> bool {
        matches!(self, Self::CreateKey(_, options) if options.database.is_some())
    }

    fn is_background(&self) -> bool {
        matches!(
            self,
            Self::KeyScan(..)
                | Self::HashScan(_)
                | Self::SetScan(_)
                | Self::KeyInfoBatch(..)
                | Self::Databases
                | Self::ServerMetrics
                | Self::Clients
                | Self::Slowlog(..)
                | Self::ConsoleCommands(..)
        )
    }
    fn scan(&self) -> Option<Arc<dyn scan::ContinuationControl>> {
        match self {
            Self::KeyScan(page, _) => Some(page.state.clone()),
            Self::HashScan(page) => Some(page.state.clone()),
            Self::SetScan(page) => Some(page.state.clone()),
            _ => None,
        }
    }
    fn is_mutation(&self) -> bool {
        matches!(
            self,
            Self::Publish(..)
                | Self::SetString(..)
                | Self::MutateJson(..)
                | Self::CreateKey(..)
                | Self::InsertCollectionRow(..)
                | Self::DeleteCollectionRow(..)
                | Self::AppendStream(..)
                | Self::DeleteStream(..)
                | Self::KeyMutation(..)
                | Self::HashMutation(..)
                | Self::PushList(..)
                | Self::SetListItem(..)
                | Self::RemoveListItems(..)
                | Self::SetMutation(..)
                | Self::ZSetMutation(..)
        )
    }

    fn validate(&self, budget: usize) -> Result<(), JsError> {
        match self {
            Self::Publish(channel, payload) => pubsub::validate(channel, payload, budget),
            Self::Ping | Self::Databases | Self::ServerMetrics | Self::Clients => Ok(()),
            Self::Slowlog(count) => slowlog::validate(*count),
            Self::ConsoleCommands(name) => console::catalog::validate(name.as_deref()),
            Self::KeyScan(page, _) => page.state.validate(),
            Self::HashScan(page) => scan::ContinuationControl::validate(&*page.state),
            Self::SetScan(page) => scan::ContinuationControl::validate(&*page.state),
            Self::SetMutation(key, mutation) => sets::validate_mutation(key, mutation, budget),
            Self::ZSetMutation(key, mutation) => zsets::validate_mutation(key, mutation, budget),
            Self::HashMutation(key, mutation) => hashes::validate_mutation(key, mutation, budget),
            Self::ReadString(key, range) => {
                strings::check_payload(key.len(), budget)?;
                strings::validate_range(range, budget)
            }
            Self::ReadJson(key, options) => json::validate(key, options, None, budget),
            Self::MutateJson(key, options, value) => {
                json::validate(key, options, value.as_deref(), budget)
            }
            Self::ReadList(key, range) => {
                strings::check_payload(key.len(), budget)?;
                lists::validate_range(range)
            }
            Self::ReadStream(key, options) => streams::validate(key, options, budget),
            Self::AppendStream(key, options) => streams::validate_append(key, options, budget),
            Self::DeleteStream(key, id) => streams::validate_delete(key, id, budget),
            Self::ReadZSet(key, range) => {
                strings::check_payload(key.len(), budget)?;
                lists::range_bounds(&range.offset, &range.length).map(|_| ())
            }
            Self::PushList(key, values, direction) => {
                lists::validate_push(key, values, direction, budget)
            }
            Self::SetListItem(key, index, value) => {
                lists::signed(index)?;
                strings::check_payload(key.len().saturating_add(value.len()), budget)
            }
            Self::RemoveListItems(key, value, count) => {
                lists::removal_count(count)?;
                strings::check_payload(key.len().saturating_add(value.len()), budget)
            }
            Self::SetString(key, value, options) => {
                strings::check_payload(key.len().saturating_add(value.len()), budget)?;
                strings::expiry(options).map(|_| ())
            }
            Self::CreateKey(key, options) => create_key::validate(key, options, budget),
            Self::InsertCollectionRow(key, options) => {
                collection_insert::validate(key, options, budget)
            }
            Self::ReadCollectionRow(key, target) => {
                collection_row::validate(key, target, budget, false)
            }
            Self::DeleteCollectionRow(key, target) => {
                collection_row::validate(key, target, budget, true)
            }
            Self::KeyInfo(key, options) => {
                strings::check_payload(key.len(), budget)?;
                keys::validate_info(options)
            }
            Self::KeyInfoBatch(keys, fields) => metadata::validate(keys, fields, budget),
            Self::KeyMutation(key, mutation) => {
                strings::check_payload(key.len(), budget)?;
                keys::validate_mutation(mutation, budget.saturating_sub(key.len()))
            }
        }
    }
}

enum OperationResult {
    Clients(RedisClientList),
    Slowlog(RedisSlowlog),
    Publish(RedisPublish),
    Databases(RedisDatabases),
    ServerMetrics(RedisServerMetrics),
    ConsoleCommands(RedisCommandCatalog),
    KeyPage(RedisKeyPage),
    HashPage(RedisHashPage),
    SetPage(RedisSetPage),
    Ping(RedisPing),
    String(RedisStringRange),
    Json(RedisJson),
    List(RedisListRange),
    StreamRange(RedisStreamRange),
    StreamAppend(RedisStreamAppend),
    ZSetRange(RedisZSetRange),
    ListPush(RedisListPush),
    Write(RedisWrite),
    KeyInfo(RedisKeyInfo),
    KeyInfoBatch(RedisKeyInfoBatch),
    Mutation(RedisMutation),
    CollectionInsert(RedisCollectionRowInsert),
    CollectionRow(RedisCollectionRow),
}

impl OperationResult {
    fn set_generation(&mut self, generation: u64) {
        let generation = generation.to_string();
        match self {
            Self::Publish(result) => result.generation = generation,
            Self::Databases(page) => page.generation = generation,
            Self::ServerMetrics(page) => page.generation = generation,
            Self::Clients(page) => page.generation = generation,
            Self::Slowlog(page) => page.generation = generation,
            Self::ConsoleCommands(page) => page.generation = generation,
            Self::KeyPage(page) => page.generation = generation,
            Self::HashPage(page) => page.generation = generation,
            Self::SetPage(page) => page.generation = generation,
            Self::Ping(page) => page.generation = generation,
            Self::String(page) => page.generation = generation,
            Self::Json(page) => page.generation = generation,
            Self::List(page) => page.generation = generation,
            Self::StreamRange(page) => page.generation = generation,
            Self::StreamAppend(page) => page.generation = generation,
            Self::ZSetRange(page) => page.generation = generation,
            Self::ListPush(page) => page.generation = generation,
            Self::Write(page) => page.generation = generation,
            Self::KeyInfo(page) => page.generation = generation,
            Self::KeyInfoBatch(page) => page.generation = generation,
            Self::Mutation(page) => page.generation = generation,
            Self::CollectionInsert(page) => page.generation = generation,
            Self::CollectionRow(page) => page.generation = generation,
        }
    }
}

fn context_changed() -> JsError {
    error(
        "CONTEXT_CHANGED",
        "Redis read context changed before delivery; retry in the current Session context",
    )
}

struct Request {
    #[cfg(feature = "redis-observer")]
    timing: crate::redis_observer::Span,
    operation: Operation,
    reply: oneshot::Sender<Reply>,
    deadline: tokio::time::Instant,
    _permit: OwnedSemaphorePermit,
    _background_permit: Option<OwnedSemaphorePermit>,
    _global_permit: OwnedSemaphorePermit,
    _global_background_permit: Option<OwnedSemaphorePermit>,
}

struct Reply {
    result: Result<OperationResult, JsError>,
    generation: u64,
    _permit: OwnedSemaphorePermit,
    _background_permit: Option<OwnedSemaphorePermit>,
    _global_permit: OwnedSemaphorePermit,
    _global_background_permit: Option<OwnedSemaphorePermit>,
}

async fn close_lanes(
    state: Arc<SessionState>,
    mut cancellation: watch::Receiver<bool>,
    _session_permit: OwnedSemaphorePermit,
) {
    if !*cancellation.borrow_and_update() {
        let _ = cancellation.changed().await;
    }
    state.interactive.lock().await.connection.take();
    state.background.lock().await.connection.take();
}

async fn closed_signal(state: &SessionState) {
    let mut cancellation = state.cancel.subscribe();
    if !*cancellation.borrow_and_update() {
        let _ = cancellation.changed().await;
    }
}

async fn worker(state: Arc<SessionState>, request: Request) {
    let Request {
        #[cfg(feature = "redis-observer")]
        timing,
        operation,
        reply,
        deadline,
        _permit,
        _background_permit,
        _global_permit,
        _global_background_permit,
    } = request;
    let scan = operation.scan();
    let mutation = operation.is_mutation();
    let dedicated = operation.uses_dedicated_connection();
    let lane = if operation.is_background() {
        &state.background
    } else {
        &state.interactive
    };
    let dispatched = AtomicBool::new(false);
    let mut completed_generation = state.generation.load(Ordering::Acquire);
    #[cfg(feature = "redis-observer")]
    let mut execution_started = None;
    let work = async {
        let mut lane = tokio::select! {
            biased;
            _ = closed_signal(&state) => return Err(closed()),
            _ = scan::cancelled(&scan) => return Err(scan::cancelled_error()),
            lane = tokio::time::timeout_at(deadline, lane.lock()) => match lane {
                Ok(lane) => lane,
                Err(_) => return Err(error("TIMEOUT", "Redis request exceeded its total deadline")),
            },
        };
        let mut result = tokio::select! {
            biased;
            _ = closed_signal(&state) => Err(if mutation && dispatched.load(Ordering::Acquire) { unknown_write() } else { closed() }),
            _ = scan::cancelled(&scan) => Err(scan::cancelled_error()),
            result = tokio::time::timeout_at(deadline, async {
                let _background_execution = if operation.is_background() {
                    Some(capacity().background_executing.acquire().await.unwrap())
                } else { None };
                let _execution = capacity().executing.acquire().await.unwrap();
                #[cfg(feature = "redis-observer")]
                { execution_started = Some(std::time::Instant::now()); }
                let generation = state.generation.load(Ordering::Acquire);
                if !dedicated && lane.generation != Some(generation) {
                    // Recovery in the other lane invalidates this transport too.
                    // Joining an already committed generation does not advance
                    // it again and invalidate newly created continuations.
                    lane.connection = Some(state.connect().await?);
                    lane.connection.as_mut().unwrap().set_generation(generation);
                    lane.generation = Some(generation);
                }
                execute(&state, &mut lane.connection, operation, &dispatched).await
            }) => match result {
                Ok(result) => result,
                Err(_) => {
                    if !dedicated { discard_transports(&mut lane.connection); }
                    Err(if mutation && dispatched.load(Ordering::Acquire) { unknown_write() } else { error("TIMEOUT", "Redis request exceeded its total deadline") })
                },
            },
        };
        if dedicated {
            completed_generation = state.generation.load(Ordering::Acquire);
        } else {
            state.remember_cluster(lane.connection.as_ref());
            if let Some(connection) = &lane.connection {
                completed_generation = connection.generation();
            }
        }
        if let Ok(value) = &mut result {
            if !mutation && state.generation.load(Ordering::Acquire) != completed_generation {
                return Err(context_changed());
            }
            value.set_generation(completed_generation);
        }
        result
    };
    let result = work.await;
    #[cfg(feature = "redis-observer")]
    timing.finish(execution_started, result.is_ok());
    // Registration covers queued, active and completed-undelivered replies.
    // Database Switch gates new work and drains these shared registrations.
    let _ = reply.send(Reply {
        result,
        generation: completed_generation,
        _permit,
        _background_permit,
        _global_permit,
        _global_background_permit,
    });
}

async fn execute(
    state: &SessionState,
    connection: &mut Option<Connection>,
    operation: Operation,
    dispatched: &AtomicBool,
) -> Result<OperationResult, JsError> {
    match operation {
        Operation::Publish(channel, payload) => {
            pubsub::publish(state, connection, channel, payload, dispatched)
                .await
                .map(OperationResult::Publish)
        }
        Operation::SetScan(page) => sets::next(state, connection, page)
            .await
            .map(OperationResult::SetPage),
        Operation::SetMutation(key, mutation) => {
            sets::mutate(state, connection, key, mutation, dispatched)
                .await
                .map(OperationResult::Mutation)
        }
        Operation::HashScan(page) => hashes::next(state, connection, page)
            .await
            .map(OperationResult::HashPage),
        Operation::HashMutation(key, mutation) => {
            hashes::mutate(state, connection, key, mutation, dispatched)
                .await
                .map(OperationResult::Mutation)
        }
        Operation::KeyScan(page, limit) => scan::next(state, connection, page, limit)
            .await
            .map(OperationResult::KeyPage),
        Operation::Ping => ping(state, connection).await.map(OperationResult::Ping),
        Operation::Databases => databases::read(state, connection)
            .await
            .map(OperationResult::Databases),
        Operation::ServerMetrics => metrics::read(state, connection)
            .await
            .map(OperationResult::ServerMetrics),
        Operation::Clients => clients::read(state, connection)
            .await
            .map(OperationResult::Clients),
        Operation::Slowlog(count) => slowlog::read(state, connection, count)
            .await
            .map(OperationResult::Slowlog),
        Operation::ConsoleCommands(name) => console::catalog::read(state, connection, name)
            .await
            .map(OperationResult::ConsoleCommands),
        Operation::ReadString(key, range) => strings::read(state, connection, key, range)
            .await
            .map(OperationResult::String),
        Operation::ReadJson(key, options) => json::read(state, connection, key, options)
            .await
            .map(OperationResult::Json),
        Operation::MutateJson(key, options, value) => {
            json::mutate(state, connection, key, options, value, dispatched)
                .await
                .map(OperationResult::Mutation)
        }
        Operation::ReadList(key, range) => lists::read(state, connection, key, range)
            .await
            .map(OperationResult::List),
        Operation::ReadStream(key, options) => streams::read(state, connection, key, options)
            .await
            .map(OperationResult::StreamRange),
        Operation::AppendStream(key, options) => {
            streams::append(state, connection, key, options, dispatched)
                .await
                .map(OperationResult::StreamAppend)
        }
        Operation::DeleteStream(key, id) => streams::delete(state, connection, key, id, dispatched)
            .await
            .map(OperationResult::Mutation),
        Operation::ReadZSet(key, range) => zsets::read(state, connection, key, range)
            .await
            .map(OperationResult::ZSetRange),
        Operation::ZSetMutation(key, mutation) => {
            zsets::mutate(state, connection, key, mutation, dispatched)
                .await
                .map(OperationResult::Mutation)
        }
        Operation::PushList(key, values, direction) => {
            lists::push(state, connection, key, values, direction, dispatched)
                .await
                .map(OperationResult::ListPush)
        }
        Operation::SetListItem(key, index, value) => {
            lists::set(state, connection, key, index, value, dispatched)
                .await
                .map(OperationResult::Write)
        }
        Operation::RemoveListItems(key, value, count) => {
            lists::remove(state, connection, key, value, count, dispatched)
                .await
                .map(OperationResult::Mutation)
        }
        Operation::SetString(key, value, options) => {
            strings::set(state, connection, key, value, options, dispatched)
                .await
                .map(OperationResult::Write)
        }
        Operation::CreateKey(key, options) => {
            create_key::create(state, connection, key, options, dispatched)
                .await
                .map(OperationResult::Mutation)
        }
        Operation::InsertCollectionRow(key, options) => {
            collection_insert::insert(state, connection, key, options, dispatched)
                .await
                .map(OperationResult::CollectionInsert)
        }
        Operation::ReadCollectionRow(key, target) => {
            collection_row::read(state, connection, key, target)
                .await
                .map(OperationResult::CollectionRow)
        }
        Operation::DeleteCollectionRow(key, target) => {
            collection_row::delete(state, connection, key, target, dispatched)
                .await
                .map(OperationResult::Mutation)
        }
        Operation::KeyInfo(key, options) => keys::info(state, connection, key, options)
            .await
            .map(OperationResult::KeyInfo),
        Operation::KeyInfoBatch(keys, fields) => metadata::read(state, connection, keys, fields)
            .await
            .map(OperationResult::KeyInfoBatch),
        Operation::KeyMutation(key, mutation) => {
            keys::mutate(state, connection, key, mutation, dispatched)
                .await
                .map(OperationResult::Mutation)
        }
    }
}

async fn ping(
    state: &SessionState,
    connection: &mut Option<Connection>,
) -> Result<RedisPing, JsError> {
    for attempt in 0..2 {
        if connection.is_none() {
            *connection = Some(state.connect().await?);
            state.advance_connection_generation(connection);
        }
        match connection
            .as_mut()
            .unwrap()
            .query::<String>(state, None, &redis::cmd("PING"), None)
            .await
        {
            Ok(response) => {
                return Ok(RedisPing {
                    response,
                    database: state.database(),
                    generation: state.generation.load(Ordering::Acquire).to_string(),
                });
            }
            Err(cause) => {
                let recoverable = cause.recoverable();
                if recoverable {
                    discard_transports(connection);
                }
                if !recoverable || attempt == 1 {
                    return Err(cause.into_js());
                }
            }
        }
    }
    unreachable!("the final attempt always returns")
}

async fn connect(options: &StandaloneOptions) -> Result<Transport, JsError> {
    connect_configured(options, None).await
}

async fn connect_configured(
    options: &StandaloneOptions,
    push: Option<redis::AsyncConnectionConfig>,
) -> Result<Transport, JsError> {
    tokio::time::timeout(
        Duration::from_millis(options.connect_timeout_ms.unwrap_or(3000).into()),
        connect_inner(options, push),
    )
    .await
    .map_err(|_| error("TIMEOUT", "Redis connection setup exceeded its deadline"))?
}

enum Connection {
    Standalone(Transport, u64),
    Cluster(cluster::ClusterConnection),
}

fn discard_transports(connection: &mut Option<Connection>) {
    match connection {
        Some(Connection::Cluster(cluster)) => cluster.discard_transports(),
        _ => *connection = None,
    }
}

/// Settle transport uncertainty once; definite command-specific rejections stay local.
fn settle_mutation_error(
    connection: &mut Option<Connection>,
    dispatched: &AtomicBool,
    cause: RequestError,
) -> JsError {
    if cause.recoverable() {
        discard_transports(connection);
        if dispatched.load(Ordering::Acquire) {
            return unknown_write();
        }
    }
    cause.into_js()
}

fn nonnegative_decimal(value: &str) -> Result<i64, JsError> {
    if value.is_empty()
        || value.len() > 19
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(error(
            "INVALID_ARGUMENT",
            "Expected a canonical nonnegative signed 64-bit decimal integer",
        ));
    }
    value.parse().map_err(|_| {
        error(
            "INVALID_ARGUMENT",
            "Decimal integer exceeds signed 64-bit range",
        )
    })
}

enum RequestError {
    Redis(redis::RedisError),
    Native(JsError),
}
impl RequestError {
    fn redis_cause(&self) -> Option<&redis::RedisError> {
        match self {
            Self::Redis(cause) => Some(cause),
            Self::Native(_) => None,
        }
    }
    fn code(&self) -> Option<&str> {
        self.redis_cause().and_then(redis::RedisError::code)
    }
    fn detail(&self) -> Option<&str> {
        self.redis_cause().and_then(redis::RedisError::detail)
    }
    fn server_code(&self) -> Option<String> {
        self.redis_cause().and_then(keys::server_code)
    }
    fn recoverable(&self) -> bool {
        matches!(self, Self::Redis(cause) if cause.is_io_error() || cause.is_timeout())
    }
    fn into_js(self) -> JsError {
        match self {
            Self::Redis(cause) => classify(cause),
            Self::Native(cause) => cause,
        }
    }
}
impl From<redis::RedisError> for RequestError {
    fn from(cause: redis::RedisError) -> Self {
        Self::Redis(cause)
    }
}
impl From<JsError> for RequestError {
    fn from(cause: JsError) -> Self {
        Self::Native(cause)
    }
}

#[derive(Clone, Copy)]
enum Command<'a> {
    Single(&'a redis::Cmd),
    Pipeline(&'a redis::Pipeline),
}
impl Command<'_> {
    async fn query<T: redis::FromRedisValue>(
        &self,
        connection: &mut Transport,
    ) -> redis::RedisResult<T> {
        match self {
            Self::Single(command) => command.query_async(connection).await,
            Self::Pipeline(pipeline) => pipeline.query_async(connection).await,
        }
    }
}

impl Connection {
    fn generation(&self) -> u64 {
        match self {
            Self::Standalone(_, generation) => *generation,
            Self::Cluster(connection) => connection.generation,
        }
    }
    fn set_generation(&mut self, generation: u64) {
        match self {
            Self::Standalone(_, current) => *current = generation,
            Self::Cluster(connection) => connection.generation = generation,
        }
    }
    fn cluster_endpoints(&self) -> Vec<cluster::RedisEndpoint> {
        match self {
            Self::Cluster(connection) => connection.endpoints(),
            Self::Standalone(..) => Vec::new(),
        }
    }
    async fn query<T: redis::FromRedisValue>(
        &mut self,
        state: &SessionState,
        key: Option<&[u8]>,
        command: &redis::Cmd,
        dispatched: Option<&AtomicBool>,
    ) -> Result<T, RequestError> {
        self.run(state, key, Command::Single(command), dispatched, true)
            .await
    }
    /// Same-Key atomic read transaction. Nontransaction batches that retain per-command
    /// errors need their own redirection/ASKING strategy, rather than ignore_errors here.
    async fn query_pipeline<T: redis::FromRedisValue>(
        &mut self,
        state: &SessionState,
        key: &[u8],
        pipeline: &redis::Pipeline,
    ) -> Result<T, RequestError> {
        self.run(state, Some(key), Command::Pipeline(pipeline), None, true)
            .await
    }
    /// A generation-bound cursor must never be replayed after connection/topology recovery.
    async fn query_continuation_pipeline<T: redis::FromRedisValue>(
        &mut self,
        state: &SessionState,
        key: &[u8],
        pipeline: &redis::Pipeline,
    ) -> Result<T, RequestError> {
        self.run(state, Some(key), Command::Pipeline(pipeline), None, false)
            .await
    }
    async fn run<T: redis::FromRedisValue>(
        &mut self,
        state: &SessionState,
        key: Option<&[u8]>,
        command: Command<'_>,
        dispatched: Option<&AtomicBool>,
        recover_read: bool,
    ) -> Result<T, RequestError> {
        match self {
            Self::Standalone(connection, _) => {
                if let Some(dispatched) = dispatched {
                    dispatched.store(true, Ordering::Release);
                }
                let result = command.query(connection).await;
                if result
                    .as_ref()
                    .is_err_and(|cause| !cause.is_io_error() && !cause.is_timeout())
                {
                    if let Some(dispatched) = dispatched {
                        dispatched.store(false, Ordering::Release);
                    }
                }
                result.map_err(Into::into)
            }
            Self::Cluster(connection) => {
                connection
                    .query(state, key, command, dispatched, recover_read)
                    .await
            }
        }
    }
}

async fn open_connection(
    options: &StandaloneOptions,
    cluster: Option<&ClusterOptions>,
    sentinel: Option<&SentinelOptions>,
) -> Result<Connection, JsError> {
    match cluster {
        Some(cluster) => cluster::connect(options, cluster)
            .await
            .map(Connection::Cluster),
        None => match sentinel {
            Some(sentinel) => sentinel::connect(options, sentinel)
                .await
                .map(|connection| Connection::Standalone(connection, 1)),
            None => connect(options)
                .await
                .map(|connection| Connection::Standalone(connection, 1)),
        },
    }
}

async fn connect_inner(
    options: &StandaloneOptions,
    push: Option<redis::AsyncConnectionConfig>,
) -> Result<Transport, JsError> {
    let mut settings =
        redis::RedisConnectionInfo::default().set_db(options.database.unwrap_or(0).into());
    if let Some(username) = &options.username {
        settings = settings.set_username(username);
    }
    if let Some(password) = &options.password {
        settings = settings.set_password(password);
    }
    if push.is_some() {
        settings = settings.set_protocol(redis::ProtocolVersion::RESP3);
    }
    let info = (options.host.as_str(), options.port as u16)
        .into_connection_info()
        .map_err(|_| error("INVALID_CONFIGURATION", "Invalid Redis endpoint"))?
        .set_redis_settings(settings);
    let client = security::client(info, options.tls.as_ref())?;
    let config = push
        .unwrap_or_default()
        .set_connection_timeout(Some(Duration::from_millis(
            options.connect_timeout_ms.unwrap_or(3000).into(),
        )))
        .set_response_timeout(Some(Duration::from_millis(
            options.operation_timeout_ms.unwrap_or(5000).into(),
        )));
    let mut connection = if let Some(ssh) = &options.ssh {
        let stream = ssh::connect(
            ssh,
            &options.host,
            options.port as u16,
            options.proxy.as_ref(),
        )
        .await?;
        let stream = security::wrap_stream(stream, &options.host, options.tls.as_ref()).await?;
        Transport::from_stream(
            client.get_connection_info().redis_settings(),
            stream,
            config,
        )
        .await
        .map_err(|cause| classify_setup(cause, options.tls.is_some()))?
    } else if let Some(proxy) = &options.proxy {
        let stream = proxy::connect(proxy, &options.host, options.port as u16).await?;
        let stream = security::wrap_stream(stream, &options.host, options.tls.as_ref()).await?;
        Transport::from_stream(
            client.get_connection_info().redis_settings(),
            stream,
            config,
        )
        .await
        .map_err(|cause| classify_setup(cause, options.tls.is_some()))?
    } else {
        Transport::direct(
            security::connect(client, config)
                .await
                .map_err(|cause| classify_setup(cause, options.tls.is_some()))?,
        )
    };
    redis::cmd("PING")
        .query_async::<String>(&mut connection)
        .await
        .map_err(|cause| classify_setup(cause, options.tls.is_some()))?;
    connection.endpoint = Some(cluster::RedisEndpoint {
        host: options.host.clone(),
        port: options.port,
    });
    Ok(connection)
}

fn classify_setup(cause: redis::RedisError, tls: bool) -> JsError {
    if tls && let Some(classified) = security::classify_setup(&cause) {
        classified
    } else {
        classify(cause)
    }
}

fn classify(cause: redis::RedisError) -> JsError {
    let server_code = keys::server_code(&cause);
    let classified = if let Some(error) = security::classify(&cause) {
        error
    } else if cause.kind() == redis::ErrorKind::AuthenticationFailed
        || matches!(cause.code(), Some("NOAUTH" | "WRONGPASS"))
    {
        error("AUTHENTICATION_FAILED", "Redis authentication was rejected")
    } else if server_code.as_deref() == Some("NOPERM") {
        error("PERMISSION_DENIED", "Redis command permission was denied")
    } else if server_code.as_deref() == Some("CROSSSLOT") {
        error(
            "CROSS_SLOT",
            "Redis Cluster requires both Keys in the same hash slot",
        )
    } else if cause.code() == Some("WRONGTYPE")
        || cause
            .clone()
            .into_server_errors()
            .is_some_and(|errors| errors.iter().any(|(_, cause)| cause.code() == "WRONGTYPE"))
    {
        error("WRONG_TYPE", "Redis value has a different type")
    } else if cause.is_timeout() {
        error("TIMEOUT", "Redis request exceeded its deadline")
    } else if cause.is_io_error() {
        error("CONNECTION_FAILED", "Could not communicate with Redis")
    } else {
        // Server text may echo user input. Only a stable category crosses the bridge.
        error("SERVER_ERROR", "Redis rejected the request")
    };
    if let Some(server_code) = server_code {
        classified.with("serverCode", server_code)
    } else {
        classified
    }
}

fn runtime() -> Result<&'static Runtime, JsError> {
    static RUNTIME: OnceLock<Result<Runtime, std::io::Error>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("ferrix-redis")
                .enable_all()
                .build()
        })
        .as_ref()
        .map_err(|_| error("UNAVAILABLE", "Redis worker runtime is unavailable"))
}

fn error(code: &str, message: &str) -> JsError {
    JsError::Error(message.into()).with_code(code)
}
fn closed() -> JsError {
    error("SESSION_CLOSED", "Redis Session is closed")
}

fn unknown_write() -> JsError {
    error(
        "WRITE_OUTCOME_UNKNOWN",
        "Redis write may have executed; refresh before retrying",
    )
}
