//! Verified transport settings shared by directly addressed Redis connections.

use nsh_core::prelude::*;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use std::{error::Error, net::SocketAddr, sync::Arc};

/// Verified TLS. No insecure certificate or hostname bypass is supported.
#[derive(Clone, JsObject)]
pub struct RedisTlsOptions {
    /// PEM certificate-authority bundle. Omit to use native system trust roots.
    /// When supplied, this bundle replaces the system roots.
    pub ca_certificate_pem: Option<String>,
    /// PEM client certificate chain, accompanied by its matching private key.
    pub client_certificate_pem: Option<String>,
    /// PEM private key. Runtime input only; never included in diagnostics.
    pub client_private_key_pem: Option<String>,
}

impl RedisTlsOptions {
    /// Shared validated security input for direct, Cluster and Sentinel builders.
    /// Parsing stays on the Redis worker, never the native bridge's engine thread.
    pub(super) fn certificates(&self) -> Result<redis::TlsCertificates, JsError> {
        // Explicitly choose one provider, including when another dependency enables one too.
        let _ = rustls::crypto::ring::default_provider().install_default();
        if self.client_certificate_pem.is_some() != self.client_private_key_pem.is_some() {
            return Err(invalid_material());
        }
        if let Some(pem) = &self.ca_certificate_pem {
            let mut roots = rustls::RootCertStore::empty();
            for certificate in certificates(pem)? {
                roots.add(certificate).map_err(|_| invalid_material())?;
            }
        }
        let client_tls = match (&self.client_certificate_pem, &self.client_private_key_pem) {
            (Some(cert), Some(key)) => {
                let chain = certificates(cert)?;
                let key_der = PrivateKeyDer::from_pem_slice(key.as_bytes())
                    .map_err(|_| invalid_material())?;
                // Validates supported key encoding, leaf DER and certificate/key agreement.
                rustls::ClientConfig::builder()
                    .with_root_certificates(rustls::RootCertStore::empty())
                    .with_client_auth_cert(chain, key_der)
                    .map_err(|_| invalid_material())?;
                Some(redis::ClientTlsConfig {
                    client_cert: cert.as_bytes().to_vec(),
                    client_key: key.as_bytes().to_vec(),
                })
            }
            _ => None,
        };
        Ok(redis::TlsCertificates {
            root_cert: self
                .ca_certificate_pem
                .as_ref()
                .map(|pem| pem.as_bytes().to_vec()),
            client_tls,
        })
    }
}

fn certificates(pem: &str) -> Result<Vec<CertificateDer<'static>>, JsError> {
    let certificates = CertificateDer::pem_slice_iter(pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid_material())?;
    if certificates.is_empty() {
        return Err(invalid_material());
    }
    Ok(certificates)
}

pub(super) fn client(
    info: redis::ConnectionInfo,
    tls: Option<&RedisTlsOptions>,
) -> Result<redis::Client, JsError> {
    let Some(tls) = tls else {
        return redis::Client::open(info).map_err(|_| {
            JsError::Error("Invalid Redis connection settings".into())
                .with_code("INVALID_CONFIGURATION")
        });
    };
    let (host, port) = match info.addr() {
        redis::ConnectionAddr::Tcp(host, port) => (host.clone(), *port),
        _ => return Err(invalid_material()),
    };
    let info = info.set_addr(redis::ConnectionAddr::TcpTls {
        host,
        port,
        insecure: false,
        tls_params: None,
    });
    redis::Client::build_with_tls(info, tls.certificates()?).map_err(|_| invalid_material())
}

fn invalid_material() -> JsError {
    JsError::Error("Invalid TLS certificate or private-key material".into())
        .with_code("TLS_CONFIGURATION_INVALID")
}

/// Apply end-to-end TLS to a tunnel, preserving the Redis endpoint's identity.
pub(super) async fn wrap_stream(
    stream: impl redis::aio::AsyncStream + Send + Unpin + 'static,
    host: &str,
    tls: Option<&RedisTlsOptions>,
) -> Result<Box<dyn redis::aio::AsyncStream + Send + Unpin>, JsError> {
    let Some(tls) = tls else {
        return Ok(Box::new(stream));
    };
    tls.certificates()?;
    let mut roots = rustls::RootCertStore::empty();
    if let Some(pem) = &tls.ca_certificate_pem {
        for certificate in certificates(pem)? {
            roots.add(certificate).map_err(|_| invalid_material())?;
        }
    } else {
        let native = rustls_native_certs::load_native_certs();
        for certificate in native.certs {
            // An unusable native root must not discard the usable native roots.
            let _ = roots.add(certificate);
        }
        if roots.is_empty() {
            return Err(invalid_material());
        }
    }
    let builder = rustls::ClientConfig::builder().with_root_certificates(roots);
    let config = match (&tls.client_certificate_pem, &tls.client_private_key_pem) {
        (Some(cert), Some(key)) => builder
            .with_client_auth_cert(
                certificates(cert)?,
                PrivateKeyDer::from_pem_slice(key.as_bytes()).map_err(|_| invalid_material())?,
            )
            .map_err(|_| invalid_material())?,
        _ => builder.with_no_client_auth(),
    };
    let name =
        rustls::pki_types::ServerName::try_from(host.to_owned()).map_err(|_| invalid_material())?;
    let stream = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .map_err(|cause| {
            let cause: redis::RedisError = cause.into();
            classify_setup(&cause).unwrap_or_else(|| {
                JsError::Error("Redis TLS handshake failed".into())
                    .with_code("TLS_HANDSHAKE_FAILED")
            })
        })?;
    Ok(Box::new(stream))
}

