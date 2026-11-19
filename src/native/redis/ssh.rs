//! Pinned SSH direct-tcpip transport. No shell or local listening port is used.
use super::*;
use russh::{
    client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_util::sync::CancellationToken;

/// A verified SSH gateway shared by every endpoint of this Redis Session.
/// Credentials are runtime inputs only. Ed25519 and ECDSA keys are supported.
#[derive(Clone, JsObject)]
pub struct RedisSshOptions {
    /// Gateway DNS name or IP address, without a scheme or port.
    pub host: String,
    /// Gateway TCP port; defaults to 22.
    pub port: Option<u32>,
    pub username: String,
    /// Supply exactly one of password and privateKey.
    pub password: Option<String>,
    /// OpenSSH or PEM private-key contents, never a filesystem path.
    pub private_key: Option<String>,
    /// Passphrase for an encrypted privateKey.
    pub private_key_passphrase: Option<String>,
    /// Trusted OpenSSH SHA256:... host-key fingerprint, obtained independently.
    /// Mandatory; neither TOFU nor an insecure bypass is supported.
    pub host_key_sha256: String,
}

impl RedisSshOptions {
    pub(super) fn validate(&self) -> Result<(), JsError> {
        let fingerprint = &self.host_key_sha256;
        if self.host.is_empty()
            || self.host.len() > 253
            || self
                .host
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "/@?#".contains(c))
            || !(1..=65535).contains(&self.port.unwrap_or(22))
            || self.username.is_empty()
            || self.username.len() > 256
            || self.username.chars().any(|c| c.is_control())
            || self.password.is_some() == self.private_key.is_some()
            || (self.private_key_passphrase.is_some() && self.private_key.is_none())
            || self
                .private_key
                .as_ref()
                .is_some_and(|key| key.is_empty() || key.len() > 1_048_576)
            || fingerprint.len() != 50
            || !fingerprint.starts_with("SHA256:")
            || !fingerprint[7..]
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"+/".contains(&c))
        {
            return Err(error(
                "SSH_CONFIGURATION_INVALID",
                "Invalid SSH gateway, credentials or SHA256 host-key fingerprint",
            ));
        }
        Ok(())
    }
}

pub(super) fn is_security_error(cause: &JsError) -> bool {
    matches!(
        cause.code(),
        Some(
            "SSH_HOST_KEY_MISMATCH"
                | "SSH_AUTHENTICATION_FAILED"
                | "SSH_KEY_INVALID"
                | "SSH_KEY_UNSUPPORTED"
        )
    )
}

struct HostKey {
    expected: String,
    rejected: Arc<AtomicBool>,
}

impl client::Handler for HostKey {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let matches = key.public_key().fingerprint(HashAlg::Sha256).to_string() == self.expected;
        self.rejected.store(!matches, Ordering::Release);
        Ok(matches)
    }
}

// Dropping russh's Handle alone does not stop its detached transport task.
// Wake its underlying socket on cancellation, including handshake cancellation.
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

struct CancellableSocket {
    socket: tokio::net::TcpStream,
    cancelled: Pin<Box<dyn Future<Output = ()> + Send>>,
}
impl CancellableSocket {
    fn check(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.cancelled.as_mut().poll(cx).is_ready() {
            Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "SSH transport closed",
            ))
        } else {
            Ok(())
        }
    }
}
impl AsyncRead for CancellableSocket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check(cx)?;
        Pin::new(&mut self.socket).poll_read(cx, buf)
    }
}
impl AsyncWrite for CancellableSocket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check(cx)?;
        Pin::new(&mut self.socket).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check(cx)?;
        Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check(cx)?;
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

pub(super) struct SshStream {
    channel: russh::ChannelStream<client::Msg>,
    _session: client::Handle<HostKey>,
    _cancel: CancelOnDrop,
}
impl AsyncRead for SshStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.channel).poll_read(cx, buf)
    }
}
impl AsyncWrite for SshStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.channel).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.channel).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.channel).poll_shutdown(cx)
    }
}

