//! Ferrix's Rust crate and the registration point for `ferrix/native`.
//!
//! Export implementations live in `native`; NSH generates their TypeScript
//! declarations in `.nsh/types/ferrix/native.d.ts`.

mod native;
use native::{
    AppStore, CredentialSettings, KeyInventory, KeyRows, Redis, RedisConsole, RedisHashScan,
    RedisKeyScan, RedisPubSub, RedisSession, RedisSetScan, ValueCodec, Version,
};
use nsh_core::prelude::*;

/// The components, modules and classes available to the TSX UI.
#[native_module("ferrix/native")]
fn register_native(registry: &mut Registry) {
    registry
        .register::<KeyRows>()
        .class::<KeyInventory>()
        .module::<Version>()
        .module::<AppStore>()
        .module::<CredentialSettings>()
        .module::<Redis>()
        .module::<ValueCodec>()
        .class::<RedisSession>()
        .class::<RedisConsole>()
        .class::<RedisKeyScan>()
        .class::<RedisHashScan>()
        .class::<RedisSetScan>()
        .class::<RedisPubSub>();
}