/// Keep the first definitive security/authentication failure across DNS addresses.
/// redis-rs otherwise returns only the last failed address, which can hide a
/// certificate rejection behind a slower IPv6 refusal or timeout.
pub(super) async fn connect(
    client: redis::Client,
    config: redis::AsyncConnectionConfig,
) -> redis::RedisResult<redis::aio::MultiplexedConnection> {
    let redis::ConnectionAddr::TcpTls { host, port, .. } = client.get_connection_info().addr()
    else {
        return client
            .get_multiplexed_async_connection_with_config(&config)
            .await;
    };
    let addresses = tokio::net::lookup_host((host.as_str(), *port)).await?;
    let mut attempts = tokio::task::JoinSet::new();
    for address in addresses {
        let client = client.clone();
        let config = config.clone().set_dns_resolver(OneAddress(address));
        attempts.spawn(async move {
            client
                .get_multiplexed_async_connection_with_config(&config)
                .await
        });
    }
    let mut last = std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "Redis endpoint has no addresses",
    )
    .into();
    while let Some(result) = attempts.join_next().await {
        match result {
            Ok(Ok(connection)) => return Ok(connection),
            Ok(Err(cause)) => {
                if classify_setup(&cause).is_some()
                    || cause.kind() == redis::ErrorKind::AuthenticationFailed
                {
                    return Err(cause);
                }
                last = cause;
            }
            Err(_) => return Err(std::io::Error::other("Redis connection task ended").into()),
        }
    }
    Err(last)
}

struct OneAddress(SocketAddr);
impl redis::io::AsyncDNSResolver for OneAddress {
    fn resolve<'a, 'b: 'a>(
        &'a self,
        _host: &'b str,
        _port: u16,
    ) -> redis::RedisFuture<'a, Box<dyn Iterator<Item = SocketAddr> + Send + 'a>> {
        Box::pin(async move {
            Ok(Box::new(std::iter::once(self.0)) as Box<dyn Iterator<Item = SocketAddr> + Send>)
        })
    }
}

/// Classify structured TLS causes without inspecting or returning backend text.
pub(super) fn classify(cause: &redis::RedisError) -> Option<JsError> {
    let cause = tls_cause(cause)?;
    let (code, message) = match cause {
        rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer) => (
            "TLS_UNTRUSTED_ISSUER",
            "Redis certificate issuer is not trusted",
        ),
        rustls::Error::InvalidCertificate(
            rustls::CertificateError::NotValidForName
            | rustls::CertificateError::NotValidForNameContext { .. },
        ) => (
            "TLS_HOSTNAME_MISMATCH",
            "Redis certificate does not match the endpoint hostname",
        ),
        _ => (
            "TLS_HANDSHAKE_FAILED",
            "Redis TLS verification or handshake failed",
        ),
    };
    Some(JsError::Error(message.into()).with_code(code))
}

/// During verified TLS setup, a peer can close before rustls receives its alert
/// (notably a TLS 1.3 server requiring a missing client certificate). This is a
/// failed TLS session setup, without inferring a certificate cause from text.
/// Refusal/DNS failures remain transport errors; established-session I/O never
/// uses this phase-specific fallback.
pub(super) fn classify_setup(cause: &redis::RedisError) -> Option<JsError> {
    classify(cause).or_else(|| {
        (cause.is_io_error() && cause.is_connection_dropped() && !cause.is_connection_refusal())
            .then(|| {
                JsError::Error("Redis TLS peer closed during connection setup".into())
                    .with_code("TLS_HANDSHAKE_FAILED")
            })
    })
}

fn tls_cause<'a>(cause: &'a (dyn Error + 'static)) -> Option<&'a rustls::Error> {
    if let Some(cause) = cause.downcast_ref::<rustls::Error>() {
        return Some(cause);
    }
    if let Some(cause) = cause.downcast_ref::<Arc<dyn Error + Send + Sync>>() {
        return tls_cause(cause.as_ref());
    }
    if let Some(cause) = cause.downcast_ref::<std::io::Error>() {
        return cause.get_ref().and_then(|cause| tls_cause(cause));
    }
    cause.source().and_then(tls_cause)
}
