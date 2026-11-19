//! Bounded SOCKS5 / HTTP CONNECT handshakes. No direct fallback or local target DNS.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::net::IpAddr;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use zeroize::Zeroizing;
mod system;

/// Explicit network proxy, applied to all Redis endpoints or the SSH gateway.
/// Destination hostnames are resolved by the proxy. Credentials are runtime inputs only.
#[derive(Clone, JsObject)]
pub struct RedisProxyOptions {
    /// `system`, `socks5` or `http` (HTTP CONNECT over a plain TCP proxy connection).
    /// System mode ignores the manual endpoint and credentials and resolves every connection.
    pub kind: String,
    pub host: String,
    pub port: u32,
    /// Omit both credentials for no proxy authentication.
    pub username: Option<String>,
    pub password: Option<String>,
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.is_ascii()
        && !host
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "/@?#[]\\".contains(c))
        && (!host.contains(':') || host.parse::<IpAddr>().is_ok())
}
impl RedisProxyOptions {
    pub(super) fn validate(&self) -> Result<(), JsError> {
        if self.kind == "system" {
            return Ok(());
        }
        if !matches!(self.kind.as_str(), "socks5" | "http")
            || !valid_host(&self.host)
            || !(1..=65535).contains(&self.port)
            || self.username.is_some() != self.password.is_some()
            || self.username.as_ref().is_some_and(|user| {
                user.is_empty()
                    || user.len() > 255
                    || user.chars().any(char::is_control)
                    || self.kind == "http" && user.contains(':')
            })
            || self
                .password
                .as_ref()
                .is_some_and(|password| password.is_empty() || password.len() > 255)
        {
            return Err(error(
                "PROXY_CONFIGURATION_INVALID",
                "Invalid network proxy endpoint or credentials",
            ));
        }
        Ok(())
    }
}
pub(super) fn is_terminal_error(cause: &JsError) -> bool {
    matches!(
        cause.code(),
        Some(
            "PROXY_CONFIGURATION_INVALID"
                | "PROXY_AUTHENTICATION_FAILED"
                | "PROXY_PROTOCOL_ERROR"
                | "SYSTEM_PROXY_UNAVAILABLE"
                | "SYSTEM_PROXY_UNSUPPORTED"
        )
    )
}
fn failed(_: std::io::Error) -> JsError {
    error(
        "PROXY_CONNECTION_FAILED",
        "Could not establish a network proxy tunnel",
    )
}
fn protocol() -> JsError {
    error(
        "PROXY_PROTOCOL_ERROR",
        "Network proxy returned an invalid or unsupported response",
    )
}
fn auth() -> JsError {
    error(
        "PROXY_AUTHENTICATION_FAILED",
        "Network proxy rejected authentication",
    )
}

/// The caller's setup deadline covers socket connection, authentication and tunneling.
pub(super) async fn connect(
    options: &RedisProxyOptions,
    host: &str,
    port: u16,
) -> Result<TcpStream, JsError> {
    options.validate()?;
    if !valid_host(host) || port == 0 {
        return Err(error(
            "PROXY_CONFIGURATION_INVALID",
            "Invalid proxy destination hostname or port",
        ));
    }
    let resolved;
    let options = if options.kind == "system" {
        resolved = system::resolve(host, port).await?;
        match &resolved {
            Some(proxy) => proxy,
            // Direct is allowed only when the system selects it, never after proxy failure.
            None => return TcpStream::connect((host, port)).await.map_err(failed),
        }
    } else {
        options
    };
    options.validate()?;
    let mut socket = TcpStream::connect((options.host.as_str(), options.port as u16))
        .await
        .map_err(failed)?;
    socket.set_nodelay(true).ok();
    match options.kind.as_str() {
        "socks5" => socks5(&mut socket, options, host, port).await?,
        "http" => http(&mut socket, options, host, port).await?,
        _ => unreachable!(),
    }
    Ok(socket)
}

