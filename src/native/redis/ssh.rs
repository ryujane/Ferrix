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
mod rsa_key;
use rsa_key::RsaLoginKey;

/// Gateway and network route for retrieving a host key before SSH login.
#[derive(JsObject)]
pub struct SshHostKeyOptions {
    pub host: String,
    /// Gateway TCP port; defaults to 22.
    pub port: Option<u32>,
    pub proxy: Option<RedisProxyOptions>,
    /// Connection setup deadline in milliseconds; defaults to 3000.
    pub connect_timeout_ms: Option<u32>,
}

/// A verified SSH gateway shared by every endpoint of this Redis Session.
/// Credentials are runtime inputs only. Ed25519, ECDSA and RSA SHA-2 login keys are supported.
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
    /// Trusted OpenSSH SHA256:... host-key fingerprint. Required for SSH login.
    pub host_key_sha256: String,
}

fn valid_gateway(host: &str, port: u32) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "/@?#".contains(c))
        && (1..=65535).contains(&port)
}

impl RedisSshOptions {
    pub(super) fn validate(&self) -> Result<(), JsError> {
        let fingerprint = &self.host_key_sha256;
        if !valid_gateway(&self.host, self.port.unwrap_or(22))
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
                | "SSH_RSA_SHA2_REQUIRED"
        )
    )
}

enum HostKey {
    Pinned {
        expected: String,
        rejected: Arc<AtomicBool>,
    },
    Probe(Arc<OnceLock<String>>),
}

impl client::Handler for HostKey {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        match self {
            Self::Pinned { expected, rejected } => {
                let matches = fingerprint == *expected;
                rejected.store(!matches, Ordering::Release);
                Ok(matches)
            }
            Self::Probe(observed) => {
                let _ = observed.set(fingerprint);
                Ok(false)
            }
        }
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

async fn open_gateway(
    host: &str,
    port: u16,
    proxy: Option<&RedisProxyOptions>,
    host_key: HostKey,
) -> Result<(client::Handle<HostKey>, CancelOnDrop), JsError> {
    let cancel = CancelOnDrop(CancellationToken::new());
    let socket = if let Some(proxy) = proxy {
        super::proxy::connect(proxy, host, port).await?
    } else {
        tokio::net::TcpStream::connect((host, port))
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
    let session = client::connect_stream(Arc::new(config), socket, host_key)
        .await
        .map_err(|_| error("SSH_CONNECTION_FAILED", "SSH handshake failed"))?;
    Ok((session, cancel))
}

pub(super) fn probe_host_key(options: SshHostKeyOptions) -> Result<Later<String>, JsError> {
    let port = options.port.unwrap_or(22);
    let timeout = options.connect_timeout_ms.unwrap_or(3000);
    if !valid_gateway(&options.host, port) || !(10..=120_000).contains(&timeout) {
        return Err(error(
            "SSH_CONFIGURATION_INVALID",
            "Invalid SSH gateway or deadline",
        ));
    }
    if let Some(proxy) = &options.proxy {
        proxy.validate()?;
    }
    static PROBES: Semaphore = Semaphore::const_new(8);
    let permit = PROBES
        .try_acquire()
        .map_err(|_| error("BUSY", "SSH host key checks are busy"))?;
    let (mut tx, rx) = oneshot::channel();
    runtime()?.spawn(async move {
        let _permit = permit;
        let result = tokio::select! {
            _ = tx.closed() => return,
            result = tokio::time::timeout(
                Duration::from_millis(timeout.into()),
                observe_host_key(&options.host, port as u16, options.proxy.as_ref()),
            ) => result.unwrap_or_else(|_| Err(error("TIMEOUT", "SSH handshake timed out"))),
        };
        let _ = tx.send(result);
    });
    Ok(Later::new(async move {
        rx.await.unwrap_or_else(|_| Err(closed()))
    }))
}

async fn observe_host_key(
    host: &str,
    port: u16,
    proxy: Option<&RedisProxyOptions>,
) -> Result<String, JsError> {
    let observed = Arc::new(OnceLock::new());
    let result = open_gateway(host, port, proxy, HostKey::Probe(observed.clone())).await;
    if let Some(fingerprint) = observed.get() {
        return Ok(fingerprint.clone());
    }
    result?;
    Err(error(
        "SSH_CONNECTION_FAILED",
        "SSH gateway did not present a host key",
    ))
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

enum LoginKey {
    Standard(Arc<russh::keys::PrivateKey>),
    Rsa(RsaLoginKey),
}

fn key_invalid() -> JsError {
    error(
        "SSH_KEY_INVALID",
        "SSH private key or passphrase is invalid",
    )
}

fn load_private_key(encoded: &str, passphrase: Option<&str>) -> Result<LoginKey, JsError> {
    use russh::keys::{Algorithm, Error as KeyError, decode_secret_key};

    let encoded = encoded.trim();
    if encoded.starts_with("-----BEGIN RSA PRIVATE KEY-----") {
        return RsaLoginKey::from_pem(encoded, passphrase).map(LoginKey::Rsa);
    }
    let key = match decode_secret_key(encoded, passphrase) {
        Ok(key) => key,
        Err(KeyError::UnknownAlgorithm(oid)) if oid == rsa::pkcs1::ALGORITHM_OID => {
            return RsaLoginKey::from_pem(encoded, passphrase).map(LoginKey::Rsa);
        }
        Err(KeyError::UnknownAlgorithm(_) | KeyError::UnsupportedKeyType { .. }) => {
            return Err(error(
                "SSH_KEY_UNSUPPORTED",
                "Use an Ed25519, ECDSA or RSA SSH private key",
            ));
        }
        Err(_) => return Err(key_invalid()),
    };
    if let Some(rsa) = key.key_data().rsa() {
        return RsaLoginKey::from_openssh(rsa).map(LoginKey::Rsa);
    }
    if matches!(
        key.algorithm(),
        Algorithm::Ed25519 | Algorithm::Ecdsa { .. }
    ) {
        return Ok(LoginKey::Standard(Arc::new(key)));
    }
    Err(error(
        "SSH_KEY_UNSUPPORTED",
        "Use an Ed25519, ECDSA or RSA SSH private key",
    ))
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
                load_private_key(&encoded, passphrase.as_deref())
            })
            .await
            .map_err(|_| error("SSH_KEY_INVALID", "SSH private key could not be loaded"))??,
        )
    } else {
        None
    };
    let rejected = Arc::new(AtomicBool::new(false));
    let (mut session, cancel) = open_gateway(
        &options.host,
        options.port.unwrap_or(22) as u16,
        proxy,
        HostKey::Pinned {
            expected: options.host_key_sha256.clone(),
            rejected: rejected.clone(),
        },
    )
    .await
    .map_err(|cause| {
        if rejected.load(Ordering::Acquire) {
            error(
                "SSH_HOST_KEY_MISMATCH",
                "SSH gateway host key does not match the trusted fingerprint",
            )
        } else {
            cause
        }
    })?;
    let auth_failed = |_| error("SSH_AUTHENTICATION_FAILED", "SSH authentication failed");
    let authenticated = match key {
        Some(LoginKey::Standard(key)) => session
            .authenticate_publickey(&options.username, PrivateKeyWithHashAlg::new(key, None))
            .await
            .map_err(auth_failed)?,
        Some(LoginKey::Rsa(mut key)) => key.authenticate(&mut session, &options.username).await?,
        None => session
            .authenticate_password(
                &options.username,
                options.password.as_deref().unwrap_or_default(),
            )
            .await
            .map_err(auth_failed)?,
    };
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