pub(super) async fn connect(
    options: &RedisSshOptions,
    host: &str,
    port: u16,
    proxy: Option<&RedisProxyOptions>,
) -> Result<SshStream, JsError> {
    // Key derivation can be CPU intensive. Keep it off both the UI and I/O workers.
    let key = if let Some(encoded) = &options.private_key {
        // A cancelled spawn_blocking task can finish after its opening Session
        // has released admission. Keep its permit until the CPU work actually
        // ends so abandoned encrypted-key setups cannot grow an unbounded pool.
        static KEY_JOBS: OnceLock<Arc<Semaphore>> = OnceLock::new();
        let permit = KEY_JOBS
            .get_or_init(|| Arc::new(Semaphore::new(2)))
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| error("SSH_KEY_INVALID", "SSH key loader is unavailable"))?;
        let encoded = encoded.clone();
        let passphrase = options.private_key_passphrase.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let key = russh::keys::decode_secret_key(&encoded, passphrase.as_deref()).map_err(
                    |_| {
                        error(
                            "SSH_KEY_INVALID",
                            "SSH private key or passphrase is invalid or unsupported",
                        )
                    },
                )?;
                if !matches!(
                    key.algorithm(),
                    russh::keys::Algorithm::Ed25519 | russh::keys::Algorithm::Ecdsa { .. }
                ) {
                    return Err(error(
                        "SSH_KEY_UNSUPPORTED",
                        "Use an Ed25519 or ECDSA SSH private key",
                    ));
                }
                Ok(Arc::new(key))
            })
            .await
            .map_err(|_| error("SSH_KEY_INVALID", "SSH private key could not be loaded"))??,
        )
    } else {
        None
    };
    let rejected = Arc::new(AtomicBool::new(false));
    let cancel = CancelOnDrop(CancellationToken::new());
    let socket = if let Some(proxy) = proxy {
        super::proxy::connect(proxy, &options.host, options.port.unwrap_or(22) as u16).await?
    } else {
        tokio::net::TcpStream::connect((options.host.as_str(), options.port.unwrap_or(22) as u16))
            .await
            .map_err(|_| {
                error(
                    "SSH_CONNECTION_FAILED",
                    "Could not connect to the SSH gateway",
                )
            })?
    };
    socket.set_nodelay(true).ok();
    let socket = CancellableSocket {
        socket,
        cancelled: Box::pin(cancel.0.clone().cancelled_owned()),
    };
    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    };
    let mut session = client::connect_stream(
        Arc::new(config),
        socket,
        HostKey {
            expected: options.host_key_sha256.clone(),
            rejected: rejected.clone(),
        },
    )
    .await
    .map_err(|_| {
        if rejected.load(Ordering::Acquire) {
            error(
                "SSH_HOST_KEY_MISMATCH",
                "SSH gateway host key does not match the trusted fingerprint",
            )
        } else {
            error("SSH_CONNECTION_FAILED", "SSH handshake failed")
        }
    })?;
    let authenticated = if let Some(key) = key {
        session
            .authenticate_publickey(&options.username, PrivateKeyWithHashAlg::new(key, None))
            .await
    } else {
        session
            .authenticate_password(
                &options.username,
                options.password.as_deref().unwrap_or_default(),
            )
            .await
    }
    .map_err(|_| error("SSH_AUTHENTICATION_FAILED", "SSH authentication failed"))?;
    if !authenticated.success() {
        return Err(error(
            "SSH_AUTHENTICATION_FAILED",
            "SSH authentication was rejected",
        ));
    }
    let channel = session
        .channel_open_direct_tcpip(host, port.into(), "127.0.0.1", 0)
        .await
        .map_err(|_| {
            error(
                "SSH_CHANNEL_FAILED",
                "SSH gateway could not open the Redis endpoint",
            )
        })?;
    Ok(SshStream {
        channel: channel.into_stream(),
        _session: session,
        _cancel: cancel,
    })
}