async fn socks5(
    socket: &mut TcpStream,
    options: &RedisProxyOptions,
    host: &str,
    port: u16,
) -> Result<(), JsError> {
    let method = if options.username.is_some() { 2 } else { 0 };
    socket.write_all(&[5, 1, method]).await.map_err(failed)?;
    let mut answer = [0; 2];
    socket.read_exact(&mut answer).await.map_err(failed)?;
    if answer[0] != 5 {
        return Err(protocol());
    }
    if answer[1] != method {
        return Err(auth());
    }
    if let Some(user) = &options.username {
        let password = options.password.as_ref().unwrap();
        let mut request = Zeroizing::new(vec![1, user.len() as u8]);
        request.extend_from_slice(user.as_bytes());
        request.push(password.len() as u8);
        request.extend_from_slice(password.as_bytes());
        socket.write_all(&request).await.map_err(failed)?;
        socket.read_exact(&mut answer).await.map_err(failed)?;
        if answer[0] != 1 {
            return Err(protocol());
        }
        if answer[1] != 0 {
            return Err(auth());
        }
    }
    let mut request = vec![5, 1, 0];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            request.extend_from_slice(&[3, host.len() as u8]);
            request.extend_from_slice(host.as_bytes());
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    socket.write_all(&request).await.map_err(failed)?;
    let mut header = [0; 4];
    socket.read_exact(&mut header).await.map_err(failed)?;
    if header[0] != 5 || header[2] != 0 {
        return Err(protocol());
    }
    if header[1] != 0 {
        return Err(error(
            "PROXY_CONNECTION_FAILED",
            "Proxy could not reach the destination",
        ));
    }
    let remaining = match header[3] {
        1 => 6,
        4 => 18,
        3 => {
            let length = socket.read_u8().await.map_err(failed)? as usize;
            if length == 0 {
                return Err(protocol());
            }
            length + 2
        }
        _ => return Err(protocol()),
    };
    let mut address = vec![0; remaining];
    socket.read_exact(&mut address).await.map_err(failed)?;
    Ok(())
}

