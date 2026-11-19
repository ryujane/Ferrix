//! Application build information exposed to TSX.

use nsh_core::prelude::*;

/// Build information for Ferrix's Rust crate.
#[module]
pub struct Version;

#[module]
impl Version {
    /// The Rust crate's package version from `Cargo.toml`.
    pub fn get_version() -> String {
        env!("CARGO_PKG_VERSION").to_owned()
    }
}
