//! Native interfaces exposed to TSX through the crate's registry.

mod app_store;
mod connection_credentials;
mod credential_backends;
mod credential_settings;
mod keepass_vault;
mod key_inventory;
mod key_rows;
mod key_tree;
#[cfg(target_os = "macos")]
mod mac_keychain_vault;
pub(crate) use credential_settings::CredentialSettings;
mod redis;
mod security;
mod value_codec;
mod version;
pub(crate) use app_store::AppStore;
pub(crate) use key_inventory::KeyInventory;
pub(crate) use key_rows::KeyRows;
pub(crate) use redis::{
    Redis, RedisConsole, RedisHashScan, RedisKeyScan, RedisPubSub, RedisSession, RedisSetScan,
};
pub(crate) use value_codec::ValueCodec;
pub(crate) use version::Version;