async fn http(
    socket: &mut TcpStream,
    options: &RedisProxyOptions,
    host: &str,
    port: u16,
) -> Result<(), JsError> {
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = Zeroizing::new(format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n"
    ));
    if let Some(user) = &options.username {
        let credentials =
            Zeroizing::new(format!("{user}:{}", options.password.as_deref().unwrap()));
        let encoded = Zeroizing::new(STANDARD.encode(credentials.as_bytes()));
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&encoded);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    socket.write_all(request.as_bytes()).await.map_err(failed)?;
    let mut total = 0;
    for _ in 0..4 {
        let mut response = Vec::new();
        // Read exactly the headers: SSH may send its banner immediately after them.
        while !response.ends_with(b"\r\n\r\n") {
            if total >= 8192 {
                return Err(protocol());
            }
            response.push(socket.read_u8().await.map_err(failed)?);
            total += 1;
        }
        let first = response
            .split(|byte| *byte == b'\n')
            .next()
            .ok_or_else(protocol)?;
        let line = std::str::from_utf8(first).map_err(|_| protocol())?;
        let mut parts = line.trim_end_matches('\r').split(' ');
        if !matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1")) {
            return Err(protocol());
        }
        let code = parts
            .next()
            .filter(|code| code.len() == 3 && code.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|code| code.parse::<u16>().ok())
            .ok_or_else(protocol)?;
        match code {
            200..=299 => return Ok(()),
            100..=199 => continue,
            407 => return Err(auth()),
            _ => {
                return Err(error(
                    "PROXY_CONNECTION_FAILED",
                    "HTTP proxy could not open the destination tunnel",
                ));
            }
        }
    }
    Err(protocol())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn options(kind: &str, port: u16) -> RedisProxyOptions {
        RedisProxyOptions {
            kind: kind.into(),
            host: "127.0.0.1".into(),
            port: port.into(),
            username: Some("user".into()),
            password: Some("secret".into()),
        }
    }

    #[test]
    fn rejects_invalid_endpoints_and_authentication_before_network_work() {
        let mut value = options("socks5", 1080);
        assert!(value.validate().is_ok());
        value.password = None;
        assert_eq!(
            value.validate().unwrap_err().code(),
            Some("PROXY_CONFIGURATION_INVALID")
        );
        value.password = Some("x".repeat(256));
        assert!(value.validate().is_err());
        value.password = Some("secret".into());
        value.kind = "http".into();
        value.username = Some("a:b".into());
        assert!(value.validate().is_err());
        value.username = Some("user".into());
        value.host = "proxy\r\nInjected: header".into();
        assert!(value.validate().is_err());
        assert!(valid_host("::1"));
        assert!(!valid_host("redis.example:6379"));
    }

    #[tokio::test]
    async fn socks5_authenticates_and_sends_the_hostname_without_local_dns() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let options = options("socks5", listener.local_addr().unwrap().port());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut greeting = [0; 3];
            stream.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [5, 1, 2]);
            stream.write_all(&[5, 2]).await.unwrap();
            let mut credentials = [0; 13];
            stream.read_exact(&mut credentials).await.unwrap();
            assert_eq!(&credentials, b"\x01\x04user\x06secret");
            stream.write_all(&[1, 0]).await.unwrap();
            let mut header = [0; 5];
            stream.read_exact(&mut header).await.unwrap();
            assert_eq!(&header[..4], &[5, 1, 0, 3]);
            let mut name = vec![0; header[4] as usize];
            stream.read_exact(&mut name).await.unwrap();
            assert_eq!(name, b"redis.internal.invalid");
            let mut port = [0; 2];
            stream.read_exact(&mut port).await.unwrap();
            assert_eq!(port, 6379u16.to_be_bytes());
            stream
                .write_all(b"\x05\x00\x00\x03\x01x\x00\x00tail")
                .await
                .unwrap();
        });
        let mut stream = connect(&options, "redis.internal.invalid", 6379)
            .await
            .unwrap();
        let mut tail = [0; 4];
        stream.read_exact(&mut tail).await.unwrap();
        assert_eq!(&tail, b"tail");
        server.await.unwrap();
    }

    async fn read_headers(stream: &mut TcpStream) -> String {
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            assert!(header.len() < 8192);
            header.push(stream.read_u8().await.unwrap());
        }
        String::from_utf8(header).unwrap()
    }

    #[tokio::test]
    async fn http_connect_preserves_tunneled_bytes_and_formats_ipv6_authority() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let options = options("http", listener.local_addr().unwrap().port());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_headers(&mut stream).await;
            assert!(request.starts_with("CONNECT [::1]:6379 HTTP/1.1\r\nHost: [::1]:6379\r\n"));
            assert!(request.contains(&format!(
                "Proxy-Authorization: Basic {}\r\n",
                STANDARD.encode("user:secret")
            )));
            stream
                .write_all(
                    b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 Connected\r\n\r\nSSH-2.0-test\r\n",
                )
                .await
                .unwrap();
        });
        let mut stream = connect(&options, "::1", 6379).await.unwrap();
        let mut banner = vec![0; b"SSH-2.0-test\r\n".len()];
        stream.read_exact(&mut banner).await.unwrap();
        assert_eq!(banner, b"SSH-2.0-test\r\n");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_rejection_and_oversized_headers_are_redacted_and_bounded() {
        for (response, expected) in [
            (
                b"HTTP/1.1 407 Proxy authentication required\r\nSecret: secret\r\n\r\n".to_vec(),
                "PROXY_AUTHENTICATION_FAILED",
            ),
            (vec![b'x'; 8193], "PROXY_PROTOCOL_ERROR"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let options = options("http", listener.local_addr().unwrap().port());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_headers(&mut stream).await;
                let _ = stream.write_all(&response).await;
            });
            let cause = connect(&options, "redis.internal.invalid", 6379)
                .await
                .unwrap_err();
            assert_eq!(cause.code(), Some(expected));
            assert!(!format!("{cause:?}").contains("secret"));
            server.await.unwrap();
        }
    }
}
