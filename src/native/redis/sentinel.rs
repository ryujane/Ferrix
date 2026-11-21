//! Finite Sentinel discovery. Every replacement resolves and ROLE-validates afresh;
//! the resulting data transport has no automatic mutation replay machinery.
use super::{cluster::RedisEndpoint, *};

/// A named primary group and separate Sentinel-facing and data-facing security.
#[derive(Clone, JsObject)]
pub struct SentinelOptions {
    /// Between one and 32 Sentinel endpoints, tried within one setup deadline.
    pub endpoints: Vec<RedisEndpoint>,
    pub primary_group: String,
    pub sentinel_username: Option<String>,
    pub sentinel_password: Option<String>,
    pub sentinel_tls: Option<RedisTlsOptions>,
    /// Data-node authentication and verified TLS, independent from Sentinel settings.
    pub username: Option<String>,
    pub password: Option<String>,
    pub tls: Option<RedisTlsOptions>,
    /// Pinned SSH gateway for both Sentinel endpoints and discovered data nodes.
    pub ssh: Option<RedisSshOptions>,
    /// Network proxy for Sentinel endpoints, discovered nodes or the SSH gateway.
    pub proxy: Option<RedisProxyOptions>,
    pub database: Option<u32>,
    pub connect_timeout_ms: Option<u32>,
    pub operation_timeout_ms: Option<u32>,
    pub max_response_bytes: Option<u32>,
}

impl SentinelOptions {
    pub(super) fn validate(&self) -> Result<StandaloneOptions, JsError> {
        if self.endpoints.is_empty()
            || self.endpoints.len() > 32
            || self.primary_group.is_empty()
            || self.primary_group.len() > 512
            || self.primary_group.chars().any(|c| c.is_control())
        {
            return Err(error(
                "INVALID_CONFIGURATION",
                "Supply one to 32 Sentinels and a nonempty primary group",
            ));
        }
        let common = StandaloneOptions {
            host: self.endpoints[0].host.clone(),
            port: self.endpoints[0].port,
            username: self.username.clone(),
            password: self.password.clone(),
            tls: self.tls.clone(),
            ssh: self.ssh.clone(),
            proxy: self.proxy.clone(),
            database: self.database,
            connect_timeout_ms: self.connect_timeout_ms,
            operation_timeout_ms: self.operation_timeout_ms,
            max_response_bytes: self.max_response_bytes,
        };
        common.validate()?;
        for endpoint in &self.endpoints {
            self.sentinel_options(&common, endpoint).validate()?;
        }
        Ok(common)
    }

    fn sentinel_options(
        &self,
        common: &StandaloneOptions,
        endpoint: &RedisEndpoint,
    ) -> StandaloneOptions {
        StandaloneOptions {
            host: endpoint.host.clone(),
            port: endpoint.port,
            username: self.sentinel_username.clone(),
            password: self.sentinel_password.clone(),
            tls: self.sentinel_tls.clone(),
            database: Some(0),
            ..common.clone()
        }
    }
}

pub(super) async fn connect(
    common: &StandaloneOptions,
    options: &SentinelOptions,
) -> Result<Transport, JsError> {
    connect_configured(common, options, None).await
}

pub(super) async fn connect_configured(
    common: &StandaloneOptions,
    options: &SentinelOptions,
    push: Option<redis::AsyncConnectionConfig>,
) -> Result<Transport, JsError> {
    // Preserve a definitive rejection even if a later endpoint consumes the
    // remaining overall deadline. A timeout must not hide the actionable cause.
    let mut definitive = None;
    let result = tokio::time::timeout(
        Duration::from_millis(common.connect_timeout_ms.unwrap_or(3000).into()),
        async {
            let mut last = error(
                "SENTINEL_GROUP_NOT_FOUND",
                "Sentinels do not know the primary group",
            );
            let budget = (common.connect_timeout_ms.unwrap_or(3000)
                / options.endpoints.len() as u32)
                .max(10);
            for endpoint in &options.endpoints {
                let attempt = async {
                    let mut settings = options.sentinel_options(common, endpoint);
                    settings.connect_timeout_ms = Some(budget);
                    let mut sentinel = super::connect(&settings)
                        .await
                        .map_err(|cause| cause.with("phase", "sentinel"))?;
                    let address: Option<(String, u32)> = redis::cmd("SENTINEL")
                        .arg("get-master-addr-by-name")
                        .arg(&options.primary_group)
                        .query_async(&mut sentinel)
                        .await
                        .map_err(|cause| classify(cause).with("phase", "sentinel"))?;
                    let Some((host, port)) = address else {
                        return Err(error(
                            "SENTINEL_GROUP_NOT_FOUND",
                            "Sentinels do not know the primary group",
                        )
                        .with("phase", "sentinel"));
                    };
                    let data_options = StandaloneOptions {
                        host,
                        port,
                        ..common.clone()
                    };
                    data_options
                        .validate()
                        .map_err(|cause| cause.with("phase", "data"))?;
                    let mut data = super::connect_configured(&data_options, push.clone())
                        .await
                        .map_err(|cause| cause.with("phase", "data"))?;
                    let role: Vec<redis::Value> =
                        redis::cmd("ROLE")
                            .query_async(&mut data)
                            .await
                            .map_err(|cause| classify(cause).with("phase", "primary-validation"))?;
                    if role
                        .first()
                        .and_then(|role| redis::from_redis_value::<String>(role.clone()).ok())
                        .as_deref()
                        != Some("master")
                    {
                        return Err(error(
                            "SENTINEL_PRIMARY_UNAVAILABLE",
                            "Sentinel candidate is not a primary",
                        )
                        .with("phase", "primary-validation"));
                    }
                    Ok(data)
                };
                match tokio::time::timeout(Duration::from_millis(budget.into()), attempt).await {
                    Ok(Ok(connection)) => return Ok(connection),
                    Ok(Err(cause)) => {
                        if proxy::is_terminal_error(&cause) {
                            return Err(cause);
                        }
                        if matches!(
                            cause.code(),
                            Some(
                                "AUTHENTICATION_FAILED"
                                    | "SENTINEL_PRIMARY_UNAVAILABLE"
                                    | "PERMISSION_DENIED"
                                    | "TLS_CONFIGURATION_INVALID"
                                    | "TLS_UNTRUSTED_ISSUER"
                                    | "TLS_HOSTNAME_MISMATCH"
                                    | "TLS_HANDSHAKE_FAILED"
                            )
                        ) || ssh::is_security_error(&cause)
                        {
                            definitive.get_or_insert_with(|| cause.clone());
                        }
                        last = cause;
                    }
                    Err(_) => {
                        last = error("TIMEOUT", "Sentinel attempt exceeded its setup deadline")
                    }
                }
            }
            Err(last)
        },
    )
    .await;
    match result {
        Ok(Ok(connection)) => Ok(connection),
        Ok(Err(cause)) => Err(definitive.unwrap_or(cause)),
        Err(_) => Err(definitive
            .unwrap_or_else(|| error("TIMEOUT", "Sentinel discovery exceeded its setup deadline"))),
    }
}
