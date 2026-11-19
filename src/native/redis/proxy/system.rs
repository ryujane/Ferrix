//! Resolve the system's route for each new socket; never persist resolved endpoints.
use super::*;

#[cfg(any(target_os = "linux", test))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

fn unavailable() -> JsError {
    error(
        "SYSTEM_PROXY_UNAVAILABLE",
        "Could not read system proxy settings",
    )
}
fn unsupported() -> JsError {
    error(
        "SYSTEM_PROXY_UNSUPPORTED",
        "Unsupported system proxy configuration",
    )
}

pub(super) async fn resolve(host: &str, port: u16) -> Result<Option<RedisProxyOptions>, JsError> {
    #[cfg(target_os = "linux")]
    {
        linux::resolve(host, port).await
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let host = host.to_owned();
        tokio::task::spawn_blocking(move || {
            #[cfg(target_os = "macos")]
            {
                macos::resolve(&host, port)
            }
            #[cfg(target_os = "windows")]
            {
                windows::resolve(&host, port)
            }
        })
        .await
        .map_err(|_| unavailable())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (host, port);
        Err(unsupported())
    }
}

fn endpoint(kind: &str, host: String, port: u32) -> Result<RedisProxyOptions, JsError> {
    let proxy = RedisProxyOptions {
        kind: kind.into(),
        host,
        port,
        username: None,
        password: None,
    };
    proxy.validate().map_err(|_| unsupported())?;
    Ok(proxy)
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn from_uri(value: &str, default_kind: &str) -> Result<RedisProxyOptions, JsError> {
    let value = if value.contains("://") {
        value.to_owned()
    } else {
        format!("{default_kind}://{value}")
    };
    let parsed = url::Url::parse(&value).map_err(|_| unsupported())?;
    let kind = match parsed.scheme() {
        "http" => "http",
        "socks" | "socks5" | "socks5h" => "socks5",
        _ => return Err(unsupported()),
    };
    if !matches!(parsed.path(), "" | "/") || parsed.query().is_some() || parsed.fragment().is_some()
    {
        return Err(unsupported());
    }
    let host = parsed
        .host_str()
        .ok_or_else(unsupported)?
        .trim_matches(['[', ']'])
        .to_owned();
    let port = parsed
        .port()
        .unwrap_or(if kind == "http" { 80 } else { 1080 });
    let mut proxy = endpoint(kind, host, port.into())?;
    let decode = |value: &str| {
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .map(|s| s.into_owned())
            .map_err(|_| unsupported())
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        proxy.username = Some(decode(parsed.username())?);
        proxy.password = parsed.password().map(decode).transpose()?;
    }
    proxy.validate().map_err(|_| unsupported())?;
    Ok(proxy)
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn bypasses(host: &str, port: u16, rules: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    rules
        .split([',', ';', ' ', '\n'])
        .filter(|s| !s.is_empty())
        .any(|rule| {
            let rule = rule.to_ascii_lowercase();
            if rule == "<local>" {
                return !host.contains('.') && !host.contains(':');
            }
            if let Some((network, prefix)) = rule.rsplit_once('/') {
                if let (Ok(address), Ok(network), Ok(prefix)) = (
                    host.parse::<IpAddr>(),
                    network.parse::<IpAddr>(),
                    prefix.parse::<u32>(),
                ) {
                    return match (address, network) {
                        (IpAddr::V4(a), IpAddr::V4(n)) if prefix <= 32 => {
                            (u32::from(a) ^ u32::from(n))
                                .checked_shr(32 - prefix)
                                .unwrap_or(0)
                                == 0
                        }
                        (IpAddr::V6(a), IpAddr::V6(n)) if prefix <= 128 => {
                            (u128::from(a) ^ u128::from(n))
                                .checked_shr(128 - prefix)
                                .unwrap_or(0)
                                == 0
                        }
                        _ => false,
                    };
                }
                return false;
            }
            let (pattern, required_port) = if let Some(rest) = rule.strip_prefix('[') {
                if let Some((address, tail)) = rest.split_once(']') {
                    (address, tail.strip_prefix(':'))
                } else {
                    return false;
                }
            } else if rule.matches(':').count() == 1 {
                let (pattern, port) = rule.rsplit_once(':').unwrap();
                (pattern, Some(port))
            } else {
                (rule.as_str(), None)
            };
            if required_port.is_some_and(|p| p.parse::<u16>().ok() != Some(port)) {
                return false;
            }
            let pattern = pattern.trim_end_matches('.');
            if let Some(domain) = pattern.strip_prefix('.') {
                return host == domain || host.ends_with(&format!(".{domain}"));
            }
            wildcard(&host, pattern)
        })
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn wildcard(value: &str, pattern: &str) -> bool {
    // Do not resolve a hostname merely to evaluate exclusions.
    let (value, pattern) = (value.as_bytes(), pattern.as_bytes());
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while i < value.len() {
        if j < pattern.len() && (pattern[j] == b'?' || pattern[j] == value[i]) {
            i += 1;
            j += 1;
        } else if j < pattern.len() && pattern[j] == b'*' {
            star = Some(j);
            j += 1;
            retry = i;
        } else if let Some(s) = star {
            retry += 1;
            i = retry;
            j = s + 1;
        } else {
            return false;
        }
    }
    while j < pattern.len() && pattern[j] == b'*' {
        j += 1;
    }
    j == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proxy_uri_preserves_credentials_and_rejects_other_transports() {
        let proxy = from_uri("socks5h://user:p%40ss@[::1]:1080", "http").unwrap();
        assert_eq!(proxy.kind, "socks5");
        assert_eq!(proxy.host, "::1");
        assert_eq!(proxy.password.as_deref(), Some("p@ss"));
        assert!(from_uri("https://proxy:443", "http").is_err());
        assert!(from_uri("http://proxy:8080/injected", "http").is_err());
        assert!(from_uri("http://user@proxy:8080", "http").is_err());
        assert_eq!(from_uri("proxy:8080", "http").unwrap().port, 8080);
    }
    #[test]
    fn bypass_rules_cover_hosts_ports_wildcards_and_ip_ranges() {
        assert!(bypasses("redis.internal", 6379, ".internal"));
        assert!(!bypasses("notinternal", 6379, ".internal"));
        assert!(bypasses("cache.example.com", 6379, "*.example.com:6379"));
        assert!(!bypasses("cache.example.com", 6380, "*.example.com:6379"));
        assert!(bypasses("127.12.0.1", 6379, "127.0.0.0/8"));
        assert!(!bypasses("128.12.0.1", 6379, "127.0.0.0/8"));
        assert!(bypasses("::1", 6379, "[::1]:6379"));
        assert!(bypasses("fe80::1", 6379, "fe80::/10"));
        assert!(!bypasses("fe80::1", 6379, "fe80::/129"));
        assert!(bypasses("redis", 6379, "<local>"));
        assert!(bypasses("external.example", 6379, "*"));
        assert!(bypasses("192.0.2.1", 6379, "0.0.0.0/0"));
    }
    #[test]
    fn system_mode_does_not_require_or_validate_manual_fields() {
        let proxy = RedisProxyOptions {
            kind: "system".into(),
            host: String::new(),
            port: 0,
            username: Some("ignored".into()),
            password: None,
        };
        assert!(proxy.validate().is_ok());
    }
}