#[cfg(test)]
mod tests {
    use super::*;
    use russh::server;
    use std::sync::atomic::AtomicUsize;
    use tokio::net::TcpListener;

    struct Gateway(Arc<AtomicUsize>);

    impl server::Handler for Gateway {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<server::Auth, Self::Error> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(server::Auth::reject())
        }
    }

    #[tokio::test]
    async fn ssh_host_key_probe_and_mismatch_end_before_authentication() {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
        let key = russh::keys::decode_secret_key(&key.serialize_pem(), None).unwrap();
        let expected = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let server = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let auth_attempts = Arc::new(AtomicUsize::new(0));
        let attempts = auth_attempts.clone();
        let gateway = tokio::spawn(async move {
            for _ in 0..3 {
                let (socket, _) = listener.accept().await.unwrap();
                let _ = server::run_stream(server.clone(), socket, Gateway(attempts.clone())).await;
            }
        });

        tokio::time::timeout(Duration::from_secs(10), async {
            let host = "127.0.0.1";
            assert_eq!(observe_host_key(host, port, None).await.unwrap(), expected);
            assert_eq!(auth_attempts.load(Ordering::Relaxed), 0);

            let mut options = RedisSshOptions {
                host: host.into(),
                port: Some(port.into()),
                username: "ferrix-test".into(),
                password: Some("test-password".into()),
                private_key: None,
                private_key_passphrase: None,
                host_key_sha256: format!("SHA256:{}", "A".repeat(43)),
            };
            options.validate().unwrap();
            let mismatch = connect(&options, host, 6379, None).await.err().unwrap();
            assert_eq!(mismatch.code(), Some("SSH_HOST_KEY_MISMATCH"));
            assert_eq!(auth_attempts.load(Ordering::Relaxed), 0);

            options.host_key_sha256 = expected;
            let rejected_login = connect(&options, host, 6379, None).await.err().unwrap();
            assert_eq!(rejected_login.code(), Some("SSH_AUTHENTICATION_FAILED"));
            assert_eq!(auth_attempts.load(Ordering::Relaxed), 1);
            gateway.await.unwrap();
        })
        .await
        .unwrap();
    }
}
